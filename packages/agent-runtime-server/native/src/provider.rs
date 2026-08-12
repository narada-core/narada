//! Native NARS provider execution boundary.
//!
//! Provider selection remains an invocation concern.  This adapter accepts a
//! small explicit mode for deterministic tests and a real Codex subprocess
//! mode for local launches.  The subprocess is the provider/carrier boundary;
//! it is not a NARS runtime and never owns session state or MCP authority.

use crate::mcp::NativeMcpGateway;
use narada_nars_session_core::{
    CoreError, NarsProviderAdapter, ProviderOutcome, ProviderTurnContext,
};
use serde_json::{json, Value};
use std::env;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

pub struct NativeProviderAdapter<'a> {
    pub mode: String,
    pub site_root: Option<PathBuf>,
    pub gateway: &'a mut NativeMcpGateway,
    pub max_tool_rounds: usize,
    pub session_id: Option<String>,
}

impl<'a> NativeProviderAdapter<'a> {
    pub fn from_environment(site_root: Option<PathBuf>, gateway: &'a mut NativeMcpGateway) -> Self {
        let mode =
            env::var("NARADA_NATIVE_PROVIDER_MODE").unwrap_or_else(|_| "unavailable".to_string());
        let max_tool_rounds = env::var("NARADA_MAX_TOOL_ROUNDS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(200)
            .clamp(1, 500);
        Self {
            mode,
            site_root,
            gateway,
            max_tool_rounds,
            session_id: env::var("NARADA_NARS_SESSION_ID").ok(),
        }
    }

    pub fn with_session_context(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }
    fn emit(
        sink: &mut dyn FnMut(Value) -> Result<(), CoreError>,
        event: Value,
    ) -> Result<(), CoreError> {
        sink(event)
    }

    fn simple_outcome(
        &mut self,
        input: &Value,
        sink: &mut dyn FnMut(Value) -> Result<(), CoreError>,
    ) -> Result<ProviderOutcome, CoreError> {
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mode = self.mode.to_ascii_lowercase();
        match mode.as_str() {
            "echo" => Ok(ProviderOutcome::Completed(format!(
                "native-rust: {content}"
            ))),
            "refused" => Ok(ProviderOutcome::Refused(
                "native_provider_adapter_refused".to_string(),
            )),
            "failed" => Ok(ProviderOutcome::Failed(
                "native_provider_adapter_failed".to_string(),
            )),
            "error" => Ok(ProviderOutcome::Error(
                "native_provider_adapter_error".to_string(),
            )),
            "interrupted" => Ok(ProviderOutcome::Interrupted(
                "native_provider_adapter_interrupted".to_string(),
            )),
            "codex" | "codex-subscription" | "codex_subscription" => {
                let max_rounds = max_tool_rounds(input, self.max_tool_rounds);
                self.codex_turn(provider_prompt(input, &content), input, sink, max_rounds)
            }
            _ => Ok(ProviderOutcome::Blocked(
                "native_provider_adapter_unavailable".to_string(),
            )),
        }
    }

    fn invocation_scope(&self) -> Value {
        json!({
            "kind": "narada_runtime_session",
            "runtime_session_id": self.session_id.clone().unwrap_or_else(|| "native-runtime".to_string()),
        })
    }

    fn emit_invocation_state(
        &self,
        sink: &mut dyn FnMut(Value) -> Result<(), CoreError>,
        invocation_id: &str,
        turn_id: Option<&str>,
        previous: Option<&str>,
        state: &str,
        extra: Value,
    ) -> Result<(), CoreError> {
        let mut event = json!({
            "event": "provider_invocation_state_transition",
            "kind": "provider_invocation_state_transition",
            "schema": "narada.nars.provider_invocation_state.v2",
            "invocation_id": invocation_id,
            "turn_id": turn_id,
            "input_event_id": turn_id,
            "provider": "codex-subscription",
            "adapter_kind": "codex-subscription",
            "transport": "codex_subprocess",
            "invocation_scope": self.invocation_scope(),
            "previous_state": previous,
            "next_state": state,
            "invocation_state": state,
        });
        if let Some(values) = extra.as_object() {
            if let Some(target) = event.as_object_mut() {
                for (key, value) in values {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        Self::emit(sink, event)
    }
    fn codex_turn(
        &mut self,
        mut prompt: String,
        input: &Value,
        sink: &mut dyn FnMut(Value) -> Result<(), CoreError>,
        max_rounds: usize,
    ) -> Result<ProviderOutcome, CoreError> {
        let turn_id = input.get("event_id").and_then(Value::as_str);
        for round in 0..max_rounds {
            let invocation_id = format!(
                "provider-invocation:{}:{}",
                turn_id.unwrap_or("turn"),
                round + 1
            );
            let started = Instant::now();
            self.emit_invocation_state(
                sink,
                &invocation_id,
                turn_id,
                None,
                "requested",
                json!({}),
            )?;
            self.emit_invocation_state(
                sink,
                &invocation_id,
                turn_id,
                Some("requested"),
                "validated",
                json!({}),
            )?;
            self.emit_invocation_state(
                sink,
                &invocation_id,
                turn_id,
                Some("validated"),
                "shaped",
                json!({}),
            )?;
            self.emit_invocation_state(
                sink,
                &invocation_id,
                turn_id,
                Some("shaped"),
                "dispatched",
                json!({}),
            )?;
            self.emit_invocation_state(
                sink,
                &invocation_id,
                turn_id,
                Some("dispatched"),
                "admitting",
                json!({}),
            )?;
            self.emit_invocation_state(sink, &invocation_id, turn_id, Some("admitting"), "admitted", json!({
                "admission": {"admitted": true, "reason": "native_provider_subprocess_admitted"},
            }))?;
            let (response, provider_session_id) = match self.invoke_codex(&prompt) {
                Ok(response) => response,
                Err(error) => {
                    self.emit_invocation_state(
                        sink,
                        &invocation_id,
                        turn_id,
                        Some("admitted"),
                        "failed",
                        json!({
                            "error": {"code": "provider-process-failed", "message": error},
                        }),
                    )?;
                    return Ok(ProviderOutcome::Failed(error));
                }
            };
            self.emit_invocation_state(
                sink,
                &invocation_id,
                turn_id,
                Some("admitted"),
                "receiving",
                json!({
                    "latency_ms": started.elapsed().as_millis(),
                    "provider_session_id": provider_session_id,
                }),
            )?;
            let tool_calls = parse_tool_calls(&response);
            if !tool_calls.is_empty() {
                self.emit_invocation_state(
                    sink,
                    &invocation_id,
                    turn_id,
                    Some("receiving"),
                    "completed",
                    json!({
                        "result_kind": "tool_call",
                        "tool_call_count": tool_calls.len(),
                    }),
                )?;
                for (call_index, call) in tool_calls.iter().enumerate() {
                    let tool_name = call.get("name").and_then(Value::as_str).unwrap_or_default();
                    let arguments = call.get("arguments").cloned().unwrap_or_else(|| json!({}));
                    let tool_call_id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            format!(
                                "narada_tool_{}_{}",
                                turn_id.unwrap_or("turn"),
                                round + call_index + 1
                            )
                        });
                    Self::emit(
                        sink,
                        json!({
                            "event": "carrier_tool_requested",
                            "kind": "carrier_tool_requested",
                            "turn_id": turn_id,
                            "input_event_id": turn_id,
                            "tool_name": tool_name,
                            "tool_call_id": tool_call_id,
                            "arguments": arguments,
                        }),
                    )?;
                    let mut gateway_sink = |event: Value| sink(event).map_err(|error| error.0);
                    let result = self
                        .gateway
                        .invoke(tool_name, arguments, turn_id, turn_id, &mut gateway_sink)
                        .map_err(CoreError)?;
                    let status = result
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("failed");
                    Self::emit(
                        sink,
                        json!({
                            "event": "carrier_tool_completed",
                            "kind": "carrier_tool_completed",
                            "turn_id": turn_id,
                            "input_event_id": turn_id,
                            "tool_name": tool_name,
                            "tool_call_id": tool_call_id,
                            "status": status,
                            "result": result,
                        }),
                    )?;
                    prompt = format!(
                        "{prompt}

Narada tool result ({tool_name}):
{}

Answer the original request using this tool result.",
                        compact(&result)
                    );
                }
                continue;
            }
            self.emit_invocation_state(
                sink,
                &invocation_id,
                turn_id,
                Some("receiving"),
                "completed",
                json!({
                    "latency_ms": started.elapsed().as_millis(),
                    "result_kind": "assistant_message",
                }),
            )?;
            return Ok(ProviderOutcome::Completed(assistant_content(&response)));
        }
        Ok(ProviderOutcome::Blocked(format!(
            "native_provider_tool_loop_limit:{max_rounds}"
        )))
    }
    fn invoke_codex(&self, prompt: &str) -> Result<(String, Option<String>), String> {
        let command = env::var("NARADA_NATIVE_CODEX_COMMAND")
            .or_else(|_| env::var("NARADA_CODEX_EXEC_COMMAND"))
            .or_else(|_| env::var("NARADA_CODEX_COMMAND"))
            .or_else(|_| env::var("CODEX_COMMAND"))
            .unwrap_or_else(|_| "codex".to_string());
        let model = env::var("NARADA_NATIVE_CODEX_MODEL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let cwd = self
            .site_root
            .as_deref()
            .unwrap_or_else(|| std::path::Path::new("."));
        // These are ordinary provider arguments.  Approval and sandbox policy
        // stays with the caller/provider configuration; the native runtime
        // never embeds a policy bypass.
        let mut args = serde_json::from_str::<Value>(
            &env::var("NARADA_CODEX_EXEC_PREFIX_ARGS").unwrap_or_default(),
        )
        .ok()
        .and_then(|value| value.as_array().cloned())
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
        args.extend([
            "exec".to_string(),
            "--json".to_string(),
            // Narada supplies the delegated run's model, sandbox, cwd, and
            // capability boundary explicitly. Loading the carrier's generated
            // MCP fleet here duplicates authority and, on Windows, can make the
            // sandbox setup payload exceed CreateProcess command-line limits.
            "--ignore-user-config".to_string(),
            // Delegated invocations have their own authority, writable-root,
            // and sandbox contract. Carrier/project exec-policy rules would
            // add a second approval boundary with different semantics.
            "--ignore-rules".to_string(),
        ]);
        let sandbox = env::var("NARADA_NATIVE_CODEX_SANDBOX")
            .ok()
            .filter(|sandbox| matches!(sandbox.as_str(), "read-only" | "workspace-write"));
        match sandbox.as_deref() {
            Some("read-only") => {
                args.extend(["--sandbox".to_string(), "read-only".to_string()]);
            }
            Some("workspace-write") => {
                args.push("--approve-for-me".to_string());
                let writable_roots = env::var("NARADA_NATIVE_CODEX_WRITABLE_ROOTS")
                    .ok()
                    .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
                    .unwrap_or_default();
                for root in writable_roots {
                    let root = root.trim();
                    if !root.is_empty() && std::path::Path::new(root) != cwd {
                        args.extend(["--add-dir".to_string(), root.to_string()]);
                    }
                }
            }
            _ => {}
        }
        if let Some(model) = model {
            args.extend(["-m".to_string(), model]);
        }
        args.extend(["-C".to_string(), cwd.to_string_lossy().to_string()]);
        if let Ok(session_id) = env::var("NARADA_NATIVE_CODEX_RESUME_SESSION_ID") {
            if !session_id.trim().is_empty() {
                args.extend(["resume".to_string(), session_id]);
            }
        }
        args.push("-".to_string());
        let mut command = Command::new(command);
        command.args(args).current_dir(cwd);
        if sandbox.as_deref() == Some("workspace-write") {
            command.env("CODEX_PERMISSION_PROFILE", ":workspace-write");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("codex_spawn_failed:{error}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|error| format!("codex_prompt_write_failed:{error}"))?;
        }
        let output = child
            .wait_with_output()
            .map_err(|error| format!("codex_wait_failed:{error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(1000)
                .collect::<String>();
            return Err(format!(
                "codex_process_failed:{}{}",
                output.status.code().unwrap_or(1),
                if stderr.is_empty() {
                    "".to_string()
                } else {
                    format!("; {stderr}")
                }
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut text = String::new();
        let mut structured: Option<Value> = None;
        let mut provider_session_id = None;
        let mut parsed = 0;
        for line in stdout.lines() {
            let clean = line.trim();
            let Ok(event) = serde_json::from_str::<Value>(clean) else {
                continue;
            };
            parsed += 1;
            if event.get("type").and_then(Value::as_str) == Some("thread.started") {
                provider_session_id = event
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            if !parse_tool_calls_value(&event).is_empty() {
                structured = Some(event.clone());
            }
            if event.get("type").and_then(Value::as_str) == Some("item.completed") {
                if let Some(item) = event.get("item") {
                    if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                        if let Some(value) = item.get("text").and_then(Value::as_str) {
                            text.push_str(value);
                        }
                    }
                }
            }
            if let Some(value) = event.get("content").and_then(Value::as_str) {
                text.push_str(value);
            }
        }
        if parsed == 0 && !stdout.trim().is_empty() {
            return Err("provider-response-invalid-jsonl".to_string());
        }
        if let Some(value) = structured {
            return serde_json::to_string(&value)
                .map(|response| (response, provider_session_id))
                .map_err(|error| format!("provider-response-encode-failed:{error}"));
        }
        Ok((text, provider_session_id))
    }
}

impl<'a> NarsProviderAdapter for NativeProviderAdapter<'a> {
    fn run_turn(&mut self, input: &Value) -> ProviderOutcome {
        let mut ignored = |_event: Value| -> Result<(), CoreError> { Ok(()) };
        self.simple_outcome(input, &mut ignored)
            .unwrap_or_else(|error| ProviderOutcome::Error(error.0))
    }

    fn run_turn_with_context(
        &mut self,
        context: ProviderTurnContext<'_>,
        event_sink: &mut dyn FnMut(Value) -> Result<(), CoreError>,
    ) -> Result<ProviderOutcome, CoreError> {
        if context.cancellation.is_cancelled() {
            return Ok(ProviderOutcome::Interrupted(
                "provider_request_cancelled".to_string(),
            ));
        }
        Self::emit(
            event_sink,
            json!({
                "event": "carrier_turn_started",
                "kind": "carrier_turn_started",
                "turn_id": context.turn_id,
                "input_event_id": context.input_event_id,
                "provider_adapter_kind": self.mode,
            }),
        )?;
        let outcome = self.simple_outcome(context.input, event_sink)?;
        match &outcome {
            ProviderOutcome::Completed(_) => {}
            ProviderOutcome::Blocked(reason) => Self::emit(
                event_sink,
                json!({"event":"carrier_turn_blocked","kind":"carrier_turn_blocked","turn_id":context.turn_id,"reason":reason}),
            )?,
            ProviderOutcome::Refused(reason) => Self::emit(
                event_sink,
                json!({"event":"carrier_turn_refused","kind":"carrier_turn_refused","turn_id":context.turn_id,"reason":reason}),
            )?,
            ProviderOutcome::Failed(error) | ProviderOutcome::Error(error) => Self::emit(
                event_sink,
                json!({"event":"carrier_turn_failed","kind":"carrier_turn_failed","turn_id":context.turn_id,"error":error}),
            )?,
            ProviderOutcome::Interrupted(reason) => Self::emit(
                event_sink,
                json!({"event":"carrier_turn_interrupted","kind":"carrier_turn_interrupted","turn_id":context.turn_id,"reason":reason}),
            )?,
        }
        Ok(outcome)
    }
}

fn max_tool_rounds(input: &Value, fallback: usize) -> usize {
    input
        .get("execution_policy")
        .and_then(|value| value.get("tool_loop"))
        .and_then(|value| value.get("max_rounds"))
        .and_then(Value::as_u64)
        .map(|value| (value as usize).clamp(1, 500))
        .unwrap_or(fallback.clamp(1, 500))
}

fn provider_prompt(input: &Value, fallback: &str) -> String {
    let Some(messages) = input.get("provider_messages").and_then(Value::as_array) else {
        return fallback.to_string();
    };
    if messages.is_empty() {
        return fallback.to_string();
    }
    let mut prompt = String::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let content = prompt_content(message.get("content"));
        if content.is_empty() {
            continue;
        }
        prompt.push_str("[");
        prompt.push_str(role);
        prompt.push_str("]\n");
        prompt.push_str(&content);
        prompt.push_str("\n\n");
    }
    if prompt.trim().is_empty() {
        fallback.to_string()
    } else {
        prompt
    }
}

fn prompt_content(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::String(text) => text.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| prompt_content(Some(value)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => object
            .get("text")
            .or_else(|| object.get("content"))
            .map(|value| prompt_content(Some(value)))
            .unwrap_or_else(|| compact(value)),
        _ => value.to_string(),
    }
}

fn parse_tool_calls(content: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(content.trim())
        .map(|value| parse_tool_calls_value(&value))
        .unwrap_or_default()
}

fn parse_tool_calls_value(value: &Value) -> Vec<Value> {
    if let Some(call) = value.get("narada_tool_call") {
        return normalize_tool_call(call).into_iter().collect();
    }
    let calls = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("tool_calls"))
        .or_else(|| value.get("tool_calls"));
    calls
        .and_then(Value::as_array)
        .map(|calls| calls.iter().filter_map(normalize_tool_call).collect())
        .unwrap_or_default()
}

fn normalize_tool_call(call: &Value) -> Option<Value> {
    let function = call.get("function").unwrap_or(call);
    let name = function
        .get("name")
        .or_else(|| call.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())?
        .to_string();
    let arguments = function
        .get("arguments")
        .or_else(|| call.get("arguments"))
        .map(parse_tool_arguments_value)
        .unwrap_or_else(|| json!({}));
    let mut normalized = json!({"name": name, "arguments": arguments});
    if let Some(id) = call.get("id").and_then(Value::as_str) {
        normalized["id"] = Value::String(id.to_string());
    }
    Some(normalized)
}

fn parse_tool_arguments_value(value: &Value) -> Value {
    match value {
        Value::Object(_) => value.clone(),
        Value::String(text) if !text.trim().is_empty() => serde_json::from_str::<Value>(text)
            .ok()
            .filter(|value| value.is_object())
            .unwrap_or_else(|| json!({})),
        _ => json!({}),
    }
}

fn assistant_content(content: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(content.trim()) else {
        return content.to_string();
    };
    let candidate = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"));
    candidate
        .map(|value| prompt_content(Some(value)))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| content.to_string())
}
fn compact(value: &Value) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "<invalid-json>".to_string())
        .chars()
        .take(8000)
        .collect()
}

#[cfg(test)]
mod provider_tests {
    use super::*;

    #[test]
    fn parses_standard_and_legacy_tool_calls() {
        let standard = parse_tool_calls(
            r#"{"choices":[{"message":{"tool_calls":[{"id":"call-7","function":{"name":"read_note","arguments":"{\"path\":\"a.md\"}"}}]}}]}"#,
        );
        assert_eq!(standard.len(), 1);
        assert_eq!(standard[0]["id"], "call-7");
        assert_eq!(standard[0]["name"], "read_note");
        assert_eq!(standard[0]["arguments"]["path"], "a.md");

        let legacy = parse_tool_calls(
            r#"{"narada_tool_call":{"name":"write_note","arguments":{"path":"a.md"}}}"#,
        );
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0]["name"], "write_note");
        assert_eq!(legacy[0]["arguments"]["path"], "a.md");
    }

    #[test]
    fn projects_durable_messages_and_policy() {
        let input = json!({
            "content": "current",
            "provider_messages": [
                {"role":"user","content":"previous"},
                {"role":"assistant","content":"answer"},
                {"role":"user","content":"current"}
            ],
            "execution_policy": {"tool_loop":{"max_rounds":3}}
        });
        let prompt = provider_prompt(&input, "fallback");
        assert!(prompt.contains("[user]"));
        assert!(prompt.contains("previous"));
        assert_eq!(max_tool_rounds(&input, 200), 3);
        assert_eq!(max_tool_rounds(&json!({}), 200), 200);
    }

    #[test]
    fn extracts_assistant_content_without_losing_plain_text() {
        assert_eq!(assistant_content("plain response"), "plain response");
        assert_eq!(
            assistant_content(r#"{"choices":[{"message":{"role":"assistant","content":"done"}}]}"#),
            "done"
        );
    }
}
