use crate::http::{
    base64_decode, broadcast_event, ControlRequest, EventSubscribers, HttpProjection, HttpResponse,
};
use crate::mcp::NativeMcpGateway;
use crate::provider::NativeProviderAdapter;
use narada_nars_session_authority::AuthorityBinding;
use narada_nars_session_core::{
    session_index, supervisor::SessionSupervisor, CoreError, SessionCore, SessionCoreConfig,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Map, Value};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const ORIENTATION_BOOTSTRAP_TURN_PREFIX: &str = "input_orientation_bootstrap_";
const ORIENTATION_BOOTSTRAP_PROMPT: &str = "This is the mandatory Carrier-entry orientation turn, not ordinary work. Use only the exposed orientation tools. Call agent_orientation_read({}) and follow each returned next_call exactly. Treat every continuation as opaque; never inspect or alter it. Do not begin, discuss, or perform the selected work in this turn. Stop only when status=ready and ordinary_work_gate=open, or report the exact orientation blocker.";

#[derive(Debug, Clone)]
pub struct NativeRuntimeConfig {
    pub identity: String,
    pub session_id: String,
    pub site_root: Option<PathBuf>,
    pub orientation_entry_file: Option<PathBuf>,
    pub orientation_required: Option<bool>,
    pub mcp_scope: String,
    pub health_enabled: bool,
    pub health_host: String,
    pub health_port: u16,
    pub events_enabled: bool,
    pub events_host: String,
    pub events_port: u16,
}

fn parse_orientation_required_signal(value: Option<&str>) -> Result<Option<bool>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "required" => Ok(Some(true)),
        "0" | "false" | "not_required" => Ok(Some(false)),
        _ => Err("orientation_required_signal_invalid".to_string()),
    }
}

impl NativeRuntimeConfig {
    pub fn from_args(args: &[String]) -> Result<Self, String> {
        let mut identity =
            env::var("NARADA_AGENT_ID").unwrap_or_else(|_| "narada-native".to_string());
        let mut session_id = env::var("NARADA_NARS_SESSION_ID")
            .or_else(|_| env::var("NARADA_RUNTIME_SESSION_ID"))
            .or_else(|_| env::var("NARADA_CARRIER_SESSION_ID"))
            .unwrap_or_default();
        let mut site_root = env::var("NARADA_SITE_ROOT").ok().map(PathBuf::from);
        let mut orientation_entry_file = env::var("NARADA_ORIENTATION_ENTRY_FILE")
            .ok()
            .map(PathBuf::from);
        let orientation_required_value = env::var("NARADA_ORIENTATION_REQUIRED").ok();
        let orientation_required =
            parse_orientation_required_signal(orientation_required_value.as_deref())?;
        let mut health_enabled = env::var("NARADA_AGENT_RUNTIME_HEALTH_ENABLED")
            .ok()
            .as_deref()
            != Some("0");
        let mut health_host = env::var("NARADA_AGENT_RUNTIME_HEALTH_HOST")
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        let mut health_port = env::var("NARADA_AGENT_RUNTIME_HEALTH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(0);
        let mut events_enabled = env::var("NARADA_AGENT_RUNTIME_EVENTS_ENABLED")
            .ok()
            .as_deref()
            != Some("0");
        let mut events_host = env::var("NARADA_AGENT_RUNTIME_EVENTS_HOST")
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        let mut events_port = env::var("NARADA_AGENT_RUNTIME_EVENTS_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(0);
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--identity" => {
                    index += 1;
                    identity = args
                        .get(index)
                        .cloned()
                        .ok_or_else(|| "identity_required".to_string())?;
                }
                "--session" => {
                    index += 1;
                    session_id = args
                        .get(index)
                        .cloned()
                        .ok_or_else(|| "session_required".to_string())?;
                }
                "--no-health" => health_enabled = false,
                "--health-host" => {
                    index += 1;
                    health_host = args
                        .get(index)
                        .cloned()
                        .ok_or_else(|| "health_host_required".to_string())?;
                }
                "--health-port" => {
                    index += 1;
                    health_port = args
                        .get(index)
                        .and_then(|value| value.parse::<u16>().ok())
                        .ok_or_else(|| "health_port_required".to_string())?;
                }
                "--no-events" => events_enabled = false,
                "--events-host" => {
                    index += 1;
                    events_host = args
                        .get(index)
                        .cloned()
                        .ok_or_else(|| "events_host_required".to_string())?;
                }
                "--events-port" => {
                    index += 1;
                    events_port = args
                        .get(index)
                        .and_then(|value| value.parse::<u16>().ok())
                        .ok_or_else(|| "events_port_required".to_string())?;
                }
                "--site-root" => {
                    index += 1;
                    site_root = Some(PathBuf::from(
                        args.get(index)
                            .cloned()
                            .ok_or_else(|| "site_root_required".to_string())?,
                    ));
                }
                "--orientation-entry-file" => {
                    index += 1;
                    orientation_entry_file =
                        Some(PathBuf::from(args.get(index).cloned().ok_or_else(
                            || "orientation_entry_file_required".to_string(),
                        )?));
                }
                value if value.starts_with("--identity=") => identity = value[11..].to_string(),
                value if value.starts_with("--session=") => session_id = value[10..].to_string(),
                value if value.starts_with("--site-root=") => {
                    site_root = Some(PathBuf::from(value[12..].to_string()))
                }
                value if value.starts_with("--orientation-entry-file=") => {
                    orientation_entry_file = Some(PathBuf::from(value[25..].to_string()))
                }
                _ => {}
            }
            index += 1;
        }
        let identity = identity.trim().to_string();
        let session_id = session_id.trim().to_string();
        if identity.is_empty() {
            return Err("identity_required".to_string());
        }
        if session_id.is_empty() {
            return Err("session_required".to_string());
        }
        Ok(Self {
            identity,
            session_id,
            site_root,
            orientation_entry_file,
            orientation_required,
            mcp_scope: normalize_mcp_scope(env::var("NARADA_MCP_SCOPE").ok().as_deref()),
            health_enabled,
            health_host,
            health_port,
            events_enabled,
            events_host,
            events_port,
        })
    }
}

fn normalize_mcp_scope(value: Option<&str>) -> String {
    let value = value.unwrap_or("none").trim().to_ascii_lowercase();
    if matches!(
        value.as_str(),
        "all" | "host" | "user-site" | "local-site" | "site"
    ) {
        value
    } else {
        "none".to_string()
    }
}

fn session_directory(site_root: Option<&Path>, session_id: &str) -> Option<PathBuf> {
    site_root.map(|root| {
        let narada = if root.file_name().and_then(|name| name.to_str()) == Some(".narada") {
            root.to_path_buf()
        } else {
            root.join(".narada")
        };
        narada.join("crew").join("nars-sessions").join(session_id)
    })
}

fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let seconds = millis.div_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let sod = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        sod / 3_600,
        (sod % 3_600) / 60,
        sod % 60,
        millis.rem_euclid(1_000)
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 }.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096).div_euclid(365);
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let day = doy - (153 * mp + 2).div_euclid(5) + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}
fn string_value(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}
fn request_id(request: &Value) -> Option<String> {
    request.as_object().and_then(|object| {
        object
            .get("id")
            .or_else(|| object.get("request_id"))
            .and_then(|value| string_value(Some(value)))
    })
}
fn request_method(request: &Value) -> Option<String> {
    request
        .as_object()
        .and_then(|object| string_value(object.get("method")))
}

fn request_params(request: &Value) -> Option<&Map<String, Value>> {
    request.get("params").and_then(Value::as_object)
}

fn request_content(request: &Value) -> Option<String> {
    let object = request.as_object()?;
    let params = request_params(request);
    object
        .get("content")
        .or_else(|| params.and_then(|params| params.get("content")))
        .or_else(|| params.and_then(|params| params.get("message")))
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Array(parts) => Some(
                parts
                    .iter()
                    .filter_map(|part| {
                        part.as_str().map(ToOwned::to_owned).or_else(|| {
                            part.as_object()
                                .and_then(|object| object.get("text"))
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned)
                        })
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
}

fn provider_content(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| provider_content(Some(part)))
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("artifact_ref") {
                let title = object
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!(" {value}"))
                    .unwrap_or_default();
                let kind = object
                    .get("kind")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!(" ({value})"))
                    .unwrap_or_default();
                let id = object
                    .get("artifact_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("unknown");
                return format!("[Artifact{title}{kind}; id={id}]");
            }
            object
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string()
        }
        _ => String::new(),
    }
}
fn map_event(event: &str) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert("event".to_string(), json!(event));
    object
}
fn put(object: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    object.insert(key.to_string(), value.into());
}
fn core_error(error: CoreError) -> String {
    error.0
}

fn subscription_page_size(value: Option<&Value>) -> Result<usize, String> {
    let Some(value) = value else {
        return Ok(100);
    };
    if value.is_null() {
        return Ok(100);
    }
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(value) => {
            let value = value.trim();
            if value.is_empty() {
                Some(0.0)
            } else if let Some(hex) = value
                .strip_prefix("0x")
                .or_else(|| value.strip_prefix("0X"))
            {
                u64::from_str_radix(hex, 16)
                    .ok()
                    .map(|number| number as f64)
            } else {
                value.parse::<f64>().ok()
            }
        }
        _ => None,
    };
    let Some(parsed) = parsed else {
        return Err("invalid_session_event_page_size".to_string());
    };
    if !parsed.is_finite() || parsed < 0.0 || parsed.fract() != 0.0 {
        return Err("invalid_session_event_page_size".to_string());
    }
    Ok((parsed as usize).min(1000))
}

fn sequence_as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
        .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()))
}

#[derive(Debug, Clone)]
struct RuntimeRequestRecord {
    runtime_request_id: String,
    request_id: Option<String>,
    method: Option<String>,
    state: String,
    terminal_state: Option<String>,
}

#[derive(Debug, Default)]
struct RuntimeRequestRegistry {
    next_request_number: u64,
    records: Vec<RuntimeRequestRecord>,
}

impl RuntimeRequestRegistry {
    fn receive(&mut self, request_id: Option<String>, method: Option<String>) -> String {
        self.next_request_number = self.next_request_number.saturating_add(1);
        let runtime_request_id = format!("runtime_request_{}", self.next_request_number);
        self.records.push(RuntimeRequestRecord {
            runtime_request_id: runtime_request_id.clone(),
            request_id,
            method,
            state: String::new(),
            terminal_state: None,
        });
        runtime_request_id
    }

    fn transition(&mut self, runtime_request_id: &str, next_state: &str) -> Option<Value> {
        let record = self
            .records
            .iter_mut()
            .find(|record| record.runtime_request_id == runtime_request_id)?;
        let previous_state = if record.state.is_empty() {
            Value::Null
        } else {
            json!(record.state)
        };
        record.state = next_state.to_string();
        record.terminal_state = match next_state {
            "completed" | "rejected" | "failed" => Some(next_state.to_string()),
            _ => None,
        };
        let event = json!({
            "schema": "narada.nars.runtime_request_state.v1",
            "event": "runtime_request_state_transition",
            "timestamp": now_iso(),
            "runtime_request_id": record.runtime_request_id,
            "request_id": record.request_id,
            "method": record.method,
            "previous_state": previous_state,
            "request_state": record.state,
            "terminal_state": record.terminal_state,
            "transport": "jsonl_stdio",
        });
        if record.terminal_state.is_some() {
            self.prune_terminal();
        }
        Some(event)
    }

