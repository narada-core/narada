//! Native HTTP and WebSocket projections for the NARS runtime.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Sender, TryRecvError},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub type EventSubscribers = Arc<Mutex<Vec<Sender<Value>>>>;

#[derive(Debug)]
pub enum ControlRequest {
    Json(Value),
    Http {
        method: String,
        path: String,

        body: Vec<u8>,
        reply: Sender<HttpResponse>,
    },
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub reason: String,
    pub content_type: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub events: Vec<Value>,
}

impl HttpResponse {
    pub fn json(status: u16, payload: Value) -> Self {
        let body = format!("{}\n", compact(&payload)).into_bytes();
        Self {
            status,
            reason: reason_for_status(status),
            content_type: "application/json; charset=utf-8".to_string(),
            headers: BTreeMap::new(),
            body,
            events: Vec::new(),
        }
    }
}

pub struct HttpProjection {
    stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
    pub health_url: Option<String>,
    pub events_url: Option<String>,
    pub subscribers: EventSubscribers,
}

impl HttpProjection {
    pub fn start(
        health_enabled: bool,
        health_host: &str,
        health_port: u16,
        events_enabled: bool,
        events_host: &str,
        events_port: u16,
        health: Arc<Mutex<Value>>,
        _events: Arc<Mutex<Vec<Value>>>,
        control: Sender<ControlRequest>,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let subscribers: EventSubscribers = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();
        let mut health_url = None;
        let mut events_url = None;

        if health_enabled {
            let listener = TcpListener::bind((health_host, health_port))
                .map_err(|error| format!("health_projection_bind_failed:{error}"))?;
            listener
                .set_nonblocking(true)
                .map_err(|error| format!("health_projection_nonblocking_failed:{error}"))?;
            let bound_port = listener
                .local_addr()
                .map_err(|error| format!("health_projection_address_failed:{error}"))?
                .port();
            health_url = Some(format!("http://{health_host}:{bound_port}/health"));
            handles.push(spawn_health_listener(
                listener,
                Arc::clone(&stop),
                Arc::clone(&health),
                control.clone(),
            ));
        }

        if events_enabled {
            let listener = match TcpListener::bind((events_host, events_port)) {
                Ok(listener) => listener,
                Err(error) => {
                    stop.store(true, Ordering::SeqCst);
                    for handle in handles {
                        let _ = handle.join();
                    }
                    return Err(format!("events_projection_bind_failed:{error}"));
                }
            };
            listener
                .set_nonblocking(true)
                .map_err(|error| format!("events_projection_nonblocking_failed:{error}"))?;
            let bound_port = listener
                .local_addr()
                .map_err(|error| format!("events_projection_address_failed:{error}"))?
                .port();
            events_url = Some(format!("ws://{events_host}:{bound_port}/events"));
            handles.push(spawn_events_listener(
                listener,
                Arc::clone(&stop),
                control,
                Arc::clone(&subscribers),
            ));
        }

        Ok(Self {
            stop,
            handles,
            health_url,
            events_url,
            subscribers,
        })
    }

    pub fn close(self) {
        self.stop.store(true, Ordering::SeqCst);
        for handle in self.handles {
            let _ = handle.join();
        }
    }
}

fn spawn_health_listener(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    health: Arc<Mutex<Value>>,
    control: Sender<ControlRequest>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let stop_for_request = Arc::clone(&stop);
                    let health_for_request = Arc::clone(&health);
                    let control_for_request = control.clone();
                    thread::spawn(move || {
                        handle_http_connection(
                            stream,
                            stop_for_request,
                            health_for_request,
                            control_for_request,
                        );
                    });
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    })
}

fn spawn_events_listener(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    control: Sender<ControlRequest>,
    subscribers: EventSubscribers,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let stop_for_client = Arc::clone(&stop);
                    let control_for_client = control.clone();
                    let subscribers_for_client = Arc::clone(&subscribers);
                    thread::spawn(move || {
                        handle_events_connection(
                            stream,
                            stop_for_client,
                            control_for_client,
                            subscribers_for_client,
                        );
                    });
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    })
}

