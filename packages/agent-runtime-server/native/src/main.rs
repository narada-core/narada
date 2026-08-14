mod http;
mod mcp;
mod native_runtime;
mod provider;

use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = if args.iter().any(|arg| arg == "--bridge-conformance") {
        bridge_conformance().map(|()| 0)
    } else if args.iter().any(|arg| arg == "--protocol-conformance") {
        protocol_conformance().map(|()| 0)
    } else {
        native_runtime::run(&args).map(|()| 0)
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("narada-agent-runtime-server-rust: {error}");
            std::process::exit(1);
        }
    }
}

fn write_record(record: &Value) -> Result<(), String> {
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, record)
        .map_err(|error| format!("stdout_encode_failed:{error}"))?;
    output
        .write_all(b"\n")
        .and_then(|()| output.flush())
        .map_err(|error| format!("stdout_write_failed:{error}"))
}

fn bridge_conformance() -> Result<(), String> {
    write_record(&json!({
        "schema":"narada.runtime_engine_rust_target.v1",
        "status":"ready",
        "runtime_engine_kind":"rust",
        "argv":["--bridge-conformance"]
    }))
}

fn protocol_conformance() -> Result<(), String> {
    write_record(&json!({
        "schema":"narada.runtime_engine_protocol_probe.v1",
        "event":"session_started",
        "runtime_engine_kind":"rust",
        "lifecycle_state":"ready"
    }))?;
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|error| format!("stdin_read_failed:{error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = serde_json::from_str(&line)
            .map_err(|error| format!("request_decode_failed:{error}"))?;
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        match request.get("method").and_then(Value::as_str) {
            Some("session.health") => write_record(&json!({
                "schema":"narada.runtime_engine_protocol_probe.v1", "event":"session_health",
                "runtime_engine_kind":"rust", "request_id":id, "status":"healthy", "lifecycle_state":"ready"
            }))?,
            Some("mcp.tools.list") => write_record(&json!({
                "schema":"narada.runtime_engine_protocol_probe.v1", "event":"mcp_tools",
                "runtime_engine_kind":"rust", "request_id":id, "tools":["probe"]
            }))?,
            Some("session.close") => {
                write_record(&json!({
                    "schema":"narada.runtime_engine_protocol_probe.v1", "event":"session_closed",
                    "runtime_engine_kind":"rust", "request_id":id, "lifecycle_state":"closed"
                }))?;
                return Ok(());
            }
            Some(method) => return Err(format!("protocol_method_unsupported:{method}")),
            None => return Err("protocol_method_required".to_string()),
        }
    }
    Ok(())
}