    fn prune_terminal(&mut self) {
        let mut terminal_count = self
            .records
            .iter()
            .filter(|record| matches!(record.state.as_str(), "completed" | "rejected" | "failed"))
            .count();
        while terminal_count > 100 {
            let Some(index) = self.records.iter().position(|record| {
                matches!(record.state.as_str(), "completed" | "rejected" | "failed")
            }) else {
                break;
            };
            self.records.remove(index);
            terminal_count -= 1;
        }
    }
    fn snapshot(&self) -> Value {
        let state_names = [
            "received",
            "scheduled",
            "waiting",
            "running",
            "completed",
            "rejected",
            "failed",
        ];
        let mut state_counts = Map::new();
        for state in state_names {
            state_counts.insert(
                state.to_string(),
                json!(self
                    .records
                    .iter()
                    .filter(|record| record.state == state)
                    .count()),
            );
        }
        let active_count = self
            .records
            .iter()
            .filter(|record| !matches!(record.state.as_str(), "completed" | "rejected" | "failed"))
            .count();
        let terminal_count = self.records.len().saturating_sub(active_count);
        let active_records = self
            .records
            .iter()
            .filter(|record| !matches!(record.state.as_str(), "completed" | "rejected" | "failed"))
            .collect::<Vec<_>>();
        let active_start = active_records.len().saturating_sub(100);
        let mut refs = active_records[active_start..]
            .iter()
            .map(|record| {
                json!({
                    "runtime_request_id": record.runtime_request_id,
                    "request_id": record.request_id,
                    "method": record.method,
                    "request_state": record.state,
                    "terminal_state": record.terminal_state,
                })
            })
            .collect::<Vec<_>>();
        let terminal_capacity = 100usize.saturating_sub(refs.len());
        if terminal_capacity > 0 {
            let terminal_records = self
                .records
                .iter()
                .filter(|record| {
                    matches!(record.state.as_str(), "completed" | "rejected" | "failed")
                })
                .collect::<Vec<_>>();
            let terminal_start = terminal_records.len().saturating_sub(terminal_capacity);
            refs.extend(terminal_records[terminal_start..].iter().map(|record| {
                json!({
                    "runtime_request_id": record.runtime_request_id,
                    "request_id": record.request_id,
                    "method": record.method,
                    "request_state": record.state,
                    "terminal_state": record.terminal_state,
                })
            }));
        }
        json!({
            "schema": "narada.nars.runtime_request_state.v1",
            "request_count": self.records.len(),
            "retained_request_count": self.records.len(),
            "retention_limit": 100,
            "retention_scope": "terminal_requests_only",
            "active_request_count": active_count,
            "terminal_request_count": terminal_count,
            "pending_operation_count": 0,
            "state_counts": state_counts,
            "request_refs": refs,
        })
    }
}
#[derive(Debug)]
struct OrientationEntryGate {
    entry_file: PathBuf,
    db_path: PathBuf,
    brief: Value,
    delivery_receipt: Value,
    receipt_id: String,
}

impl OrientationEntryGate {
    fn from_config(config: &NativeRuntimeConfig) -> Result<Option<Self>, String> {
        if config.orientation_required == Some(true) && config.orientation_entry_file.is_none() {
            return Err("orientation_entry_packet_required".to_string());
        }
        if config.orientation_required == Some(false) && config.orientation_entry_file.is_some() {
            return Err("orientation_required_signal_conflict".to_string());
        }
        let Some(entry_file) = config.orientation_entry_file.as_ref() else {
            return Ok(None);
        };
        let site_root = config
            .site_root
            .as_ref()
            .ok_or_else(|| "orientation_entry_site_root_required".to_string())?;
        let admitted_root = site_root
            .join(".ai")
            .join("runtime")
            .join("orientation-entry");
        let admitted_root = admitted_root
            .canonicalize()
            .map_err(|error| format!("orientation_entry_root_unavailable:{error}"))?;
        let entry_file = entry_file
            .canonicalize()
            .map_err(|error| format!("orientation_entry_file_unavailable:{error}"))?;
        if !entry_file.starts_with(&admitted_root) {
            return Err(format!(
                "orientation_entry_file_outside_admitted_root:{}",
                entry_file.display()
            ));
        }
        let packet: Value = serde_json::from_str(
            &fs::read_to_string(&entry_file)
                .map_err(|error| format!("orientation_entry_file_read_failed:{error}"))?,
        )
        .map_err(|error| format!("orientation_entry_packet_invalid:{error}"))?;
        if packet.get("schema").and_then(Value::as_str)
            != Some("narada.carrier_entry.orientation_packet.v1")
            || packet.get("ordinary_work_gate").and_then(Value::as_str)
                != Some("acknowledgement_required")
        {
            return Err("orientation_entry_packet_invalid".to_string());
        }
        let brief = packet
            .get("orientation_brief")
            .cloned()
            .ok_or_else(|| "orientation_entry_brief_required".to_string())?;
        let delivery_receipt = packet
            .get("delivery_receipt")
            .cloned()
            .ok_or_else(|| "orientation_entry_delivery_receipt_required".to_string())?;
        if brief.get("schema").and_then(Value::as_str) != Some("narada.orientation_brief.v1")
            || delivery_receipt.get("schema").and_then(Value::as_str)
                != Some("narada.carrier_session.orientation_delivery_receipt.v1")
            || delivery_receipt.get("status").and_then(Value::as_str) != Some("delivered")
            || delivery_receipt
                .get("delivery_mode")
                .and_then(Value::as_str)
                != Some("carrier_entry_injection")
            || delivery_receipt
                .get("ordinary_work_gate")
                .and_then(Value::as_str)
                != Some("delivery_required")
            || delivery_receipt.get("coordinate") != brief.get("coordinate")
            || delivery_receipt.get("manifest_id") != brief.pointer("/manifest_ref/manifest_id")
            || delivery_receipt.get("manifest_digest")
                != brief.pointer("/manifest_ref/manifest_digest")
            || delivery_receipt.get("brief_id") != brief.get("brief_id")
            || delivery_receipt.get("brief_digest") != brief.get("brief_digest")
        {
            return Err("orientation_entry_delivery_binding_mismatch".to_string());
        }
        let admission: Value = serde_json::from_str(
            &env::var("NARADA_CARRIER_SESSION_ADMISSION_RECEIPT")
                .map_err(|_| "orientation_entry_admission_receipt_required".to_string())?,
        )
        .map_err(|error| format!("orientation_entry_admission_receipt_invalid:{error}"))?;
        if delivery_receipt.get("coordinate") != admission.get("coordinate")
            || delivery_receipt.get("admission_receipt_ref") != admission.get("receipt_id")
            || brief.get("admission_receipt_ref") != admission.get("receipt_id")
        {
            return Err("orientation_entry_admission_binding_mismatch".to_string());
        }
        let receipt_id = delivery_receipt
            .get("receipt_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "orientation_entry_delivery_receipt_id_required".to_string())?
            .to_string();
        let db_path = env::var("NARADA_AGENT_CONTEXT_DB")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                site_root
                    .join(".ai")
                    .join("state")
                    .join("agent-context.sqlite")
            });
        Ok(Some(Self {
            entry_file,
            db_path,
            brief,
            delivery_receipt,
            receipt_id,
        }))
    }

    fn provider_card_message(&self, include_entry_selections: bool) -> String {
        let brief = &self.brief;
        let role = brief
            .pointer("/role_binding/role")
            .or_else(|| brief.pointer("/role_binding/role_id"))
            .or_else(|| brief.pointer("/role_binding/binding/role"))
            .cloned()
            .unwrap_or(Value::Null);
        let entry_selection = |field: &str| -> Value {
            let selection = brief.get(field).unwrap_or(&Value::Null);
            if selection.get("mode").and_then(Value::as_str) == Some("exact") {
                json!({
                    "mode": "exact",
                    "snapshot_posture": "selected_at_carrier_entry_not_live_state",
                    "summary": selection.get("summary").cloned().unwrap_or(Value::Null),
                    "inspect": selection
                        .get("inspection_call")
                        .cloned()
                        .unwrap_or(Value::Null),
                })
            } else {
                json!({
                    "mode": "omitted",
                    "reason_code": selection
                        .get("reason_code")
                        .cloned()
                        .unwrap_or_else(|| Value::String("not_selected".to_string())),
                })
            }
        };
        let mut card = json!({
            "schema": "narada.orientation_context_card.v1",
            "projection_posture": "derived_from_exact_brief_not_independent_authority",
            "projection_mode": if include_entry_selections { "entry_handoff" } else { "recurring_position" },
            "orientation_status": "acknowledged_before_ordinary_turn",
            "position": {
                "local_agent_id": brief
                    .pointer("/agent_identity/local_agent_id")
                    .cloned()
                    .unwrap_or(Value::Null),
                "canonical_agent_id": brief
                    .pointer("/agent_identity/canonical_agent_id")
                    .cloned()
                    .unwrap_or(Value::Null),
                "site_ref": brief
                    .pointer("/coordinate/site_ref")
                    .cloned()
                    .unwrap_or(Value::Null),
                "carrier_kind": brief.get("carrier_kind").cloned().unwrap_or(Value::Null),
                "role": role,
            },
            "manifest_ref": brief.get("manifest_ref").cloned().unwrap_or(Value::Null),
            "residual_codes": brief.get("residual_codes").cloned().unwrap_or(Value::Null),
            "authority_posture": {
                "continuity": "historical_context_only",
                "selected_work": "entry_orientation_not_action_authority",
                "consequential_action": "owning_admission_still_required",
            },
        });
        if include_entry_selections {
            card["entry_snapshot_at"] = brief.get("generated_at").cloned().unwrap_or(Value::Null);
            card["continuity"] = entry_selection("continuity_selection");
            card["work"] = entry_selection("work_selection");
        } else {
            card["work_refresh"] = brief
                .get("work_selection")
                .filter(|selection| selection.get("mode").and_then(Value::as_str) == Some("exact"))
                .and_then(|selection| selection.get("inspection_call"))
                .cloned()
                .unwrap_or(Value::Null);
        }
        let prefix = if include_entry_selections {
            "Narada Orientation Entry Card. Identity and authority posture remain in force; continuity and work are entry snapshots, not live state."
        } else {
            "Narada Orientation Position Card. Refresh live work through work_refresh; entry summaries are intentionally omitted after handoff."
        };
        format!(
            "{} {}",
            prefix,
            serde_json::to_string(&card).unwrap_or_else(|_| "{}".to_string())
        )
    }

    fn blocked(&self, reason: &str) -> Value {
        json!({
            "schema": "narada.runtime.orientation_entry_gate.v1",
            "status": "blocked",
            "ordinary_work_gate": "acknowledgement_required",
            "reason": reason,
            "delivery_receipt_ref": self.receipt_id,
            "entry_file": self.entry_file,
        })
    }

    fn inspect(&self) -> Value {
        if !self.db_path.exists() {
            return self.blocked("agent_context_store_unavailable");
        }
        let connection =
            match Connection::open_with_flags(&self.db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
                Ok(connection) => connection,
                Err(_) => return self.blocked("agent_context_store_unavailable"),
            };
        let stored_delivery: Option<String> = match connection
            .query_row(
                "SELECT receipt_json FROM orientation_delivery_receipts WHERE receipt_id = ?1 LIMIT 1",
                params![self.receipt_id],
                |row| row.get(0),
            )
            .optional()
        {
            Ok(value) => value,
            Err(_) => return self.blocked("orientation_evidence_tables_unavailable"),
        };
        let Some(stored_delivery) = stored_delivery else {
            return self.blocked("orientation_delivery_not_admitted");
        };
        let stored_delivery: Value = match serde_json::from_str(&stored_delivery) {
            Ok(value) => value,
            Err(_) => return self.blocked("orientation_delivery_evidence_invalid"),
        };
        if stored_delivery != self.delivery_receipt {
            return self.blocked("orientation_delivery_evidence_mismatch");
        }
        let acknowledgement_json: Option<String> = match connection
            .query_row(
                "SELECT acknowledgement_json FROM orientation_acknowledgements WHERE delivery_receipt_ref = ?1 LIMIT 1",
                params![self.receipt_id],
                |row| row.get(0),
            )
            .optional()
        {
            Ok(value) => value,
            Err(_) => return self.blocked("orientation_evidence_tables_unavailable"),
        };
        let Some(acknowledgement_json) = acknowledgement_json else {
            return self.blocked("orientation_acknowledgement_required");
        };
        let acknowledgement: Value = match serde_json::from_str(&acknowledgement_json) {
            Ok(value) => value,
            Err(_) => return self.blocked("orientation_acknowledgement_invalid"),
        };
        if acknowledgement.get("schema").and_then(Value::as_str)
            != Some("narada.carrier_session.orientation_acknowledgement.v1")
            || acknowledgement.get("status").and_then(Value::as_str) != Some("acknowledged")
            || acknowledgement
                .get("delivery_receipt_ref")
                .and_then(Value::as_str)
                != Some(self.receipt_id.as_str())
            || acknowledgement.get("coordinate") != self.brief.get("coordinate")
            || acknowledgement.get("manifest_id") != self.brief.pointer("/manifest_ref/manifest_id")
            || acknowledgement.get("manifest_digest")
                != self.brief.pointer("/manifest_ref/manifest_digest")
            || acknowledgement.get("brief_id") != self.brief.get("brief_id")
            || acknowledgement.get("brief_digest") != self.brief.get("brief_digest")
            || acknowledgement
                .get("acknowledgement_semantics")
                .and_then(Value::as_str)
                != Some("receipt_and_required_reads_not_comprehension")
            || acknowledgement
                .get("action_admission")
                .and_then(Value::as_str)
                != Some("separate_required")
        {
            return self.blocked("orientation_acknowledgement_binding_mismatch");
        }
        json!({
            "schema": "narada.runtime.orientation_entry_gate.v1",
            "status": "open",
            "ordinary_work_gate": "open",
            "reason": "orientation_acknowledged",
            "delivery_receipt_ref": self.receipt_id,
            "acknowledgement_ref": acknowledgement.get("acknowledgement_id"),
            "acknowledgement_semantics": "receipt_and_required_reads_not_comprehension",
            "action_admission": "separate_required",
            "entry_file": self.entry_file,
        })
    }

    fn refusal(&self) -> Option<String> {
        let state = self.inspect();
        if state.get("ordinary_work_gate").and_then(Value::as_str) == Some("open") {
            return None;
        }
        Some(format!(
            "orientation_acknowledgement_required:{}",
            state
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ))
    }
}