fn handle_http_connection(
    mut stream: TcpStream,
    stop: Arc<AtomicBool>,
    health: Arc<Mutex<Value>>,
    control: Sender<ControlRequest>,
) {
    let request = read_http_request(&mut stream);
    let path = request.path.as_deref().unwrap_or("/");
    if request.method.as_deref() == Some("GET") && path.split('?').next() == Some("/health") {
        let value = health
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| {
                json!({
                    "schema": "narada.nars.health.v1",
                    "status": "unhealthy",
                    "error": "health_snapshot_poisoned",
                })
            });
        let status = if value.get("status").and_then(Value::as_str) == Some("unhealthy") {
            503
        } else {
            200
        };
        write_http_response(
            &mut stream,
            HttpResponse {
                status,
                reason: reason_for_status(status),
                content_type: "application/json; charset=utf-8".to_string(),
                headers: BTreeMap::new(),
                body: format!("{}\n", compact(&value)).into_bytes(),
                events: Vec::new(),
            },
        );
        return;
    }

    if path.starts_with("/sessions/") {
        let (reply_tx, reply_rx) = mpsc::channel();
        let message = ControlRequest::Http {
            method: request.method.unwrap_or_default(),
            path: path.to_string(),

            body: request.body,
            reply: reply_tx,
        };
        if control.send(message).is_err() {
            write_http_response(
                &mut stream,
                HttpResponse::json(
                    503,
                    json!({
                        "schema": "narada.nars.artifact_error.v1",
                        "error": "runtime_closed",
                        "message": "Native runtime is closed.",
                    }),
                ),
            );
            return;
        }
        let response = reply_rx
            .recv_timeout(Duration::from_secs(30))
            .unwrap_or_else(|_| {
                HttpResponse::json(
                    503,
                    json!({
                        "schema": "narada.nars.artifact_error.v1",
                        "error": "artifact_request_timeout",
                        "message": "Native runtime did not answer the artifact request.",
                    }),
                )
            });
        write_http_response(&mut stream, response);
        return;
    }

    if stop.load(Ordering::SeqCst) {
        return;
    }
    write_http_response(
        &mut stream,
        HttpResponse::json(404, json!({"error": "not_found"})),
    );
}

fn handle_events_connection(
    mut stream: TcpStream,
    stop: Arc<AtomicBool>,
    control: Sender<ControlRequest>,
    subscribers: EventSubscribers,
) {
    let request = read_http_request(&mut stream);
    let path = request.path.as_deref().unwrap_or("/");
    if request.method.as_deref() != Some("GET") || path.split('?').next() != Some("/events") {
        write_http_response(
            &mut stream,
            HttpResponse::json(404, json!({"error": "not_found"})),
        );
        return;
    }
    let upgrade = request
        .headers
        .get("upgrade")
        .map(|value| value.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    if !upgrade {
        write_http_response(
            &mut stream,
            HttpResponse {
                status: 426,
                reason: "Upgrade Required".to_string(),
                content_type: "application/json; charset=utf-8".to_string(),
                headers: BTreeMap::new(),
                body: b"{\"error\":\"upgrade_required\",\"transport\":\"websocket\",\"path\":\"/events\"}\n".to_vec(),
                events: Vec::new(),
            },
        );
        return;
    }
    let Some(key) = request.headers.get("sec-websocket-key") else {
        write_http_response(
            &mut stream,
            HttpResponse::json(400, json!({"error": "websocket_key_required"})),
        );
        return;
    };
    let accept = websocket_accept(key);
    let handshake = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    if stream.write_all(handshake.as_bytes()).is_err() {
        return;
    }
    let _ = stream.set_nonblocking(true);

    let (event_tx, event_rx) = mpsc::channel::<Value>();
    if let Ok(mut clients) = subscribers.lock() {
        clients.push(event_tx);
    }
    if send_ws_json(&mut stream, &json!({"event": "websocket_connected"})).is_err() {
        return;
    }

    let mut reader = WebSocketReader::default();
    loop {
        loop {
            match event_rx.try_recv() {
                Ok(event) => {
                    if send_ws_json(&mut stream, &event).is_err() {
                        return;
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }

        match reader.read_frame(&mut stream) {
            Ok(Some(WebSocketFrame::Text(text))) => {
                if let Ok(request) = serde_json::from_str::<Value>(&text) {
                    if control.send(ControlRequest::Json(request)).is_err() {
                        return;
                    }
                } else if send_ws_json(
                    &mut stream,
                    &json!({
                        "event": "session_control_rejected",
                        "code": "invalid_json",
                        "error": "invalid_json",
                    }),
                )
                .is_err()
                {
                    return;
                }
            }
            Ok(Some(WebSocketFrame::Ping(payload))) => {
                if send_ws_frame(&mut stream, 0xA, &payload).is_err() {
                    return;
                }
            }
            Ok(Some(WebSocketFrame::Close(payload))) => {
                let _ = send_ws_frame(&mut stream, 0x8, &payload);
                return;
            }
            Ok(Some(WebSocketFrame::Pong)) => {}
            Ok(None) => {}
            Err(WebSocketReadError::WouldBlock) => {}
            Err(WebSocketReadError::Closed) => return,
            Err(WebSocketReadError::Other) => return,
        }
        thread::sleep(Duration::from_millis(10));
    }
}

struct HttpRequest {
    method: Option<String>,
    path: Option<String>,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> HttpRequest {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return parse_http_request(&buffer),
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                if let Some(index) = find_bytes(&buffer, b"\r\n\r\n") {
                    header_end = index + 4;
                    break;
                }
                if buffer.len() > 64 * 1024 {
                    return parse_http_request(&buffer);
                }
            }
            Err(_) => return parse_http_request(&buffer),
        }
    }
    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    if header_text.lines().any(|line| {
        line.split_once(':')
            .map(|(name, value)| {
                name.trim().eq_ignore_ascii_case("expect")
                    && value.trim().eq_ignore_ascii_case("100-continue")
            })
            .unwrap_or(false)
    }) {
        let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
        let _ = stream.flush();
    }
    let content_length = header_text
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim().eq_ignore_ascii_case("content-length"))
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    while buffer.len().saturating_sub(header_end) < content_length {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
        }
    }
    let mut request = parse_http_request(&buffer[..buffer.len().min(header_end + content_length)]);
    if request.body.len() > content_length {
        request.body.truncate(content_length);
    }
    request
}

