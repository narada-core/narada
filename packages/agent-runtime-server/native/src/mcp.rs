//! Native NARS MCP capability gateway.
//!
//! The TypeScript runtime used to own the MCP child-process boundary.  The
//! native runtime keeps the same narrow ownership split: this module owns
//! discovery, child transport, tool catalogues, and tool-attempt evidence;
//! session state and durable authority remain in `nars-session-core` and
//! `nars-session-authority`.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 15_000;
const ORIENTATION_ENTRY_TOOLS: &[&str] = &["agent_orientation_read", "mcp_output_show"];

fn orientation_entry_tool(name: &str) -> bool {
    ORIENTATION_ENTRY_TOOLS.contains(&name)
}

#[derive(Debug, Clone)]
struct ServerConfig {
    name: String,
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    env_vars: Vec<String>,
    startup_timeout_ms: u64,
    request_timeout_ms: u64,
    surface_factory: bool,
    declared_tools: Vec<Value>,
}

struct McpServer {
    config: ServerConfig,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    messages: Receiver<Value>,
    tools: Vec<Value>,
    next_request_id: u64,
    disconnected: Option<String>,
}

#[derive(Debug, Clone)]
pub struct McpGatewaySnapshot {
    pub lifecycle_state: String,
    pub operational_state: String,
    pub server_count: usize,
    pub startup_failure_count: usize,
    pub active_execution_count: usize,
    pub execution_count: usize,
}

#[derive(Debug, Clone)]
struct WorkerMcpProjection {
    mode: String,
    allowlist: BTreeSet<String>,
    include_startup_tools: bool,
    include_output_readback_tools: bool,
}

const WORKER_STARTUP_TOOLS: &[&str] = &["agent_orientation_read"];
const WORKER_OUTPUT_TOOLS: &[&str] = &[
    "fs_read_file",
    "fs_read_file_range",
    "fs_grep_search",
    "mcp_output_show",
];
pub struct NativeMcpGateway {
    site_root: PathBuf,
    scope: String,
    lifecycle_state: String,
    servers: BTreeMap<String, McpServer>,
    startup_failures: Vec<Value>,
    runtime_faults: Vec<Value>,
    next_execution_id: u64,
    execution_count: usize,
    worker_projection: Option<WorkerMcpProjection>,
    orientation_only: bool,
}

impl NativeMcpGateway {
    pub fn new(site_root: Option<&Path>, scope: &str) -> Self {
        Self {
            site_root: site_root.unwrap_or_else(|| Path::new(".")).to_path_buf(),
            scope: scope.to_string(),
            lifecycle_state: "idle".to_string(),
            servers: BTreeMap::new(),
            startup_failures: Vec::new(),
            runtime_faults: Vec::new(),
            next_execution_id: 1,
            execution_count: 0,
            worker_projection: worker_mcp_projection_from_env(),
            orientation_only: false,
        }
    }

    pub fn begin_orientation(&mut self) {
        self.orientation_only = true;
    }

    pub fn end_orientation(&mut self) {
        self.orientation_only = false;
    }