pub struct NativeRuntime {
    config: NativeRuntimeConfig,
    supervisor: SessionSupervisor,
    session_dir: Option<PathBuf>,
    heartbeat_path: Option<PathBuf>,
    authority: Option<AuthorityBinding>,
    mcp_gateway: NativeMcpGateway,
    execution_policy: Value,
    intelligence_selection: Option<Value>,
    request_registry: RuntimeRequestRegistry,
    orientation_gate: Option<OrientationEntryGate>,
    orientation_bootstrap_attempt: u64,
    closed: bool,
}

impl NativeRuntime {
    pub fn new(config: NativeRuntimeConfig) -> Result<Self, String> {
        let session_dir = session_directory(config.site_root.as_deref(), &config.session_id);
        let events_path = session_dir
            .as_ref()
            .map(|path| path.join("events.jsonl"))
            .unwrap_or_else(|| {
                env::temp_dir()
                    .join("narada-native")
                    .join(format!("{}.events.jsonl", config.session_id))
            });
        let heartbeat_path = session_dir.as_ref().map(|path| path.join("heartbeat.json"));
        let core = SessionCore::new(SessionCoreConfig {
            session_id: config.session_id.clone(),
            agent_id: config.identity.clone(),
            session_path: session_dir.as_ref().map(|path| path.join("session.jsonl")),
            events_path,
            site_root: config.site_root.clone(),
            max_event_buffer: 1000,
        })
        .map_err(core_error)?;
        let site_id = env::var("NARADA_SITE_ID").ok();
        let authority = AuthorityBinding::from_environment(
            &config.session_id,
            site_id.as_deref(),
            &config.identity,
        )
        .map_err(|error| error.to_string())?;
        let mcp_gateway = NativeMcpGateway::new(config.site_root.as_deref(), &config.mcp_scope);
        let orientation_gate = OrientationEntryGate::from_config(&config)?;
        let execution_policy = json!({
            "schema": "narada.nars.execution_policy.v1",
            "scope": "session",
            "source": {"kind": "runtime-default", "ref": null, "revision": 1},
            "tool_loop": {"max_rounds": 200},
        });
        let runtime = Self {
            config,
            supervisor: SessionSupervisor::new(core),
            session_dir,
            heartbeat_path,
            authority,
            mcp_gateway,
            execution_policy,
            intelligence_selection: None,
            request_registry: RuntimeRequestRegistry::default(),
            orientation_gate,
            orientation_bootstrap_attempt: 0,
            closed: false,
        };
        runtime.write_session_projection(None)?;
        runtime.write_heartbeat("alive", "session_created")?;
        Ok(runtime)
    }

    fn recover_pending_after_orientation(&mut self) -> Result<Vec<Value>, String> {
        let mut adapter = NativeProviderAdapter::from_environment(
            self.config.site_root.clone(),
            &mut self.mcp_gateway,
        )
        .with_session_context(self.config.session_id.clone());
        self.supervisor
            .recover_with_adapter(&mut adapter)
            .map_err(core_error)
    }