fn parse_http_request(buffer: &[u8]) -> HttpRequest {
    let header_end = find_bytes(buffer, b"\r\n\r\n").unwrap_or(buffer.len());
    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.lines();
    let (method, path) = lines
        .next()
        .and_then(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?.to_string(), parts.next()?.to_string()))
        })
        .unwrap_or((String::new(), String::new()));
    let mut headers = BTreeMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    let body = if header_end < buffer.len() {
        buffer[(header_end + 4)..].to_vec()
    } else {
        Vec::new()
    };
    HttpRequest {
        method: (!method.is_empty()).then_some(method),
        path: (!path.is_empty()).then_some(path),
        headers,
        body,
    }
}

fn write_http_response(stream: &mut TcpStream, response: HttpResponse) {
    let mut headers = String::new();
    headers.push_str(&format!(
        "Content-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.content_type,
        response.body.len()
    ));
    for (name, value) in response.headers {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    let head = format!(
        "HTTP/1.1 {} {}\r\n{}\r\n",
        response.status, response.reason, headers
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&response.body);
    let _ = stream.flush();
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn reason_for_status(status: u16) -> String {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        426 => "Upgrade Required",
        503 => "Service Unavailable",
        _ => "Error",
    }
    .to_string()
}

#[derive(Default)]
struct WebSocketReader {
    buffer: Vec<u8>,
}

enum WebSocketFrame {
    Text(String),
    Ping(Vec<u8>),
    Pong,
    Close(Vec<u8>),
}

enum WebSocketReadError {
    WouldBlock,
    Closed,
    Other,
}

impl WebSocketReader {
    fn read_frame(
        &mut self,
        stream: &mut TcpStream,
    ) -> Result<Option<WebSocketFrame>, WebSocketReadError> {
        let mut chunk = [0_u8; 4096];
        match stream.read(&mut chunk) {
            Ok(0) => return Err(WebSocketReadError::Closed),
            Ok(read) => self.buffer.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if self.buffer.is_empty() {
                    return Err(WebSocketReadError::WouldBlock);
                }
            }
            Err(_) => return Err(WebSocketReadError::Other),
        }
        if self.buffer.len() < 2 {
            return Ok(None);
        }
        let first = self.buffer[0];
        let second = self.buffer[1];
        let opcode = first & 0x0F;
        let masked = second & 0x80 != 0;
        let mut length = (second & 0x7F) as usize;
        let mut offset = 2;
        if length == 126 {
            if self.buffer.len() < offset + 2 {
                return Ok(None);
            }
            length = u16::from_be_bytes([self.buffer[offset], self.buffer[offset + 1]]) as usize;
            offset += 2;
        } else if length == 127 {
            if self.buffer.len() < offset + 8 {
                return Ok(None);
            }
            let mut value = [0_u8; 8];
            value.copy_from_slice(&self.buffer[offset..offset + 8]);
            let length_u64 = u64::from_be_bytes(value);
            if length_u64 > 16 * 1024 * 1024 {
                return Err(WebSocketReadError::Other);
            }
            length = length_u64 as usize;
            offset += 8;
        }
        let mask_offset = if masked { 4 } else { 0 };
        if self.buffer.len() < offset + mask_offset + length {
            return Ok(None);
        }
        let mask = if masked {
            let mut value = [0_u8; 4];
            value.copy_from_slice(&self.buffer[offset..offset + 4]);
            offset += 4;
            Some(value)
        } else {
            None
        };
        let mut payload = self.buffer[offset..offset + length].to_vec();
        self.buffer.drain(..offset + length);
        if let Some(mask) = mask {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
        }
        let frame = match opcode {
            0x1 => WebSocketFrame::Text(
                String::from_utf8(payload).map_err(|_| WebSocketReadError::Other)?,
            ),
            0x8 => WebSocketFrame::Close(payload),
            0x9 => WebSocketFrame::Ping(payload),
            0xA => WebSocketFrame::Pong,
            _ => return Ok(None),
        };
        Ok(Some(frame))
    }
}