    pub fn start(&mut self) -> Vec<Value> {
        if self.scope == "none" {
            self.lifecycle_state = "closed".to_string();
            return Vec::new();
        }
        if matches!(self.lifecycle_state.as_str(), "healthy" | "degraded") {
            return Vec::new();
        }
        self.lifecycle_state = "starting".to_string();
        let mut events = vec![json!({
            "kind": "capability_gateway_lifecycle_transition",
            "schema": "narada.nars.capability_gateway_state.v1",
            "event": "capability_gateway_lifecycle_transition",
            "previous_state": "idle",
            "lifecycle_state": "starting",
            "operational_state": "starting",
            "reason": "start_requested",
        })];

        let configs = match discover_configs(&self.site_root) {
            Ok(configs) => configs,
            Err(error) => {
                self.startup_failures.push(json!({
                    "schema": "narada.agent_cli.mcp_startup_diagnostic.v0",
                    "code": "mcp_fabric_load_failed",
                    "phase": "fabric_load",
                    "message": error,
                }));
                Vec::new()
            }
        };
        for config in configs {
            let name = config.name.clone();
            match start_server(config) {
                Ok(mut server) => {
                    if let Some(projection) = self.worker_projection.as_ref() {
                        apply_worker_projection(&name, &mut server, projection);
                    }
                    if !server.tools.is_empty() {
                        self.servers.insert(name, server);
                    }
                }
                Err(error) => {
                    self.startup_failures.push(json!({
                        "schema": "narada.agent_cli.mcp_startup_diagnostic.v0",
                        "code": "mcp_server_startup_failed",
                        "phase": "initialize_or_tools_list",
                        "server_name": name,
                        "message": error,
                    }));
                }
            }
        }
        self.lifecycle_state = if self.startup_failures.is_empty() {
            "healthy".to_string()
        } else {
            "degraded".to_string()
        };
        events.push(json!({
            "kind": "capability_gateway_lifecycle_transition",
            "schema": "narada.nars.capability_gateway_state.v1",
            "event": "capability_gateway_lifecycle_transition",
            "previous_state": "starting",
            "lifecycle_state": self.lifecycle_state,
            "operational_state": self.operational_state(),
            "reason": "start_completed",
            "server_count": self.servers.len(),
            "startup_failure_count": self.startup_failures.len(),
        }));
        events
    }

    pub fn tool_catalog(&self) -> Vec<Value> {
        let bindings = self.bindings();
        bindings
            .into_iter()
            .filter(|(_, tool, _)| {
                !self.orientation_only
                    || tool
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(orientation_entry_tool)
            })
            .map(|(server_name, tool, provider_name)| {
                json!({
                    "server_name": server_name,
                    "tool_name": tool.get("name").cloned().unwrap_or(Value::Null),
                    "provider_tool_name": provider_name,
                    "input_schema": tool.get("inputSchema").or_else(|| tool.get("input_schema")).cloned().unwrap_or_else(|| json!({"type":"object","properties":{}})),
                })
            })
            .collect()
    }