    fn ensure_orientation_entry(&mut self, reason: &str) -> Result<Vec<Value>, String> {
        let Some(initial_state) = self
            .orientation_gate
            .as_ref()
            .map(OrientationEntryGate::inspect)
        else {
            return Ok(Vec::new());
        };
        if initial_state
            .get("ordinary_work_gate")
            .and_then(Value::as_str)
            == Some("open")
        {
            return self.recover_pending_after_orientation();
        }

        self.orientation_bootstrap_attempt += 1;
        let attempt = self.orientation_bootstrap_attempt;
        let turn_id = format!(
            "{ORIENTATION_BOOTSTRAP_TURN_PREFIX}{}_{}",
            self.config.session_id, attempt
        );
        let mut output = vec![self
            .supervisor
            .core_mut()
            .append_event(json!({
                "event": "orientation_bootstrap_started",
                "attempt": attempt,
                "reason": reason,
                "turn_id": turn_id,
                "delivery_receipt_ref": initial_state.get("delivery_receipt_ref"),
            }))
            .map_err(core_error)?];

        self.mcp_gateway.begin_orientation();
        let catalog = self.mcp_gateway.tool_catalog();
        let exposed = catalog
            .iter()
            .filter_map(|tool| tool.get("tool_name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        let missing = ["agent_orientation_read"]
            .into_iter()
            .filter(|required| !exposed.contains(required))
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            self.mcp_gateway.end_orientation();
            output.push(
                self.supervisor
                    .core_mut()
                    .append_event(json!({
                        "event": "orientation_bootstrap_unavailable",
                        "attempt": attempt,
                        "reason": "orientation_tools_missing",
                        "turn_id": turn_id,
                        "missing_tools": missing,
                        "exposed_tools": exposed,
                        "ordinary_work_gate": initial_state.get("ordinary_work_gate"),
                        "delivery_receipt_ref": initial_state.get("delivery_receipt_ref"),
                    }))
                    .map_err(core_error)?,
            );
            return Ok(output);
        }

        let mut input = json!({
            "event_id": turn_id,
            "request_id": format!("orientation-bootstrap-{attempt}"),
            "content": ORIENTATION_BOOTSTRAP_PROMPT,
            "source": "system_directive",
            "source_kind": "system",
            "source_id": "narada-agent-runtime-server",
            "transport": "carrier_server_api",
            "delivery_mode": "admit_for_current_turn",
            "authority_ref": format!("runtime:{}:orientation-entry", self.config.session_id),
            "directive_id": format!("orientation-entry:{}", self.config.session_id),
            "metadata": {
                "orientation_bootstrap": true,
                "orientation_delivery_receipt_ref": initial_state.get("delivery_receipt_ref"),
            },
        });
        self.enrich_provider_input(&mut input);
        let turn_result = {
            let mut adapter = NativeProviderAdapter::from_environment(
                self.config.site_root.clone(),
                &mut self.mcp_gateway,
            )
            .with_session_context(self.config.session_id.clone());
            self.supervisor
                .submit_front_system_with_adapter(input, &mut adapter)
                .map_err(core_error)
        };
        self.mcp_gateway.end_orientation();
        match turn_result {
            Ok(mut events) => output.append(&mut events),
            Err(error) => {
                output.push(
                    self.supervisor
                        .core_mut()
                        .append_event(json!({
                            "event": "orientation_bootstrap_failed",
                            "attempt": attempt,
                            "reason": reason,
                            "turn_id": turn_id,
                            "error": error,
                            "ordinary_work_gate": initial_state.get("ordinary_work_gate"),
                            "delivery_receipt_ref": initial_state.get("delivery_receipt_ref"),
                        }))
                        .map_err(core_error)?,
                );
                return Ok(output);
            }
        }

        let final_state = self
            .orientation_gate
            .as_ref()
            .map(OrientationEntryGate::inspect)
            .unwrap_or_else(|| json!({"ordinary_work_gate": "open"}));
        let opened = final_state
            .get("ordinary_work_gate")
            .and_then(Value::as_str)
            == Some("open");
        output.push(
            self.supervisor
                .core_mut()
                .append_event(json!({
                    "event": if opened {
                        "orientation_bootstrap_completed"
                    } else {
                        "orientation_bootstrap_incomplete"
                    },
                    "attempt": attempt,
                    "reason": reason,
                    "turn_id": turn_id,
                    "ordinary_work_gate": final_state.get("ordinary_work_gate"),
                    "gate_reason": final_state.get("reason"),
                    "delivery_receipt_ref": final_state.get("delivery_receipt_ref"),
                    "acknowledgement_ref": final_state.get("acknowledgement_ref"),
                }))
                .map_err(core_error)?,
        );
        if opened {
            output.extend(self.recover_pending_after_orientation()?);
        }
        Ok(output)
    }

    pub fn startup(&mut self) -> Result<Vec<Value>, String> {
        let gateway_events = self.mcp_gateway.start();
        let gateway_snapshot = self.mcp_gateway.snapshot();
        let mut event = map_event("session_started");
        put(&mut event, "runtime", "narada-agent-runtime-server");
        put(&mut event, "runtime_engine_kind", "rust");
        put(&mut event, "session_id", self.config.session_id.clone());
        put(
            &mut event,
            "carrier_session_id",
            self.config.session_id.clone(),
        );
        put(&mut event, "agent_id", self.config.identity.clone());
        put(&mut event, "site_id", env::var("NARADA_SITE_ID").ok());
        put(
            &mut event,
            "runtime_contract",
            "nars_session_core_control.v1",
        );
        put(&mut event, "session_core_implementation", "rust_native");
        put(
            &mut event,
            "session_authority_implementation",
            self.authority
                .as_ref()
                .map(|authority| authority.implementation())
                .unwrap_or("not_bound"),
        );
        if let Some(authority) = self.authority.as_ref() {
            put(&mut event, "source_write_admission", "active");
            put(&mut event, "authority_epoch", authority.authority_epoch());
            put(&mut event, "authority_runtime_id", authority.runtime_id());
        }
        put(
            &mut event,
            "provider_adapter_kind",
            env::var("NARADA_NATIVE_PROVIDER_MODE").unwrap_or_else(|_| "unavailable".to_string()),
        );
        put(&mut event, "delegated_to_node", false);
        put(&mut event, "runtime_origin", "local");
        put(&mut event, "authority_runtime_host", "local");
        put(&mut event, "transport", "jsonl_stdio");
        put(
            &mut event,
            "health_endpoint",
            env::var("NARADA_HEALTH_URL").ok(),
        );
        put(
            &mut event,
            "event_endpoint",
            env::var("NARADA_EVENT_STREAM_URL").ok(),
        );
        put(
            &mut event,
            "site_root",
            self.config
                .site_root
                .as_ref()
                .map(|value| value.to_string_lossy().to_string()),
        );
        put(
            &mut event,
            "control_path",
            self.session_dir
                .as_ref()
                .map(|value| value.join("control.jsonl").to_string_lossy().to_string()),
        );
        put(
            &mut event,
            "session_path",
            self.session_dir
                .as_ref()
                .map(|value| value.join("session.jsonl").to_string_lossy().to_string()),
        );
        put(
            &mut event,
            "events_path",
            self.session_dir
                .as_ref()
                .map(|value| value.join("events.jsonl").to_string_lossy().to_string()),
        );
        put(&mut event, "mcp_scope", self.config.mcp_scope.clone());
        put(
            &mut event,
            "mcp_server_count",
            json!(gateway_snapshot.server_count),
        );
        put(
            &mut event,
            "mcp_operational_state",
            gateway_snapshot.operational_state.clone(),
        );
        put(
            &mut event,
            "lifecycle_state",
            self.supervisor.core().lifecycle_state(),
        );
        let mut output = vec![self
            .supervisor
            .core_mut()
            .append_event(Value::Object(event))
            .map_err(core_error)?];
        output.extend(self.supervisor.start().map_err(core_error)?);
        for gateway_event in gateway_events {
            if let Value::Object(object) = gateway_event {
                output.push(
                    self.supervisor
                        .core_mut()
                        .append_event(Value::Object(object))
                        .map_err(core_error)?,
                );
            }
        }
        if let Some(authority) = self.authority.as_mut() {
            authority
                .activate(&now_iso(), Some(std::process::id() as i64))
                .map_err(|error| error.to_string())?;
        }
        if self.orientation_gate.is_some() {
            output.extend(self.ensure_orientation_entry("session_start")?);
        } else {
            let mut adapter = NativeProviderAdapter::from_environment(
                self.config.site_root.clone(),
                &mut self.mcp_gateway,
            )
            .with_session_context(self.config.session_id.clone());
            output.extend(
                self.supervisor
                    .recover_with_adapter(&mut adapter)
                    .map_err(core_error)?,
            );
        }
        self.write_session_projection(Some(&output[0]))?;
        self.write_heartbeat("alive", "session_started")?;
        Ok(output)
    }

    pub fn handle(&mut self, request: Value) -> Result<Vec<Value>, String> {
        let mut request = request;
        let method = request_method(&request)
            .or_else(|| request_content(&request).map(|_| "session.submit".to_string()));
        let request_id = request_id(&request);
        let runtime_request_id = self
            .request_registry
            .receive(request_id.clone(), method.clone());
        if let Some(object) = request.as_object_mut() {
            object.insert("runtime_request_id".to_string(), json!(runtime_request_id));
        }
        let persist_request_lifecycle = method.as_deref() != Some("session.health");
        let mut request_events = Vec::new();
        for state in ["received", "scheduled", "running"] {
            request_events.extend(self.append_runtime_request_transition(
                &runtime_request_id,
                state,
                persist_request_lifecycle,
            )?);
        }
        if let Some(authority) = self.authority.as_mut() {
            authority
                .heartbeat(&now_iso(), Some(std::process::id() as i64))
                .map_err(|error| error.to_string())?;
        }
        let mut terminal_transition_recorded = false;
        let result = match method.as_deref() {
            Some("runtime.intelligence.reconfigure") => {
                self.reconfigure_intelligence(request_id, &request)
            }
            Some("runtime.intelligence.reconfigure.cancel") => {
                self.cancel_intelligence_reconfigure(request_id, &request)
            }
            Some("runtime.execution_policy.reconfigure") => {
                self.reconfigure_execution_policy(request_id, &request)
            }
            Some("session.health") => Ok(vec![self.health(request_id)]),
            Some("session.recovery") => Ok(vec![self.recovery(request_id)]),
            Some("session.events.read") => match self.events_read(request_id.clone(), &request) {
                Ok(value) => Ok(vec![value]),
                Err(error) => self.reject(request_id, Some("session.events.read"), &error),
            },
            Some("session.events.subscribe") => {
                match self.events_subscribe(request_id.clone(), &request) {
                    Ok(values) => Ok(values),
                    Err(error) => self.reject(request_id, Some("session.events.subscribe"), &error),
                }
            }
            Some("session.cancel") => self.cancel(request_id),
            Some("session.close") => {
                request_events.extend(self.append_runtime_request_transition(
                    &runtime_request_id,
                    "completed",
                    true,
                )?);
                terminal_transition_recorded = true;
                self.close(request_id)
            }
            Some("session.command.execute") => self.command(request_id, &request),
            Some("session.submit") => self.submit(request_id, &request),
            _ => self.reject(request_id, method.as_deref(), "unsupported_session_control"),
        };
        match result {
            Ok(mut values) => {
                let terminal_state = if values.iter().any(|event| {
                    event.get("event").and_then(Value::as_str) == Some("session_control_rejected")
                }) {
                    "rejected"
                } else {
                    "completed"
                };
                if !terminal_transition_recorded {
                    request_events.extend(self.append_runtime_request_transition(
                        &runtime_request_id,
                        terminal_state,
                        persist_request_lifecycle || terminal_state != "completed",
                    )?);
                }
                request_events.append(&mut values);
                request_events.extend(self.poll_subscription_events());
                Ok(request_events)
            }
            Err(error) => {
                let _ = self.append_runtime_request_transition(&runtime_request_id, "failed", true);
                Err(error)
            }
        }
    }

    fn append_runtime_request_transition(
        &mut self,
        runtime_request_id: &str,
        state: &str,
        persist: bool,
    ) -> Result<Vec<Value>, String> {
        let Some(event) = self.request_registry.transition(runtime_request_id, state) else {
            return Ok(Vec::new());
        };
        if !persist || self.supervisor.core().lifecycle_state() == "closed" {
            return Ok(Vec::new());
        }
        Ok(vec![self
            .supervisor
            .core_mut()
            .append_event(event)
            .map_err(core_error)?])
    }
    fn append_runtime_event(
        &mut self,
        event: Value,
        output: &mut Vec<Value>,
    ) -> Result<(), String> {
        output.push(
            self.supervisor
                .core_mut()
                .append_event(event)
                .map_err(core_error)?,
        );
        Ok(())
    }

    fn runtime_is_busy(&self) -> bool {
        self.supervisor.active_turn_id().is_some() || self.supervisor.core().pending_count() > 0
    }

    fn reconfigure_intelligence(
        &mut self,
        request_id: Option<String>,
        request: &Value,
    ) -> Result<Vec<Value>, String> {
        let params = request_params(request).cloned().unwrap_or_default();
        let control_id = params
            .get("request_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(request_id.clone())
            .unwrap_or_else(|| new_id("reconfigure"));
        let provider = params.get("requested_inference_provider").cloned();
        let model = params.get("requested_model").cloned();
        let options = params
            .get("requested_options")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let valid_ref = |value: Option<&Value>, kind: &str, prefix: &str| -> bool {
            let Some(value) = value else {
                return false;
            };
            let Some(object) = value.as_object() else {
                return false;
            };
            object.get("kind").and_then(Value::as_str) == Some(kind)
                && object
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.starts_with(prefix))
        };
        let valid = valid_ref(
            provider.as_ref(),
            "inference-provider",
            "inference-provider:",
        ) && valid_ref(model.as_ref(), "model", "model:")
            && options.is_object()
            && params.get("provider").is_none()
            && params.get("thinking").is_none();
        let mut output = Vec::new();
        if !valid {
            self.append_runtime_event(
                json!({
                    "event": "runtime_intelligence_reconfiguration",
                    "request_id": control_id.clone(),
                    "terminal_state": "refused",
                    "reason": "target_not_admitted",
                    "active": Value::Null,
                }),
                &mut output,
            )?;
            return Ok(output);
        }
        if self.runtime_is_busy() {
            self.append_runtime_event(
                json!({
                    "event": "runtime_intelligence_reconfiguration",
                    "request_id": control_id.clone(),
                    "terminal_state": "refused",
                    "reason": "runtime_not_at_clean_turn_boundary",
                    "active_turn_id": self.supervisor.active_turn_id(),
                }),
                &mut output,
            )?;
            return Ok(output);
        }
        let mut previous: Option<&str> = None;
        for state in ["requested", "validating", "admitted", "switching", "active"] {
            self.append_runtime_event(
                json!({
                    "event": "intelligence_runtime_reconfiguration_state_transition",
                    "schema": "narada.nars.intelligence_runtime_reconfiguration_state.v1",
                    "request_id": control_id.clone(),
                    "previous_state": previous,
                    "reconfiguration_state": state,
                }),
                &mut output,
            )?;
            previous = Some(state);
        }
        let active = json!({
            "requestedInferenceProvider": provider,
            "requestedModel": model,
            "requestedOptions": options,
            "reconfiguration_state": "active",
        });
        self.intelligence_selection = Some(active.clone());
        self.append_runtime_event(
            json!({
                "event": "runtime_intelligence_reconfiguration",
                "request_id": control_id.clone(),
                "terminal_state": "active",
                "active": active,
                "reason": "native_runtime_selection_updated",
            }),
            &mut output,
        )?;
        Ok(output)
    }

    fn cancel_intelligence_reconfigure(
        &mut self,
        request_id: Option<String>,
        request: &Value,
    ) -> Result<Vec<Value>, String> {
        let params = request_params(request).cloned().unwrap_or_default();
        let target = params
            .get("target_request_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut output = Vec::new();
        self.append_runtime_event(
            json!({
                "event": "runtime_intelligence_reconfiguration_cancel",
                "request_id": request_id,
                "target_request_id": target,
                "accepted": false,
                "terminal_state": "refused",
                "reason": "reconfiguration_not_active",
            }),
            &mut output,
        )?;
        Ok(output)
    }

    fn reconfigure_execution_policy(
        &mut self,
        request_id: Option<String>,
        request: &Value,
    ) -> Result<Vec<Value>, String> {
        let params = request_params(request).cloned().unwrap_or_default();
        let Some(candidate) = params
            .get("execution_policy")
            .or_else(|| params.get("executionPolicy"))
        else {
            return self.reject(
                request_id,
                Some("runtime.execution_policy.reconfigure"),
                "execution_policy_required",
            );
        };
        let valid = candidate.get("schema").and_then(Value::as_str)
            == Some("narada.nars.execution_policy.v1")
            && candidate
                .get("tool_loop")
                .and_then(|value| value.get("max_rounds"))
                .and_then(Value::as_u64)
                .is_some_and(|rounds| (1..=500).contains(&rounds));
        if !valid {
            return self.reject(
                request_id,
                Some("runtime.execution_policy.reconfigure"),
                "execution_policy_invalid",
            );
        }
        let mut output = Vec::new();
        if self.runtime_is_busy() {
            self.append_runtime_event(
                json!({
                    "event": "runtime_execution_policy_reconfiguration",
                    "request_id": request_id,
                    "accepted": false,
                    "terminal_state": "rejected",
                    "reason": "runtime_not_at_clean_turn_boundary",
                    "active_turn_id": self.supervisor.active_turn_id(),
                }),
                &mut output,
            )?;
            return Ok(output);
        }
        self.execution_policy = candidate.clone();
        self.append_runtime_event(
            json!({
                "event": "runtime_execution_policy_reconfiguration",
                "request_id": request_id,
                "accepted": true,
                "terminal_state": "completed",
                "active": self.execution_policy.clone(),
                "reason": "execution_policy_updated_at_clean_turn_boundary",
            }),
            &mut output,
        )?;
        Ok(output)
    }
    fn intelligence_snapshot(&self) -> Value {
        let selection = self.intelligence_selection.clone().unwrap_or_else(|| {
            json!({
                "requestedInferenceProvider": Value::Null,
                "requestedModel": Value::Null,
                "requestedOptions": {},
            })
        });
        json!({
            "schema": "narada.nars.intelligence_runtime_snapshot.v1",
            "intelligence_kernel_kind": env::var("NARADA_INTELLIGENCE_KERNEL").unwrap_or_else(|_| "narada-native".to_string()),
            "requested_inference_provider": selection.get("requestedInferenceProvider").cloned().unwrap_or(Value::Null),
            "requested_model": selection.get("requestedModel").cloned().unwrap_or(Value::Null),
            "requested_options": selection.get("requestedOptions").cloned().unwrap_or_else(|| json!({})),
            "selection_choices": {"providers": []},
            "latest_reconfiguration": selection,
        })
    }
    fn health(&self, request_id: Option<String>) -> Value {
        let snapshot = self.mcp_gateway.snapshot();
        let mut value = self.supervisor.core().health(&snapshot.operational_state);
        if let Some(object) = value.as_object_mut() {
            object.insert("request_id".to_string(), json!(request_id));
            object.insert("runtime".to_string(), json!("narada-agent-runtime-server"));
            object.insert("runtime_engine_kind".to_string(), json!("rust"));
            object.insert(
                "session_core_implementation".to_string(),
                json!("rust_native"),
            );
            object.insert(
                "session_authority_implementation".to_string(),
                json!(self
                    .authority
                    .as_ref()
                    .map(|authority| authority.implementation())
                    .unwrap_or("not_bound")),
            );
            object.insert("agent_id".to_string(), json!(self.config.identity));
            object.insert("mcp_scope".to_string(), json!(self.config.mcp_scope));
            object.insert(
                "execution_policy".to_string(),
                self.execution_policy.clone(),
            );
            object.insert(
                "heartbeat".to_string(),
                heartbeat_projection(self.heartbeat_path.as_deref()),
            );
            object.insert(
                "runtime_requests".to_string(),
                self.request_registry.snapshot(),
            );
            object.insert(
                "orientation_entry".to_string(),
                self.orientation_gate
                    .as_ref()
                    .map(OrientationEntryGate::inspect)
                    .unwrap_or_else(|| {
                        json!({
                            "schema": "narada.runtime.orientation_entry_gate.v1",
                            "status": "not_required",
                            "ordinary_work_gate": "open",
                        })
                    }),
            );
            object.insert("intelligence".to_string(), self.intelligence_snapshot());
            object.insert(
                "mcp".to_string(),
                json!({
                    "operational_state": snapshot.operational_state,
                    "lifecycle_state": snapshot.lifecycle_state,
                    "scope": self.config.mcp_scope,
                    "server_count": snapshot.server_count,
                    "startup_failure_count": snapshot.startup_failure_count,
                    "startup_failures": self.mcp_gateway.startup_failures(),
                    "runtime_fault_count": self.mcp_gateway.runtime_faults().len(),
                    "active_execution_count": snapshot.active_execution_count,
                    "execution_count": snapshot.execution_count,
                    "runtime_faults": self.mcp_gateway.runtime_faults(),
                    "tool_count": self.mcp_gateway.tool_catalog().len(),
                    "tools": self.mcp_gateway.tool_catalog(),
                }),
            );
        }
        value
    }

    fn poll_subscription_events(&mut self) -> Vec<Value> {
        self.supervisor
            .core_mut()
            .poll_event_subscriptions()
            .into_iter()
            .map(|mut envelope| {
                if let Some(cursor) = envelope.get_mut("cursor").and_then(Value::as_object_mut) {
                    cursor.insert("namespace".to_string(), json!("durable"));
                }
                envelope
            })
            .collect()
    }

    fn recovery(&self, request_id: Option<String>) -> Value {
        let mut value = self.supervisor.recovery();
        if let Some(object) = value.as_object_mut() {
            object.insert("request_id".to_string(), json!(request_id));
            object.insert("runtime_engine_kind".to_string(), json!("rust"));
            object.insert(
                "session_core_implementation".to_string(),
                json!("rust_native"),
            );
            object.insert(
                "session_authority_implementation".to_string(),
                json!(self
                    .authority
                    .as_ref()
                    .map(|authority| authority.implementation())
                    .unwrap_or("not_bound")),
            );
        }
        value
    }

    fn events_read(&self, request_id: Option<String>, request: &Value) -> Result<Value, String> {
        let options = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if !options.is_object() {
            return Err("invalid_session_event_params".to_string());
        }
        let page = self
            .supervisor
            .core()
            .events_page_contract(&options)
            .map_err(core_error)?;
        let mut response = page;
        if let Some(object) = response.as_object_mut() {
            object.insert("event".to_string(), json!("session_events_read"));
            object.insert("request_id".to_string(), json!(request_id));
            object.insert("transport".to_string(), json!("jsonl_stdio"));
        }
        Ok(response)
    }

    fn events_subscribe(
        &mut self,
        request_id: Option<String>,
        request: &Value,
    ) -> Result<Vec<Value>, String> {
        let params = request_params(request).cloned().unwrap_or_default();
        let requested_view = params
            .get("view")
            .and_then(|value| match value {
                Value::String(value) => Some(value.clone()),
                Value::Number(value) => Some(value.to_string()),
                Value::Bool(value) => Some(value.to_string()),
                _ => None,
            })
            .unwrap_or_else(|| "raw".to_string());
        let view = requested_view.trim().to_ascii_lowercase();
        if !matches!(
            view.as_str(),
            "conversation" | "operations" | "diagnostics" | "raw"
        ) {
            return Err(format!("invalid_nars_session_event_view:{requested_view}"));
        }
        let page_size = subscription_page_size(
            params
                .get("page_size")
                .or_else(|| params.get("max_replay"))
                .or_else(|| params.get("limit")),
        )?;
        if let Some(include_replay) = params.get("include_replay") {
            if !include_replay.is_boolean() {
                return Err("invalid_session_event_include_replay".to_string());
            }
        }
        if let Some(filters) = params.get("filters") {
            if !filters.is_object() {
                return Err("invalid_session_event_filters".to_string());
            }
        }
        let subscription_id = match params.get("subscription_id") {
            Some(Value::String(value)) if !value.trim().is_empty() => value.clone(),
            Some(_) => return Err("invalid_session_event_subscription_id".to_string()),
            None => "runtime-jsonl".to_string(),
        };
        let include_replay = params
            .get("include_replay")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut filters = params
            .get("filters")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        filters.insert("view".to_string(), json!(view));
        self.supervisor
            .core_mut()
            .subscribe_events(Some(&subscription_id), Value::Object(filters.clone()));
        if include_replay {
            self.supervisor
                .core_mut()
                .begin_event_replay(&subscription_id, json!({ "source": "event_log" }))
                .map_err(core_error)?;
        } else {
            self.supervisor
                .core_mut()
                .mark_event_subscription_live(
                    &subscription_id,
                    json!({ "source": "subscription_without_replay" }),
                )
                .map_err(core_error)?;
        }
        let mut replay = Vec::new();
        let mut replay_count = 0usize;
        let mut event_count = 0usize;
        let mut has_more = false;
        let cursor = if include_replay {
            let mut options = Map::new();
            options.insert("view".to_string(), json!(view));
            options.insert("filters".to_string(), Value::Object(filters.clone()));
            options.insert("limit".to_string(), json!(page_size));
            options.insert(
                "direction".to_string(),
                json!(if params.get("since_sequence").is_some()
                    || params.get("since_timestamp").is_some()
                {
                    "forward"
                } else {
                    "backward"
                }),
            );
            if let Some(value) = params.get("since_sequence") {
                options.insert("after_sequence".to_string(), value.clone());
            }
            if let Some(value) = params.get("since_timestamp") {
                options.insert("since_timestamp".to_string(), value.clone());
            }
            let page = self
                .supervisor
                .core()
                .events_page_contract(&Value::Object(options))
                .map_err(core_error)?;
            replay = page
                .get("events")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            replay_count = replay.len();
            event_count = page
                .get("event_count")
                .and_then(Value::as_u64)
                .unwrap_or(replay_count as u64) as usize;
            has_more = page
                .get("has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut durable = page.get("cursor").cloned().unwrap_or_else(|| json!({}));
            if let Some(object) = durable.as_object_mut() {
                object.insert("namespace".to_string(), json!("durable"));
            }
            durable
        } else {
            json!({ "namespace": "durable", "last_sequence": Value::Null, "next_sequence": 1 })
        };
        let mut output = vec![json!({
            "schema": "narada.nars.events.subscription.v1",
            "event": "session_events_subscription_started",
            "request_id": request_id,
            "subscription_id": subscription_id,
            "transport": "jsonl_stdio",
            "view": view,
            "page_size": page_size,
            "replay_count": replay_count,
            "event_count": event_count,
            "has_more": has_more,
            "replay_source": if include_replay { "event_log" } else { "memory_event_hub" },
            "cursor": cursor,
            "filters": filters,
        })];
        for event in &replay {
            let sequence = event
                .get("event_sequence")
                .or_else(|| event.get("sequence"))
                .cloned()
                .unwrap_or(Value::Null);
            let next_sequence = sequence_as_u64(&sequence)
                .map(|sequence| json!(sequence.saturating_add(1)))
                .unwrap_or(Value::Null);
            output.push(json!({
                "schema": "narada.nars.events.envelope.v1",
                "event": "session_event",
                "subscription_id": subscription_id,
                "cursor": { "namespace": "durable", "sequence": sequence, "next_sequence": next_sequence },
                "payload": event,
            }));
        }
        output.push(json!({
            "schema": "narada.nars.events.subscription.v1",
            "event": "session_events_replay_completed",
            "request_id": request_id,
            "subscription_id": subscription_id,
            "transport": "jsonl_stdio",
            "view": view,
            "replay_count": replay_count,
            "has_more": has_more,
            "cursor": cursor,
        }));
        if include_replay {
            let replay_last_sequence = replay
                .last()
                .and_then(|event| {
                    event
                        .get("event_sequence")
                        .or_else(|| event.get("sequence"))
                })
                .cloned()
                .unwrap_or(Value::Null);
            self.supervisor
                .core_mut()
                .mark_event_subscription_live(
                    &subscription_id,
                    json!({
                        "source": "replay_complete",
                        "replay_last_sequence": replay_last_sequence,
                    }),
                )
                .map_err(core_error)?;
        }
        Ok(output)
    }

    fn provider_messages_for(&self, input: &Value) -> Vec<Value> {
        let current_id = input
            .get("event_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let orientation_bootstrap = input
            .pointer("/metadata/orientation_bootstrap")
            .and_then(Value::as_bool)
            == Some(true);
        if orientation_bootstrap {
            return input
                .get("content")
                .map(|content| provider_content(Some(content)))
                .filter(|content| !content.is_empty())
                .map(|content| vec![json!({ "role": "system", "content": content })])
                .unwrap_or_default();
        }
        let control = input
            .get("metadata")
            .and_then(|metadata| metadata.get("intelligence_invocation"));
        let current_only = control
            .and_then(|value| {
                if value.get("intent_id").is_some() {
                    return Some(true);
                }
                match value.get("mode").and_then(Value::as_str) {
                    Some("retry") | Some("resume") | Some("replay") => Some(true),
                    _ => None,
                }
            })
            .unwrap_or(false);
        let mut messages = Vec::new();
        let mut prior_ordinary_assistant = false;
        if !current_only {
            let page = self
                .supervisor
                .core()
                .events_page_contract(&json!({
                    "view": "raw",
                    "direction": "forward",
                    "after_sequence": 0,
                    "limit": 1000,
                }))
                .ok();
            if let Some(events) = page
                .as_ref()
                .and_then(|value| value.get("events"))
                .and_then(Value::as_array)
            {
                for event in events {
                    let kind = event
                        .get("event")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let event_id = event
                        .get("turn_id")
                        .or_else(|| event.get("input_event_id"))
                        .or_else(|| event.get("event_id"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if event_id.starts_with(ORIENTATION_BOOTSTRAP_TURN_PREFIX) {
                        continue;
                    }
                    if event_id == current_id {
                        continue;
                    }
                    if kind == "user_message" {
                        let content = provider_content(event.get("content"));
                        if !content.is_empty() {
                            messages.push(json!({ "role": "user", "content": content }));
                        }
                    } else if kind == "assistant_message" {
                        let content = provider_content(event.get("content"));
                        if !content.is_empty() {
                            prior_ordinary_assistant = true;
                            messages.push(json!({ "role": "assistant", "content": content }));
                        }
                    }
                }
            }
        }
        if let Some(content) = input.get("content") {
            let content = provider_content(Some(content));
            if !content.is_empty() {
                messages.push(json!({ "role": "user", "content": content }));
            }
        }
        if let Some(gate) = self.orientation_gate.as_ref() {
            messages.insert(0, json!({
                "role": "system",
                "content": gate.provider_card_message(current_only || !prior_ordinary_assistant),
            }));
        }
        messages
    }

    fn enrich_provider_input(&self, input: &mut Value) {
        let messages = self.provider_messages_for(input);
        input["provider_messages"] = Value::Array(messages);
        input["execution_policy"] = self.execution_policy.clone();
        if let Some(control) = input
            .get("metadata")
            .and_then(|metadata| metadata.get("intelligence_invocation"))
            .cloned()
        {
            let mut settings = Map::new();
            if let Some(value) = control.get("intent_id") {
                settings.insert("intentId".to_string(), value.clone());
            }
            if let Some(value) = control.get("operation_id") {
                settings.insert("operationId".to_string(), value.clone());
            }
            if let Some(value) = control.get("mode") {
                settings.insert("mode".to_string(), value.clone());
            }
            if let Some(value) = control.get("allow_replan") {
                settings.insert("allowReplan".to_string(), value.clone());
            }
            if let Some(value) = input.get("request_id") {
                settings.insert("requestId".to_string(), value.clone());
            }
            if let Some(value) = input
                .get("runtime_request_id")
                .or_else(|| input.get("runtimeRequestId"))
            {
                settings.insert("runtimeRequestId".to_string(), value.clone());
            }
            if let Some(value) = input
                .get("idempotency_key")
                .or_else(|| input.get("idempotencyKey"))
            {
                settings.insert("idempotencyKey".to_string(), value.clone());
            }
            if let Some(value) = input
                .get("turn_attempt")
                .or_else(|| input.get("turnAttempt"))
            {
                settings.insert("turnAttempt".to_string(), value.clone());
            }
            input["provider_settings"] = Value::Object(settings);
        }
    }
    fn submit(
        &mut self,
        request_id: Option<String>,
        request: &Value,
    ) -> Result<Vec<Value>, String> {
        if self.closed {
            return self.reject(request_id, Some("session.submit"), "nars_session_closed");
        }
        let mut output = Vec::new();
        if self.orientation_gate.is_some() {
            let orientation_refusal = self
                .orientation_gate
                .as_ref()
                .and_then(OrientationEntryGate::refusal);
            if orientation_refusal.is_some() {
                output.extend(self.ensure_orientation_entry("before_session_submit")?);
            }
            if let Some(reason) = self
                .orientation_gate
                .as_ref()
                .and_then(OrientationEntryGate::refusal)
            {
                output.extend(self.reject(request_id, Some("session.submit"), &reason)?);
                return Ok(output);
            }
        }
        let content = request_content(request)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "content_required".to_string())?;
        let input_id = request_id.clone().unwrap_or_else(|| new_id("input"));
        let mut accepted = map_event("session_control_accepted");
        put(&mut accepted, "request_id", request_id.clone());
        put(&mut accepted, "method", "session.submit");
        put(&mut accepted, "acceptance_state", "accepted");
        put(&mut accepted, "transport", "jsonl_stdio");
        let accepted = self
            .supervisor
            .core_mut()
            .append_event(Value::Object(accepted))
            .map_err(core_error)?;
        let mut input = json!({ "event_id": input_id, "request_id": request_id, "content": content, "source": "manual_operator", "source_kind": "operator", "transport": "jsonl_stdio", "delivery_mode": "immediate" });
        if let Some(params) = request_params(request) {
            // Keep the public input-event identity and admission metadata when
            // a carrier adapter forwards an already-shaped input.  The older
            // path only copied a few session.submit fields, which caused the
            // native authority to silently replace event ids and delivery
            // semantics with runtime defaults.
            for key in [
                "event_id",
                "request_id",
                "source",
                "source_kind",
                "source_id",
                "transport",
                "delivery_mode",
                "created_at",
                "received_at",
                "idempotency_key",
                "hold_condition",
                "authority_ref",
                "directive_id",
                "metadata",
                "input_ref",
                "authority_posture",
            ] {
                if let Some(value) = params.get(key) {
                    input[key] = value.clone();
                }
            }
        }
        for key in [
            "runtime_request_id",
            "runtimeRequestId",
            "idempotency_key",
            "idempotencyKey",
            "turn_attempt",
            "turnAttempt",
        ] {
            if let Some(value) = request.get(key) {
                input[key] = value.clone();
            }
        }
        self.enrich_provider_input(&mut input);
        let mut adapter = NativeProviderAdapter::from_environment(
            self.config.site_root.clone(),
            &mut self.mcp_gateway,
        )
        .with_session_context(self.config.session_id.clone());
        output.push(accepted);
        output.extend(
            self.supervisor
                .submit_with_adapter(input, &mut adapter)
                .map_err(core_error)?,
        );
        let terminal_state = output
            .iter()
            .rev()
            .find_map(|event| {
                event
                    .get("terminal_state")
                    .and_then(Value::as_str)
                    .or_else(|| event.get("terminal_status").and_then(Value::as_str))
            })
            .unwrap_or("blocked")
            .to_string();
        let mut response = map_event("session_control_response");
        put(&mut response, "request_id", request_id);
        put(&mut response, "method", "session.submit");
        put(&mut response, "terminal_state", terminal_state.clone());
        put(
            &mut response,
            "request_outcome",
            if terminal_state == "completed" {
                "completed"
            } else {
                "turn_blocked"
            },
        );
        output.push(
            self.supervisor
                .core_mut()
                .append_event(Value::Object(response))
                .map_err(core_error)?,
        );
        self.write_heartbeat("alive", "session_submit")?;
        self.write_session_projection(None)?;
        Ok(output)
    }

    fn command(
        &mut self,
        request_id: Option<String>,
        request: &Value,
    ) -> Result<Vec<Value>, String> {
        let params = request_params(request).cloned().unwrap_or_default();
        let command = params
            .get("command")
            .or_else(|| request.get("command"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let value = params
            .get("value")
            .or_else(|| request.get("value"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let input = if value.is_empty() {
            command.clone()
        } else if command.is_empty() {
            value.clone()
        } else {
            format!("{command} {value}")
        }
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
        let (command_name, primary, argument, summary) = if input == "/help" || input == "help" {
            ("help", "/help", "", "Show commands")
        } else if input == "/status" || input == "status" {
            ("status", "/status", "", "")
        } else if input == "/goal" || input.starts_with("/goal ") {
            (
                "goal",
                "/goal",
                input.strip_prefix("/goal").unwrap_or("").trim(),
                "Show, set, pause, resume, or clear carrier session goal",
            )
        } else if input == "/stats" || input.starts_with("/stats ") {
            (
                "stats",
                "/stats",
                input.strip_prefix("/stats").unwrap_or("").trim(),
                "Show NARS session activity statistics",
            )
        } else if input == "/model" || input.starts_with("/model ") {
            (
                "model",
                "/model",
                input.strip_prefix("/model").unwrap_or("").trim(),
                "Set model for later turns",
            )
        } else if input == "/thinking" || input.starts_with("/thinking ") {
            (
                "thinking",
                "/thinking",
                input.strip_prefix("/thinking").unwrap_or("").trim(),
                "Set thinking level for later turns",
            )
        } else if input == "/tool-output"
            || input.starts_with("/tool-output ")
            || input == "/tool-outputs"
            || input.starts_with("/tool-outputs ")
        {
            (
                "tool_output",
                "/tool-output",
                input
                    .strip_prefix("/tool-output")
                    .or_else(|| input.strip_prefix("/tool-outputs"))
                    .unwrap_or("")
                    .trim(),
                "Toggle displayed tool call outputs",
            )
        } else if input == "/tools"
            || input.starts_with("/tools ")
            || input == "/tool"
            || input.starts_with("/tool ")
        {
            (
                "tools",
                "/tools",
                input
                    .strip_prefix("/tools")
                    .or_else(|| input.strip_prefix("/tool"))
                    .unwrap_or("")
                    .trim(),
                "Show discovered MCP tools and input schemas",
            )
        } else if input == "/observers" || input.starts_with("/observers ") {
            (
                "observers",
                "/observers",
                input.strip_prefix("/observers").unwrap_or("").trim(),
                "Show observer posture",
            )
        } else if input == "/observer mute" {
            (
                "observer_mute",
                "/observer mute",
                "",
                "Mute visible observer interjections",
            )
        } else if input == "/observer unmute" {
            (
                "observer_unmute",
                "/observer unmute",
                "",
                "Unmute visible observer interjections",
            )
        } else if input == "/queue" {
            ("queue_show", "/queue", "", "Show queued carrier input")
        } else if input == "/queue clear" {
            (
                "queue_clear",
                "/queue clear",
                "",
                "Clear queued operator input",
            )
        } else if input.starts_with("/queue drop ") {
            (
                "queue_drop",
                "/queue drop <index>",
                input.strip_prefix("/queue drop").unwrap_or("").trim(),
                "Drop one queued operator input item",
            )
        } else if input == "/clear" {
            ("clear", "/clear", "", "Clear terminal display")
        } else if input == "/exit" || input == "/quit" || input == "exit" {
            ("exit", "/exit", "", "Save and quit")
        } else {
            return self.reject(
                request_id,
                Some("session.command.execute"),
                "unsupported_session_command",
            );
        };
        let mut accepted = map_event("session_control_accepted");
        put(&mut accepted, "request_id", request_id.clone());
        put(&mut accepted, "method", "session.command.execute");
        put(&mut accepted, "command", command.clone());
        put(&mut accepted, "value", value.clone());
        put(&mut accepted, "acceptance_state", "accepted");
        put(&mut accepted, "transport", "jsonl_stdio");
        let mut result = vec![self
            .supervisor
            .core_mut()
            .append_event(Value::Object(accepted))
            .map_err(core_error)?];
        let mut command_result = map_event("command_result");
        put(&mut command_result, "request_id", request_id.clone());
        put(&mut command_result, "command", primary);
        put(&mut command_result, "value", argument);
        put(&mut command_result, "command_name", command_name);
        put(&mut command_result, "status", "ok");
        put(
            &mut command_result,
            "summary",
            if command_name == "status" {
                format!("session {}", self.supervisor.core().lifecycle_state())
            } else {
                summary.to_string()
            },
        );
        put(&mut command_result, "terminal_state", "completed");
        if command_name == "status" {
            put(
                &mut command_result,
                "health",
                self.health(request_id.clone()),
            );
        } else if command_name == "tools" {
            put(
                &mut command_result,
                "tools",
                self.mcp_gateway.tool_catalog(),
            );
        } else if command_name == "help" {
            put(
                &mut command_result,
                "commands",
                json!([
                    "/help",
                    "/status",
                    "/goal",
                    "/stats",
                    "/model",
                    "/thinking",
                    "/tool-output",
                    "/tools",
                    "/observers",
                    "/queue",
                    "/clear",
                    "/exit"
                ]),
            );
        }
        result.push(
            self.supervisor
                .core_mut()
                .append_event(json!({
                    "event": "carrier_command_executed",
                    "request_id": request_id.clone(),
                    "method": "session.command.execute",
                    "command": primary,
                    "value": argument,
                    "command_name": command_name,
                    "status": "ok",
                    "summary": command_result["summary"],
                    "terminal_state": "completed",
                }))
                .map_err(core_error)?,
        );
        result.push(
            self.supervisor
                .core_mut()
                .append_event(Value::Object(command_result))
                .map_err(core_error)?,
        );
        let mut response = map_event("session_control_response");
        put(&mut response, "request_id", request_id);
        put(&mut response, "method", "session.command.execute");
        put(&mut response, "terminal_state", "completed");
        result.push(
            self.supervisor
                .core_mut()
                .append_event(Value::Object(response))
                .map_err(core_error)?,
        );
        Ok(result)
    }
    fn artifact_http(&mut self, method: &str, path: &str, body: &[u8]) -> HttpResponse {
        let clean_path = path.split('?').next().unwrap_or(path);
        let segments = clean_path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(percent_decode)
            .collect::<Result<Vec<_>, _>>();
        let Ok(segments) = segments else {
            return artifact_error_response(400, "invalid_artifact_path");
        };
        if segments.len() < 3
            || segments[0] != "sessions"
            || segments[2] != "artifacts"
            || segments.len() > 5
        {
            return artifact_error_response(404, "artifact_route_not_found");
        }
        if segments[1] != self.config.session_id {
            return HttpResponse::json(
                404,
                json!({
                    "schema": "narada.nars.artifact_error.v1",
                    "error": "session_not_found",
                    "message": "Artifact session does not match this NARS runtime.",
                }),
            );
        }
        let artifact_id = segments.get(3).cloned();
        let suffix = segments.get(4).map(String::as_str);
        let parsed = serde_json::from_slice::<Value>(body).unwrap_or_else(|_| json!({}));
        let result = match (method, artifact_id.as_deref(), suffix) {
            ("POST", None, None) => {
                let mut options = parsed.as_object().cloned().unwrap_or_default();
                if !options.contains_key("source_path") {
                    if let Some(path) = options.get("path").cloned() {
                        options.insert("source_path".to_string(), path);
                    }
                }
                self.supervisor
                    .core_mut()
                    .register_artifact(Value::Object(options))
                    .map(|registered| {
                        let mut response = HttpResponse::json(
                            201,
                            json!({
                                "schema": "narada.nars.artifact_registered.v1",
                                "artifact": registered.get("public_record"),
                                "idempotent_replay": registered.get("idempotent_replay"),
                            }),
                        );
                        if let Some(event) = registered.get("event") {
                            response.events.push(event.clone());
                        }
                        response
                    })
            }
            ("PATCH", Some(id), None) => {
                let next_state = parsed
                    .get("lifecycle_state")
                    .or_else(|| parsed.get("state"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if next_state.trim().is_empty() {
                    Err(CoreError("artifact_lifecycle_state_required".to_string()))
                } else {
                    self.supervisor
                        .core_mut()
                        .transition_artifact(
                            id,
                            next_state,
                            json!({
                                "reason": parsed.get("reason"),
                                "requested_by": parsed.get("requested_by"),
                            }),
                        )
                        .map(|transition| {
                            let mut response = HttpResponse::json(
                                200,
                                json!({
                                    "schema": "narada.nars.artifact_lifecycle_transition.v1",
                                    "changed": transition.get("changed"),
                                    "previous_state": transition
                                        .get("previous_record")
                                        .and_then(|value| value.get("lifecycle"))
                                        .and_then(|value| value.get("state")),
                                    "artifact_state": transition
                                        .get("record")
                                        .and_then(|value| value.get("lifecycle"))
                                        .and_then(|value| value.get("state")),
                                    "artifact": transition.get("public_record"),
                                }),
                            );
                            if let Some(event) = transition.get("event") {
                                response.events.push(event.clone());
                            }
                            response
                        })
                }
            }
            ("POST", Some(id), Some("message")) => {
                let artifact = match self.public_artifact(id) {
                    Ok(value) => value,
                    Err(error) => return artifact_error_response(error_status(&error.0), &error.0),
                };
                let message_part = artifact_message_part(&artifact, &parsed);
                let text = parsed
                    .get("text")
                    .or_else(|| parsed.get("message"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        format!(
                            "Artifact ready: {}",
                            message_part
                                .get("title")
                                .and_then(Value::as_str)
                                .or_else(|| message_part.get("artifact_id").and_then(Value::as_str))
                                .unwrap_or("Artifact")
                        )
                    });
                let request_id = parsed
                    .get("request_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        message_part
                            .get("artifact_id")
                            .and_then(Value::as_str)
                            .unwrap_or("artifact_present")
                    });
                let event = json!({
                    "event": "assistant_message",
                    "event_family": "turn",
                    "agent_id": self.config.identity,
                    "agent_identity_ref": Value::Null,
                    "session_id": self.config.session_id,
                    "request_id": request_id,
                    "timestamp": now_iso(),
                    "source": "nars_artifact_presentation",
                    "content": [{ "type": "text", "text": text }, message_part.clone()],
                    "artifact_id": message_part.get("artifact_id"),
                });
                if let Some(existing) = self.supervisor.core().event_by_request_id(request_id) {
                    let same = existing.get("source").and_then(Value::as_str)
                        == Some("nars_artifact_presentation")
                        && existing.get("artifact_id") == event.get("artifact_id")
                        && existing.get("content") == event.get("content");
                    if !same {
                        return artifact_error_response(
                            409,
                            "artifact_presentation_idempotency_conflict",
                        );
                    }
                    return HttpResponse::json(
                        200,
                        json!({"schema":"narada.nars.artifact_message_presented.v1","status":"presented","artifact":artifact,"event":existing,"message_part":message_part,"idempotent_replay":true}),
                    );
                }
                self.supervisor
                    .core_mut()
                    .append_event(event)
                    .map(|published| {
                        let event_for_subscribers = published.clone();
                        let mut response = HttpResponse::json(
                            201,
                            json!({
                                "schema": "narada.nars.artifact_message_presented.v1",
                                "status": "presented",
                                "artifact": artifact,
                                "event": published,
                                "message_part": message_part,
                                "idempotent_replay":false,
                            }),
                        );
                        response.events.push(event_for_subscribers);
                        response
                    })
            }
            ("GET", None, None) => self
                .supervisor
                .core()
                .artifact_index()
                .map(|value| HttpResponse::json(200, value)),
            ("GET", Some(id), None) => self.public_artifact(id).map(|artifact| {
                HttpResponse::json(
                    200,
                    json!({
                        "schema": "narada.nars.artifact_read.v1",
                        "artifact": artifact,
                    }),
                )
            }),
            ("GET", Some(id), Some("content")) => {
                match self.supervisor.core().read_artifact_content(id) {
                    Ok(content) => {
                        let bytes = content
                            .get("content_base64")
                            .and_then(Value::as_str)
                            .ok_or_else(|| CoreError("artifact_content_missing".to_string()))
                            .and_then(|value| base64_decode(value).map_err(CoreError));
                        match bytes {
                            Ok(bytes) => {
                                let content_type = content
                                    .get("content_type")
                                    .and_then(Value::as_str)
                                    .unwrap_or("application/octet-stream")
                                    .to_string();
                                let mut headers = std::collections::BTreeMap::new();
                                if let Some(object) =
                                    content.get("headers").and_then(Value::as_object)
                                {
                                    for (name, value) in object {
                                        if let Some(value) = value.as_str() {
                                            headers.insert(name.clone(), value.to_string());
                                        }
                                    }
                                }
                                Ok(HttpResponse {
                                    status: 200,
                                    reason: "OK".to_string(),
                                    content_type,
                                    headers,
                                    body: bytes,
                                    events: Vec::new(),
                                })
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Err(error) => Err(error),
                }
            }
            _ => Err(CoreError("method_not_allowed".to_string())),
        };
        match result {
            Ok(response) => response,
            Err(error) => artifact_error_response(error_status(&error.0), &error.0),
        }
    }

    fn public_artifact(&self, artifact_id: &str) -> Result<Value, CoreError> {
        let index = self.supervisor.core().artifact_index()?;
        let record = index
            .get("artifacts")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("artifact_id").and_then(Value::as_str) == Some(artifact_id)
                })
            })
            .ok_or_else(|| CoreError("artifact_not_found".to_string()))?;
        Ok(narada_nars_session_core::artifacts::public_record(record))
    }
    fn cancel(&mut self, request_id: Option<String>) -> Result<Vec<Value>, String> {
        let mut output = self
            .supervisor
            .cancel(json!({ "request_id": request_id.clone() }))
            .map_err(core_error)?;
        let cancelled = output
            .iter()
            .rev()
            .find(|event| event["event"] == "session_cancel")
            .and_then(|event| event.get("cancelled"))
            .cloned()
            .unwrap_or(Value::Bool(false));
        output.push(json!({
            "event": "session_cancel",
            "request_id": request_id,
            "cancelled": cancelled,
        }));
        Ok(output)
    }

    fn close(&mut self, request_id: Option<String>) -> Result<Vec<Value>, String> {
        if self.closed {
            return Ok(vec![
                json!({ "event": "session_closed", "request_id": request_id, "terminal_state": "closed" }),
            ]);
        }
        let mut output = Vec::new();
        let mut accepted = map_event("session_control_accepted");
        put(&mut accepted, "request_id", request_id.clone());
        put(&mut accepted, "method", "session.close");
        put(&mut accepted, "acceptance_state", "accepted");
        output.push(
            self.supervisor
                .core_mut()
                .append_event(Value::Object(accepted))
                .map_err(core_error)?,
        );
        let mut response = map_event("session_control_response");
        put(&mut response, "request_id", request_id.clone());
        put(&mut response, "method", "session.close");
        put(&mut response, "terminal_state", "completed");
        output.push(
            self.supervisor
                .core_mut()
                .append_event(Value::Object(response))
                .map_err(core_error)?,
        );
        output.extend(
            self.supervisor
                .close_with_evidence(
                    "control_request",
                    json!({ "request_id": request_id.clone() }),
                )
                .map_err(core_error)?,
        );
        for gateway_event in self.mcp_gateway.close() {
            if let Value::Object(object) = gateway_event {
                output.push(
                    self.supervisor
                        .core_mut()
                        .append_event(Value::Object(object))
                        .map_err(core_error)?,
                );
            }
        }
        self.closed = true;
        self.write_session_projection(None)?;
        self.write_heartbeat("stopped", "session_closed")?;
        if let Some(authority) = self.authority.as_mut() {
            authority
                .close(&now_iso(), "control_request")
                .map_err(|error| error.to_string())?;
        }
        Ok(output)
    }

    fn reject(
        &mut self,
        request_id: Option<String>,
        method: Option<&str>,
        error: &str,
    ) -> Result<Vec<Value>, String> {
        if self.closed {
            return Ok(vec![
                json!({ "event": "session_control_rejected", "request_id": request_id, "method": method, "code": error, "error": error }),
            ]);
        }
        let mut event = map_event("session_control_rejected");
        put(&mut event, "request_id", request_id);
        put(&mut event, "method", method);
        put(&mut event, "code", error);
        put(&mut event, "error", error);
        Ok(vec![self
            .supervisor
            .core_mut()
            .append_event(Value::Object(event))
            .map_err(core_error)?])
    }

    fn write_heartbeat(&self, status: &str, reason: &str) -> Result<(), String> {
        let Some(path) = self.heartbeat_path.as_ref() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("runtime_directory_create_failed:{error}"))?;
        }
        let temporary = path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let mut file = File::create(&temporary)
            .map_err(|error| format!("runtime_heartbeat_open_failed:{error}"))?;
        serde_json::to_writer(&mut file, &json!({ "schema": "narada.nars.heartbeat.v1", "session_id": self.config.session_id, "agent_id": self.config.identity, "runtime": "narada-agent-runtime-server", "runtime_engine_kind": "rust", "pid": std::process::id(), "status": status, "heartbeat_at": now_iso(), "reason": reason })).map_err(|error| format!("runtime_heartbeat_encode_failed:{error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("runtime_heartbeat_write_failed:{error}"))?;
        file.flush()
            .map_err(|error| format!("runtime_heartbeat_flush_failed:{error}"))?;
        drop(file);
        if path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("runtime_heartbeat_replace_failed:{error}"))?;
        }
        fs::rename(temporary, path)
            .map_err(|error| format!("runtime_heartbeat_rename_failed:{error}"))
    }

    fn write_session_projection(&self, session_started: Option<&Value>) -> Result<(), String> {
        let Some(directory) = self.session_dir.as_ref() else {
            return Ok(());
        };
        fs::create_dir_all(directory)
            .map_err(|error| format!("session_projection_directory_failed:{error}"))?;
        let session_path = directory.join("session.jsonl");
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&session_path)
            .map_err(|error| format!("session_projection_open_failed:{error}"))?;
        if let Some(started) = session_started {
            session_index::write_started(
                started,
                Some(&session_path),
                self.config.site_root.as_deref(),
            )
            .map_err(core_error)?;
        }
        if self.supervisor.core().lifecycle_state() == "closed" {
            session_index::mark_closed(
                Some(&session_path),
                "closed",
                Some("session_closed"),
                self.config.site_root.as_deref(),
            )
            .map_err(core_error)?;
        }
        Ok(())
    }
}

fn artifact_error_response(status: u16, error: &str) -> HttpResponse {
    HttpResponse::json(
        status,
        json!({
            "schema": "narada.nars.artifact_error.v1",
            "error": error,
            "message": error,
            "details": Value::Null,
        }),
    )
}

fn error_status(error: &str) -> u16 {
    if error == "artifact_not_found"
        || error == "artifact_content_missing"
        || error == "session_not_found"
    {
        404
    } else if error == "artifact_path_outside_admitted_roots" {
        403
    } else if error.starts_with("invalid_nars_artifact_lifecycle_transition") {
        409
    } else if error == "method_not_allowed" {
        405
    } else if error == "session_core_unavailable" {
        503
    } else {
        400
    }
}

fn heartbeat_projection(path: Option<&Path>) -> Value {
    let Some(path) = path else {
        return json!({"path": null, "last_written_at": null, "age_ms": null, "freshness": "missing"});
    };
    let path_value = path.to_string_lossy().to_string();
    let Ok(contents) = fs::read_to_string(path) else {
        return json!({"path": path_value, "last_written_at": null, "age_ms": null, "freshness": "missing", "freshness_threshold_ms": 30000});
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return json!({"path": path_value, "last_written_at": null, "age_ms": null, "freshness": "unknown", "freshness_threshold_ms": 30000});
    };
    let last_written_at = value
        .get("last_written_at")
        .or_else(|| value.get("timestamp"))
        .or_else(|| value.get("heartbeat_at"))
        .cloned()
        .unwrap_or(Value::Null);
    let age_ms = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .map(|elapsed| elapsed.as_millis());
    let freshness = match age_ms {
        Some(age) if age <= 30_000 => "fresh",
        Some(_) => "stale",
        None => "unknown",
    };
    json!({
        "path": path_value,
        "last_written_at": last_written_at,
        "age_ms": age_ms,
        "freshness": freshness,
        "freshness_threshold_ms": 30000,
    })
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("invalid_percent_encoding".to_string());
            }
            let high = hex_digit(bytes[index + 1])?;
            let low = hex_digit(bytes[index + 2])?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| "invalid_utf8_path".to_string())
}

fn hex_digit(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("invalid_percent_encoding".to_string()),
    }
}

fn artifact_message_part(artifact: &Value, params: &Value) -> Value {
    let mut part = Map::new();
    part.insert("type".to_string(), json!("artifact_ref"));
    part.insert(
        "artifact_id".to_string(),
        artifact.get("artifact_id").cloned().unwrap_or(Value::Null),
    );
    for (key, artifact_key) in [("kind", "kind"), ("title", "title")] {
        let value = artifact
            .get(artifact_key)
            .cloned()
            .or_else(|| params.get(key).cloned());
        if let Some(value) = value {
            if !value.is_null() {
                part.insert(key.to_string(), value);
            }
        }
    }
    part.insert(
        "render_hint".to_string(),
        params
            .get("render_hint")
            .cloned()
            .or_else(|| artifact.get("render_hint").cloned())
            .unwrap_or_else(|| json!("inline")),
    );
    Value::Object(part)
}
fn dispatch_request<W: Write>(
    runtime: &mut NativeRuntime,
    raw_line: String,
    output: &mut std::io::BufWriter<W>,
    health_snapshot: &Arc<Mutex<Value>>,
    event_log: &Arc<Mutex<Vec<Value>>>,
    subscribers: &EventSubscribers,
) -> Result<(), String> {
    if raw_line.trim().is_empty() {
        return Ok(());
    }
    let request = match serde_json::from_str::<Value>(&raw_line) {
        Ok(value) => value,
        Err(_) => {
            let mut event = map_event("session_control_rejected");
            put(&mut event, "code", "invalid_json");
            put(&mut event, "error", "invalid_json");
            Value::Object(event)
        }
    };
    let events = if request.get("event").and_then(Value::as_str) == Some("session_control_rejected")
    {
        runtime.reject(None, None, "invalid_json")?
    } else {
        runtime.handle(request)?
    };
    publish_native_events(events, output, event_log, subscribers)?;
    if let Ok(mut value) = health_snapshot.lock() {
        *value = runtime.health(None);
    }
    Ok(())
}

fn publish_native_events<W: Write>(
    events: Vec<Value>,
    output: &mut std::io::BufWriter<W>,
    event_log: &Arc<Mutex<Vec<Value>>>,
    subscribers: &EventSubscribers,
) -> Result<(), String> {
    if let Ok(mut log) = event_log.lock() {
        log.extend(events.iter().cloned());
    }
    for event in events {
        serde_json::to_writer(&mut *output, &event)
            .map_err(|error| format!("stdout_encode_failed:{error}"))?;
        output
            .write_all(b"\n")
            .map_err(|error| format!("stdout_write_failed:{error}"))?;
        broadcast_event(subscribers, &event);
    }
    output
        .flush()
        .map_err(|error| format!("stdout_flush_failed:{error}"))?;
    Ok(())
}

pub fn run(args: &[String]) -> Result<(), String> {
    let config = NativeRuntimeConfig::from_args(args)?;
    let health_snapshot = Arc::new(Mutex::new(Value::Null));
    let event_log = Arc::new(Mutex::new(Vec::new()));
    let (control_tx, control_rx) = mpsc::channel::<ControlRequest>();
    let projection = HttpProjection::start(
        config.health_enabled,
        &config.health_host,
        config.health_port,
        config.events_enabled,
        &config.events_host,
        config.events_port,
        Arc::clone(&health_snapshot),
        Arc::clone(&event_log),
        control_tx,
    )?;
    if let Some(url) = projection.health_url.as_ref() {
        env::set_var("NARADA_HEALTH_URL", url);
    }
    if let Some(url) = projection.events_url.as_ref() {
        env::set_var("NARADA_EVENT_STREAM_URL", url);
        env::set_var("NARADA_WEBSOCKET_URL", url);
    }

    let mut runtime = NativeRuntime::new(config.clone())?;
    if let Ok(mut value) = health_snapshot.lock() {
        *value = runtime.health(None);
    }
    let mut output = std::io::BufWriter::new(std::io::stdout().lock());
    publish_native_events(
        runtime.startup()?,
        &mut output,
        &event_log,
        &projection.subscribers,
    )?;
    if let Ok(mut value) = health_snapshot.lock() {
        *value = runtime.health(None);
    }

    let (stdin_tx, stdin_rx) = mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            if stdin_tx
                .send(line.map_err(|error| format!("stdin_read_failed:{error}")))
                .is_err()
            {
                break;
            }
        }
    });
    let mut stdin_closed = false;
    let heartbeat_interval = env::var("NARADA_RUNTIME_HEARTBEAT_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(10_000));
    let mut last_heartbeat = Instant::now();
    loop {
        if heartbeat_interval > Duration::ZERO && last_heartbeat.elapsed() >= heartbeat_interval {
            let _ = runtime.write_heartbeat("alive", "runtime_heartbeat");
            if let Some(authority) = runtime.authority.as_mut() {
                let _ = authority.heartbeat(&now_iso(), Some(std::process::id() as i64));
            }
            if let Ok(mut value) = health_snapshot.lock() {
                *value = runtime.health(None);
            }
            last_heartbeat = Instant::now();
        }
        while let Ok(control_request) = control_rx.try_recv() {
            match control_request {
                ControlRequest::Json(request) => {
                    dispatch_request(
                        &mut runtime,
                        serde_json::to_string(&request).map_err(|error| error.to_string())?,
                        &mut output,
                        &health_snapshot,
                        &event_log,
                        &projection.subscribers,
                    )?;
                }
                ControlRequest::Http {
                    method,
                    path,
                    body,
                    reply,
                    ..
                } => {
                    let mut response = runtime.artifact_http(&method, &path, &body);
                    let events = std::mem::take(&mut response.events);
                    if !events.is_empty() {
                        publish_native_events(
                            events,
                            &mut output,
                            &event_log,
                            &projection.subscribers,
                        )?;
                    }
                    let _ = reply.send(response);
                }
            }
            if runtime.closed {
                break;
            }
        }
        if runtime.closed {
            break;
        }
        if stdin_closed {
            break;
        }
        match stdin_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(line)) => {
                dispatch_request(
                    &mut runtime,
                    line,
                    &mut output,
                    &health_snapshot,
                    &event_log,
                    &projection.subscribers,
                )?;
            }
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => stdin_closed = true,
        }
    }
    if !runtime.closed {
        let close_events = runtime.close(None)?;
        publish_native_events(
            close_events,
            &mut output,
            &event_log,
            &projection.subscribers,
        )?;
        if let Ok(mut value) = health_snapshot.lock() {
            *value = runtime.health(None);
        }
    }
    output
        .flush()
        .map_err(|error| format!("stdout_flush_failed:{error}"))?;
    std::thread::sleep(Duration::from_millis(50));
    projection.close();
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_config(root: &Path) -> NativeRuntimeConfig {
        NativeRuntimeConfig {
            identity: "native-test-agent".to_string(),
            session_id: "native-test-session".to_string(),
            site_root: Some(root.to_path_buf()),
            mcp_scope: "none".to_string(),
            health_enabled: false,
            health_host: "127.0.0.1".to_string(),
            health_port: 0,
            events_enabled: false,
            events_host: "127.0.0.1".to_string(),
            events_port: 0,
            orientation_entry_file: None,
            orientation_required: None,
        }
    }

    fn test_runtime(root: &Path) -> NativeRuntime {
        NativeRuntime::new(test_config(root)).unwrap()
    }

    #[test]
    fn orientation_requirement_signal_cannot_be_erased_by_omitting_the_entry_path() {
        let root = std::env::temp_dir().join(format!(
            "narada-runtime-orientation-signal-{}",
            Uuid::new_v4().simple()
        ));
        let mut config = test_config(&root);
        config.orientation_required = Some(true);
        assert_eq!(
            OrientationEntryGate::from_config(&config).unwrap_err(),
            "orientation_entry_packet_required"
        );
        config.orientation_required = Some(false);
        config.orientation_entry_file = Some(root.join("entry.json"));
        assert_eq!(
            OrientationEntryGate::from_config(&config).unwrap_err(),
            "orientation_required_signal_conflict"
        );
    }

    #[test]
    fn event_read_and_subscription_replay_are_durable_protocol_surfaces() {
        let root =
            std::env::temp_dir().join(format!("narada-runtime-events-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&root).unwrap();
        let mut runtime = test_runtime(&root);
        runtime.startup().unwrap();
        runtime
            .supervisor
            .core_mut()
            .append_event(json!({
                "event": "user_message",
                "request_id": "request-1",
                "event_sequence": 3,
                "timestamp": "2026-01-01T00:00:03.000Z"
            }))
            .unwrap();
        runtime
            .supervisor
            .core_mut()
            .append_event(json!({
                "event": "session_health",
                "event_sequence": 4,
                "timestamp": "2026-01-01T00:00:04.000Z"
            }))
            .unwrap();

        let read = runtime
            .handle(json!({
                "id": "read-1",
                "method": "session.events.read",
                "params": { "view": "conversation", "limit": 1 }
            }))
            .unwrap();
        let read_response = read
            .iter()
            .find(|event| event["event"] == "session_events_read")
            .unwrap();
        assert_eq!(read_response["request_id"], "read-1");
        assert_eq!(read_response["view"], "conversation");
        assert_eq!(read_response["events"][0]["event"], "user_message");

        let subscription = runtime
            .handle(json!({
                "id": "sub-1",
                "method": "session.events.subscribe",
                "params": { "view": "conversation", "page_size": 10 }
            }))
            .unwrap();
        let subscription_started = subscription
            .iter()
            .find(|event| event["event"] == "session_events_subscription_started")
            .unwrap();
        assert!(subscription_started["replay_count"].as_u64().unwrap_or(0) >= 1);
        let replay_event = subscription
            .iter()
            .find(|event| {
                event["event"] == "session_event" && event["payload"]["event"] == "user_message"
            })
            .unwrap();
        assert_eq!(replay_event["payload"]["event"], "user_message");
        assert!(subscription
            .iter()
            .any(|event| event["event"] == "session_events_replay_completed"));
        let live = runtime
            .handle(json!({
                "id": "command-1",
                "method": "session.command.execute",
                "params": { "command": "status" }
            }))
            .unwrap();
        assert!(live.iter().any(|event| {
            event["event"] == "session_event"
                && event["payload"]["event"] == "session_control_accepted"
                && event["cursor"]["namespace"] == "durable"
        }));
        let cancel = runtime
            .handle(json!({
                "id": "cancel-1",
                "method": "session.cancel",
                "params": {}
            }))
            .unwrap();
        assert!(cancel
            .iter()
            .any(|event| event["event"] == "session_cancel"));
        let durable = runtime
            .supervisor
            .core()
            .events_page_contract(&json!({ "view": "raw", "limit": 100 }))
            .unwrap();
        assert_eq!(
            durable["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["event"] == "session_cancel")
                .count(),
            1
        );
        runtime.close(None).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_submit_preserves_forwarded_input_identity_and_admission_metadata() {
        let root = std::env::temp_dir().join(format!(
            "narada-runtime-forwarded-input-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut runtime = test_runtime(&root);
        runtime.startup().unwrap();
        let events = runtime
            .handle(json!({
                "id": "request-forwarded",
                "method": "session.submit",
                "params": {
                    "event_id": "input-forwarded",
                    "request_id": "request-forwarded",
                    "content": "forwarded input",
                    "source": "agent_control",
                    "source_kind": "agent",
                    "source_id": "adapter-test",
                    "transport": "carrier_server_api",
                    "delivery_mode": "admit_after_active_turn",
                    "authority_ref": "nars-session-mcp:site:session:1",
                    "directive_id": "directive-forwarded",
                    "idempotency_key": "forwarded-key"
                }
            }))
            .unwrap();
        let queued = events
            .iter()
            .find(|event| event.get("event").and_then(Value::as_str) == Some("input_event_queued"))
            .expect("queued event");
        assert_eq!(queued["input_event_id"], "input-forwarded");
        assert_eq!(queued["request_id"], "request-forwarded");
        assert_eq!(queued["source"], "agent_control");
        assert_eq!(queued["delivery_mode"], "admit_after_active_turn");
        assert_eq!(queued["directive_id"], "directive-forwarded");
        runtime.close(Some("close-forwarded".to_string())).unwrap();
        let _ = fs::remove_dir_all(root);
    }
}