fn send_ws_json(stream: &mut TcpStream, value: &Value) -> Result<(), String> {
    let payload = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    send_ws_frame(stream, 0x1, &payload)
}

fn send_ws_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> Result<(), String> {
    let mut frame = Vec::with_capacity(payload.len() + 16);
    frame.push(0x80 | (opcode & 0x0F));
    if payload.len() < 126 {
        frame.push(payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    let mut written = 0;
    while written < frame.len() {
        match stream.write(&frame[written..]) {
            Ok(0) => return Err("websocket_write_closed".to_string()),
            Ok(count) => written += count,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    loop {
        match stream.flush() {
            Ok(()) => break,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn websocket_accept(key: &str) -> String {
    let mut value = key.trim().as_bytes().to_vec();
    value.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64_encode(&sha1_digest(&value))
}

fn sha1_digest(input: &[u8]) -> [u8; 20] {
    let mut message = input.to_vec();
    let bit_length = (message.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());
    let mut state = [
        0x67452301_u32,
        0xEFCDAB89_u32,
        0x98BADCFE_u32,
        0x10325476_u32,
        0xC3D2E1F0_u32,
    ];
    for chunk in message.chunks_exact(64) {
        let mut words = [0_u32; 80];
        for (index, word) in words[..16].iter_mut().enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = state;
        for (index, word) in words.iter().enumerate() {
            let (function, constant) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temporary = a
                .rotate_left(5)
                .wrapping_add(function)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temporary;
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
    }
    let mut digest = [0_u8; 20];
    for (index, word) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        let value = ((first as u32) << 16) | ((second as u32) << 8) | third as u32;
        output.push(TABLE[((value >> 18) & 0x3F) as usize] as char);
        output.push(TABLE[((value >> 12) & 0x3F) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(value & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    output
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let values = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    if values.len() % 4 != 0 {
        return Err("base64_invalid_length".to_string());
    }
    let value_of = |byte: u8| -> Result<u8, String> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("base64_invalid_character".to_string()),
        }
    };
    let mut output = Vec::new();
    for chunk in values.chunks(4) {
        let a = value_of(chunk[0])? as u32;
        let b = value_of(chunk[1])? as u32;
        let c = if chunk[2] == b'=' {
            0
        } else {
            value_of(chunk[2])? as u32
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            value_of(chunk[3])? as u32
        };
        let value = (a << 18) | (b << 12) | (c << 6) | d;
        output.push((value >> 16) as u8);
        if chunk[2] != b'=' {
            output.push((value >> 8) as u8);
        }
        if chunk[3] != b'=' {
            output.push(value as u8);
        }
    }
    Ok(output)
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

pub fn broadcast_event(subscribers: &EventSubscribers, event: &Value) {
    if let Ok(mut clients) = subscribers.lock() {
        clients.retain(|client| client.send(event.clone()).is_ok());
    }
}