    pub fn invoke(
        &mut self,
        tool_name: &str,
        arguments: Value,
        turn_id: Option<&str>,
        input_event_id: Option<&str>,
        event_sink: &mut dyn FnMut(Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        let execution_id = format!("tool_execution_{}", self.next_execution_id);
        self.next_execution_id += 1;
        self.execution_count += 1;
        let common = json!({
            "schema": "narada.nars.tool_execution_state.v1",
            "execution_id": execution_id,
            "turn_id": turn_id,
            "input_event_id": input_event_id,
            "tool_name": tool_name,
        });
        let mut requested = common.clone();
        requested["event"] = json!("tool_execution_state_transition");
        requested["kind"] = json!("tool_execution_state_transition");
        requested["previous_state"] = Value::Null;
        requested["execution_state"] = json!("requested");
        event_sink(requested)?;

        if self.scope == "none" {
            return self.finish_refused(common, "gateway_scope_disabled", event_sink);
        }
        if !matches!(self.lifecycle_state.as_str(), "healthy" | "degraded") {
            let _ = self.start();
        }
        let Some((server_name, original_name)) = self.find_binding(tool_name) else {
            return self.finish_refused(common, "tool_not_found", event_sink);
        };
        if self.orientation_only && !orientation_entry_tool(&original_name) {
            return self.finish_refused(
                common,
                "orientation_bootstrap_tool_not_allowed",
                event_sink,
            );
        }
        let Some(server) = self.servers.get_mut(&server_name) else {
            return self.finish_refused(common, "mcp_server_not_found", event_sink);
        };
        let mut admitted = common.clone();
        admitted["event"] = json!("tool_execution_state_transition");
        admitted["kind"] = json!("tool_execution_state_transition");
        admitted["previous_state"] = json!("requested");
        admitted["execution_state"] = json!("admitted");
        admitted["server_name"] = json!(server_name);
        admitted["admission"] = json!({"admitted": true, "reason": "gateway_default_admission"});
        event_sink(admitted)?;
        let mut executing = common.clone();
        executing["event"] = json!("tool_execution_state_transition");
        executing["kind"] = json!("tool_execution_state_transition");
        executing["previous_state"] = json!("admitted");
        executing["execution_state"] = json!("executing");
        executing["server_name"] = json!(server_name);
        event_sink(executing)?;

        if server.config.surface_factory {
            return self.finish_failed(
                common,
                "mcp_surface_factory_requires_site_service_dispatch",
                event_sink,
            );
        }
        let request = json!({
            "jsonrpc": "2.0",
            "id": server.next_request_id,
            "method": "tools/call",
            "params": {"name": original_name, "arguments": arguments},
        });
        server.next_request_id += 1;
        let response_result = server.request(request, server.config.request_timeout_ms);
        let response = match response_result {
            Ok(response) => response,
            Err(error) => return self.finish_failed(common, &error, event_sink),
        };
        if let Some(error) = response.get("error") {
            return self.finish_failed(
                common,
                &format!("mcp_tool_error:{}", compact(error)),
                event_sink,
            );
        }
        let result = response.get("result").cloned().unwrap_or(Value::Null);
        let mut completed = common.clone();
        completed["event"] = json!("tool_execution_state_transition");
        completed["kind"] = json!("tool_execution_state_transition");
        completed["previous_state"] = json!("executing");
        completed["execution_state"] = json!("completed");
        completed["server_name"] = json!(server_name);
        completed["result"] = result.clone();
        event_sink(completed)?;
        event_sink(json!({
            "event": "tool_execution_completed",
            "kind": "tool_execution_completed",
            "execution_id": common["execution_id"],
            "turn_id": turn_id,
            "input_event_id": input_event_id,
            "tool_name": tool_name,
            "server_name": server_name,
            "status": "completed",
        }))?;
        Ok(json!({
            "status": "completed",
            "result": result,
            "admission": {"admitted": true, "reason": "gateway_default_admission"},
            "execution_id": common["execution_id"],
        }))
    }

    fn finish_refused(
        &self,
        common: Value,
        reason: &str,
        event_sink: &mut dyn FnMut(Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        let execution_id = common["execution_id"].clone();
        event_sink(json!({
            "event": "tool_execution_state_transition",
            "kind": "tool_execution_state_transition",
            "schema": "narada.nars.tool_execution_state.v1",
            "execution_id": execution_id,
            "turn_id": common["turn_id"],
            "input_event_id": common["input_event_id"],
            "tool_name": common["tool_name"],
            "previous_state": "requested",
            "execution_state": "refused",
            "terminal_state": "refused",
            "reason": reason,
        }))?;
        event_sink(json!({
            "event": "tool_execution_refused",
            "kind": "tool_execution_refused",
            "execution_id": execution_id,
            "tool_name": common["tool_name"],
            "status": "refused",
            "reason": reason,
        }))?;
        Ok(json!({"status":"refused","reason":reason,"execution_id":execution_id}))
    }

    fn finish_failed(
        &mut self,
        common: Value,
        reason: &str,
        event_sink: &mut dyn FnMut(Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        self.runtime_faults.push(json!({
            "server_name": common.get("server_name"),
            "tool_name": common.get("tool_name"),
            "message": reason,
        }));
        let execution_id = common["execution_id"].clone();
        event_sink(json!({
            "event": "tool_execution_state_transition",
            "kind": "tool_execution_state_transition",
            "schema": "narada.nars.tool_execution_state.v1",
            "execution_id": execution_id,
            "turn_id": common["turn_id"],
            "input_event_id": common["input_event_id"],
            "tool_name": common["tool_name"],
            "previous_state": "executing",
            "execution_state": "failed",
            "terminal_state": "failed",
            "error": reason,
        }))?;
        event_sink(json!({
            "event": "tool_execution_failed",
            "kind": "tool_execution_failed",
            "execution_id": execution_id,
            "tool_name": common["tool_name"],
            "status": "failed",
            "error": reason,
        }))?;
        Ok(json!({"status":"failed","error":reason,"execution_id":execution_id}))
    }

    fn bindings(&self) -> Vec<(String, Value, String)> {
        let mut values = Vec::new();
        let mut counts = BTreeMap::<String, usize>::new();
        for server in self.servers.values() {
            for tool in &server.tools {
                if let Some(name) = tool.get("name").and_then(Value::as_str) {
                    *counts.entry(name.to_string()).or_default() += 1;
                }
            }
        }
        let mut seen = BTreeMap::<String, usize>::new();
        for (server_name, server) in &self.servers {
            for tool in &server.tools {
                let Some(name) = tool.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let identity = if counts.get(name).copied().unwrap_or(0) > 1 {
                    format!("mcp__{server_name}__{name}")
                } else {
                    name.to_string()
                };
                let provider = safe_provider_name(&identity, &mut seen);
                values.push((server_name.clone(), tool.clone(), provider));
            }
        }
        values
    }

    fn find_binding(&self, requested: &str) -> Option<(String, String)> {
        let bindings = self.bindings();
        if let Some((server, tool, _provider)) = bindings
            .iter()
            .find(|(_, _, provider)| provider == requested)
        {
            return Some((server.clone(), tool.get("name")?.as_str()?.to_string()));
        }
        let originals: Vec<_> = bindings
            .iter()
            .filter(|(_, tool, _)| tool.get("name").and_then(Value::as_str) == Some(requested))
            .collect();
        if originals.len() == 1 {
            let (server, tool, _) = originals[0];
            return Some((server.clone(), tool.get("name")?.as_str()?.to_string()));
        }
        None
    }

    pub fn snapshot(&self) -> McpGatewaySnapshot {
        McpGatewaySnapshot {
            lifecycle_state: self.lifecycle_state.clone(),
            operational_state: self.operational_state(),
            server_count: self.servers.len(),
            startup_failure_count: self.startup_failures.len(),
            active_execution_count: 0,
            execution_count: self.execution_count,
        }
    }

    pub fn startup_failures(&self) -> &[Value] {
        &self.startup_failures
    }
    pub fn runtime_faults(&self) -> &[Value] {
        &self.runtime_faults
    }

    fn operational_state(&self) -> String {
        if self.scope == "none" {
            "disabled".to_string()
        } else if self.lifecycle_state == "degraded" {
            "startup_degraded".to_string()
        } else {
            self.lifecycle_state.clone()
        }
    }

    pub fn close(&mut self) -> Vec<Value> {
        if self.scope == "none" || self.lifecycle_state == "closed" {
            return Vec::new();
        }
        let previous = self.lifecycle_state.clone();
        self.lifecycle_state = "closing".to_string();
        for server in self.servers.values_mut() {
            if let Some(mut child) = server.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            server.stdin.take();
        }
        self.servers.clear();
        self.lifecycle_state = "closed".to_string();
        vec![json!({
            "kind": "capability_gateway_lifecycle_transition",
            "event": "capability_gateway_lifecycle_transition",
            "schema": "narada.nars.capability_gateway_state.v1",
            "previous_state": previous,
            "lifecycle_state": "closed",
            "operational_state": "closed",
            "reason": "close_completed",
        })]
    }
}

impl McpServer {
    fn request(&mut self, request: Value, timeout_ms: u64) -> Result<Value, String> {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "mcp_server_not_connected".to_string())?;
        serde_json::to_writer(&mut *stdin, &request)
            .map_err(|error| format!("mcp_request_encode_failed:{error}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|error| format!("mcp_request_write_failed:{error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("mcp_request_flush_failed:{error}"))?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("mcp_request_timeout:{timeout_ms}"));
            }
            match self.messages.recv_timeout(remaining) {
                Ok(response) => {
                    if response.get("id") == Some(&id) {
                        return Ok(response);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!("mcp_request_timeout:{timeout_ms}"))
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self
                        .disconnected
                        .clone()
                        .unwrap_or_else(|| "mcp_server_disconnected".to_string()))
                }
            }
        }
    }
}

fn worker_mcp_projection_from_env() -> Option<WorkerMcpProjection> {
    let raw = env::var("NARADA_WORKER_MCP_CONFIG").ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    let object = value.as_object()?;
    let mode = object
        .get("native_mcp_mode")
        .or_else(|| object.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("scoped")
        .trim()
        .to_ascii_lowercase();
    if !matches!(mode.as_str(), "minimal" | "scoped" | "full") {
        return None;
    }
    let allowlist = object
        .get("mcp_tool_allowlist")
        .or_else(|| object.get("required_mcp_tools"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    Some(WorkerMcpProjection {
        mode,
        allowlist,
        include_startup_tools: object
            .get("include_startup_tools")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        include_output_readback_tools: object
            .get("include_output_readback_tools")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn apply_worker_projection(
    server_name: &str,
    server: &mut McpServer,
    projection: &WorkerMcpProjection,
) {
    if projection.mode == "full" {
        return;
    }
    let mut seen = BTreeMap::new();
    let mut tools = Vec::new();
    for tool in &server.tools {
        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            continue;
        };
        let provider = safe_provider_name(name, &mut seen);
        let mut allowed = projection.allowlist.contains(name)
            || projection.allowlist.contains(&provider)
            || projection
                .allowlist
                .contains(&format!("{server_name}.{name}"))
            || projection
                .allowlist
                .contains(&format!("{server_name}.{provider}"));
        if projection.include_startup_tools && WORKER_STARTUP_TOOLS.contains(&name) {
            allowed = true;
        }
        if projection.include_output_readback_tools && WORKER_OUTPUT_TOOLS.contains(&name) {
            allowed = true;
        }
        if allowed {
            tools.push(tool.clone());
        }
    }
    server.tools = tools;
}

const CHILD_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "APPDATA",
    "LOCALAPPDATA",
    "HOME",
    "PROGRAMFILES",
    "ProgramFiles",
    "PROGRAMFILES(X86)",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "PROCESSOR_ARCHITECTURE",
    "CODEX_HOME",
    "CODEX_CONFIG_DIR",
    "NARADA_AGENT_ID",
    "NARADA_AGENT_START_EVENT_ID",
    "NARADA_NARS_SESSION_ID",
    "NARADA_RUNTIME_SESSION_ID",
    "NARADA_CARRIER_SESSION_ID",
    "NARADA_SITE_ROOT",
    "NARADA_WORKSPACE_ROOT",
    "NARADA_AGENT_CONTEXT_DB",
    "NARADA_MCP_SCOPE",
    "NARADA_PC_SITE_ROOT",
    "NARADA_PROPER_ROOT",
    "NARADA_CODEX_SUBSCRIPTION_TRANSPORT",
    "OPENAI_API_KEY",
    "KIMI_API_KEY",
    "ANTHROPIC_API_KEY",
    "KIMI_CODE_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "NARADA_WORKER_MCP_CONFIG",
    "NARADA_LAUNCH_SESSION_ID",
    "NARADA_PROCESS_OWNERSHIP",
    "NARADA_PROCESS_ROLE",
    "NARADA_CREATED_BY_PID",
    "NARADA_NATIVE_PROVIDER_MODE",
    "NARADA_NATIVE_CODEX_COMMAND",
    "NARADA_CODEX_EXEC_COMMAND",
    "NARADA_CODEX_EXEC_PREFIX_ARGS",
    "NARADA_CODEX_COMMAND",
    "CODEX_COMMAND",
];

fn inherited_child_env(config: &ServerConfig) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for key in CHILD_ENV_ALLOWLIST {
        if let Ok(value) = env::var(key) {
            values.insert((*key).to_string(), value);
        }
    }
    for key in &config.env_vars {
        if let Ok(value) = env::var(key) {
            values.insert(key.clone(), value);
        }
    }
    values.extend(config.env.clone());
    values.insert("FORCE_COLOR".to_string(), "0".to_string());
    values.insert("NO_COLOR".to_string(), "1".to_string());
    values
}
fn discover_configs(site_root: &Path) -> Result<Vec<ServerConfig>, String> {
    let candidates = [
        site_root.join(".ai").join("mcp"),
        site_root.join(".narada").join(".ai").join("mcp"),
    ];
    let directory = candidates.iter().find(|path| path.is_dir()).cloned();
    let registry_path = site_root
        .join(".narada")
        .join("capabilities")
        .join("mcp-surfaces.json");
    let registry = if registry_path.is_file() {
        let text = fs::read_to_string(&registry_path)
            .map_err(|error| format!("mcp_registry_file_read_failed:{error}"))?;
        Some(
            serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("mcp_registry_invalid_json:{error}"))?,
        )
    } else {
        None
    };

    let mut packets: Vec<(String, Value)> = Vec::new();
    if let Some(directory) = directory {
        let mut files: Vec<PathBuf> = fs::read_dir(&directory)
            .map_err(|error| format!("mcp_fabric_read_failed:{error}"))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .collect();
        files.sort();
        for file in files {
            let text = fs::read_to_string(&file)
                .map_err(|error| format!("mcp_fabric_file_read_failed:{error}"))?;
            let packet = serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("mcp_fabric_invalid_json:{}:{error}", file.display()))?;
            packets.push((
                file.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                packet,
            ));
        }
    } else if let Some(registry) = registry.as_ref() {
        packets.extend(registry_runtime_packets(registry));
    }

    let mut configs = Vec::new();
    for (source_name, packet) in packets {
        let Some(servers) = packet.get("mcpServers").and_then(Value::as_object) else {
            continue;
        };
        for (name, raw) in servers {
            let Some(object) = raw.as_object() else {
                continue;
            };
            let transport = object.get("transport").and_then(Value::as_str).unwrap_or(
                if object.get("command").is_some() {
                    "stdio"
                } else {
                    ""
                },
            );
            if transport != "stdio" {
                continue;
            }
            let command = object
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if command.is_empty() {
                continue;
            }
            let args = object
                .get("args")
                .and_then(Value::as_array)
                .map(|args| {
                    args.iter()
                        .filter_map(Value::as_str)
                        .map(|arg| arg.replace("{site_root}", &site_root.to_string_lossy()))
                        .collect()
                })
                .unwrap_or_default();
            let mut env = BTreeMap::new();
            if let Some(values) = object.get("env").and_then(Value::as_object) {
                for (key, value) in values {
                    if let Some(value) = value.as_str() {
                        env.insert(
                            key.clone(),
                            value.replace("{site_root}", &site_root.to_string_lossy()),
                        );
                    }
                }
            }
            let env_vars = object
                .get("env_vars")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let declared_tools = object
                .get("tools")
                .or_else(|| object.get("tool_names"))
                .and_then(Value::as_array)
                .cloned()
                .or_else(|| {
                    object
                        .get("surface_projection")
                        .and_then(|projection| projection.get("surface_descriptor"))
                        .and_then(|descriptor| descriptor.get("tools"))
                        .and_then(Value::as_array)
                        .cloned()
                })
                .unwrap_or_default();
            let surface_factory = object
                .get("surface_projection")
                .and_then(|projection| projection.get("execution"))
                .and_then(|execution| execution.get("adapter"))
                .and_then(Value::as_str)
                == Some("surface_factory");
            let startup_timeout_ms = duration_ms(
                object.get("startup_timeout_sec"),
                DEFAULT_STARTUP_TIMEOUT_MS,
            );
            let request_timeout_ms =
                duration_ms(object.get("request_timeout_ms"), DEFAULT_REQUEST_TIMEOUT_MS);
            let _ = source_name;
            configs.push(ServerConfig {
                name: name.clone(),
                command: command.to_string(),
                args,
                env,
                env_vars,
                startup_timeout_ms,
                request_timeout_ms,
                surface_factory,
                declared_tools,
            });
        }
    }
    Ok(configs)
}

fn registry_runtime_packets(registry: &Value) -> Vec<(String, Value)> {
    let surfaces = registry
        .get("surfaces")
        .or_else(|| registry.get("mcp_surfaces"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    surfaces
        .into_iter()
        .filter_map(|surface| {
            let object = surface.as_object()?;
            let server_name = registry_server_name(object)?;
            let transport = object
                .get("runtime_binding")
                .and_then(|binding| binding.get("transport"))
                .and_then(Value::as_object)?;
            let command = transport.get("command")?.as_str()?.to_string();
            let args = transport.get("args").cloned().unwrap_or_else(|| json!([]));
            let mut server = json!({
                "transport": transport.get("type").and_then(Value::as_str).unwrap_or("stdio"),
                "command": command,
                "args": args,
            });
            if let Some(server_object) = server.as_object_mut() {
                if let Some(env) = transport.get("env") {
                    server_object.insert("env".to_string(), env.clone());
                }
                if let Some(env_vars) = transport.get("env_vars") {
                    server_object.insert("env_vars".to_string(), env_vars.clone());
                }
                let catalog_surface_id = object
                    .get("catalog_surface_id")
                    .or_else(|| object.get("surface_id"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let projection_id = object.get("surface_id").cloned().unwrap_or(Value::Null);
                let mut projection = object
                    .get("surface_projection")
                    .cloned()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({}));
                if let Some(projection_object) = projection.as_object_mut() {
                    if !projection_object.contains_key("surface_id") {
                        projection_object.insert("surface_id".to_string(), catalog_surface_id);
                    }
                    if !projection_object.contains_key("projection_id") {
                        projection_object.insert("projection_id".to_string(), projection_id);
                    }
                    if !projection_object.contains_key("injection_scope") {
                        projection_object
                            .insert("injection_scope".to_string(), json!("local_site"));
                    }
                    if !projection_object.contains_key("runtime_requirements") {
                        projection_object.insert("runtime_requirements".to_string(), json!([]));
                    }
                }
                server_object.insert("surface_projection".to_string(), projection);
                if let Some(surface_id) = object.get("surface_id") {
                    server_object.insert("surface_id".to_string(), surface_id.clone());
                }
                let tools = object
                    .get("tool_contract")
                    .and_then(|contract| contract.get("exposed_tools"))
                    .cloned()
                    .or_else(|| object.get("registered_live_tools").cloned());
                if let Some(tools) = tools {
                    server_object.insert("tools".to_string(), tools);
                }
                if let Some(posture) = object
                    .get("authority_boundary")
                    .and_then(|boundary| boundary.get("posture"))
                {
                    server_object.insert("authority_posture".to_string(), posture.clone());
                }
            }
            Some((
                format!("{server_name}.registry.json"),
                json!({"mcpServers": {server_name: server}}),
            ))
        })
        .collect()
}

fn registry_server_name(object: &Map<String, Value>) -> Option<String> {
    let explicit = ["server_name", "display_name"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_str))
        .find(|value| !value.trim().is_empty());
    if explicit.is_some() {
        return explicit.map(str::to_string);
    }
    if let Some(name) = object
        .get("client_config")
        .and_then(|config| config.get("server_name"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Some(name.to_string());
    }
    for key in ["package", "path"] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            let normalized = value.replace('\\', "/");
            let last = normalized
                .rsplit('/')
                .next()
                .unwrap_or(normalized.as_str())
                .trim_end_matches(".mjs")
                .trim_end_matches(".cjs")
                .trim_end_matches(".js")
                .trim_end_matches(".ts");
            if !last.is_empty() {
                return Some(last.trim_end_matches("-mcp").to_string());
            }
        }
    }
    None
}
fn duration_ms(value: Option<&Value>, default_ms: u64) -> u64 {
    let Some(value) = value else {
        return default_ms;
    };
    let number = value.as_f64().unwrap_or(default_ms as f64);
    if !number.is_finite() || number <= 0.0 {
        default_ms
    } else if number < 100.0 {
        (number * 1000.0) as u64
    } else {
        number as u64
    }
}

fn start_server(config: ServerConfig) -> Result<McpServer, String> {
    if config.surface_factory {
        return Ok(McpServer {
            tools: declared_tools(&config.declared_tools),
            config,
            child: None,
            stdin: None,
            messages: mpsc::channel().1,
            next_request_id: 1,
            disconnected: None,
        });
    }
    let mut command = Command::new(&config.command);
    command
        .args(&config.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_clear();
    for (key, value) in inherited_child_env(&config) {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("mcp_server_spawn_failed:{error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "mcp_server_stdin_unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "mcp_server_stdout_unavailable".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || drain_stderr(stderr));
    }
    let (sender, receiver) = mpsc::channel();
    spawn_reader(stdout, sender);
    let mut server = McpServer {
        config,
        child: Some(child),
        stdin: Some(stdin),
        messages: receiver,
        tools: Vec::new(),
        next_request_id: 1,
        disconnected: None,
    };
    let initialize = server.request(json!({"jsonrpc":"2.0","id":server.next_request_id,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}), server.config.startup_timeout_ms)?;
    server.next_request_id += 1;
    if initialize.get("error").is_some() {
        return Err(format!(
            "mcp_initialize_failed:{}",
            compact(initialize.get("error").unwrap())
        ));
    }
    if let Some(stdin) = server.stdin.as_mut() {
        let _ = serde_json::to_writer(
            &mut *stdin,
            &json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
        );
        let _ = stdin.write_all(b"\n");
        let _ = stdin.flush();
    }
    let tools = server.request(
        json!({"jsonrpc":"2.0","id":server.next_request_id,"method":"tools/list","params":{}}),
        server.config.startup_timeout_ms,
    )?;
    server.next_request_id += 1;
    if tools.get("error").is_some() {
        return Err(format!(
            "mcp_tools_list_failed:{}",
            compact(tools.get("error").unwrap())
        ));
    }
    server.tools = tools
        .get("result")
        .and_then(|result| result.get("tools"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(server)
}

fn declared_tools(values: &[Value]) -> Vec<Value> {
    values
        .iter()
        .filter_map(|value| {
            if value.is_string() {
                Some(json!({"name":value,"inputSchema":{"type":"object","properties":{}}}))
            } else if value.is_object() {
                Some(value.clone())
            } else {
                None
            }
        })
        .collect()
}

fn spawn_reader(stdout: ChildStdout, sender: Sender<Value>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_message(&mut reader) {
                Ok(Some(value)) => {
                    if sender.send(value).is_err() {
                        break;
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
    });
}

fn drain_stderr(stderr: std::process::ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    while reader
        .read_line(&mut line)
        .ok()
        .filter(|count| *count > 0)
        .is_some()
    {
        line.clear();
    }
}

fn read_message(reader: &mut BufReader<ChildStdout>) -> std::io::Result<Option<Value>> {
    let mut first = String::new();
    loop {
        first.clear();
        if reader.read_line(&mut first)? == 0 {
            return Ok(None);
        }
        let trimmed = first.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.to_ascii_lowercase().starts_with("content-length:") {
            let mut length = trimmed
                .split(':')
                .nth(1)
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            let mut header = String::new();
            loop {
                header.clear();
                if reader.read_line(&mut header)? == 0 {
                    return Ok(None);
                }
                if header.trim().is_empty() {
                    break;
                }
                if header.to_ascii_lowercase().starts_with("content-length:") {
                    length = header
                        .split(':')
                        .nth(1)
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(length);
                }
            }
            if length == 0 {
                continue;
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body)?;
            return Ok(serde_json::from_slice(&body).ok());
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            return Ok(Some(value));
        }
    }
}

fn safe_provider_name(raw: &str, seen: &mut BTreeMap<String, usize>) -> String {
    let mut name: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if name.is_empty()
        || !name
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic())
    {
        name = format!("tool_{name}");
    }
    let count = seen.entry(name.clone()).or_default();
    if *count == 0 {
        *count = 1;
        return name;
    }
    *count += 1;
    let hashed = format!("{name}_{}", short_stable_hash(raw));
    if !seen.contains_key(&hashed) {
        seen.insert(hashed.clone(), 1);
        return hashed;
    }
    let mut index = 2;
    loop {
        let candidate = format!("{hashed}_{index}");
        if !seen.contains_key(&candidate) {
            seen.insert(candidate.clone(), 1);
            return candidate;
        }
        index += 1;
    }
}

fn short_stable_hash(value: &str) -> String {
    let mut hash: u32 = 2_166_136_261;
    for ch in value.chars() {
        hash ^= ch as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    let mut digits = Vec::new();
    let mut remaining = hash;
    if remaining == 0 {
        digits.push('0');
    } else {
        while remaining > 0 {
            let digit = (remaining % 36) as u8;
            digits.push(match digit {
                0..=9 => (b'0' + digit) as char,
                _ => (b'a' + digit - 10) as char,
            });
            remaining /= 36;
        }
        digits.reverse();
    }
    digits.into_iter().take(6).collect()
}
fn compact(value: &Value) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "<invalid-json>".to_string())
        .chars()
        .take(1000)
        .collect()
}
