# Rust NARS runtime backend

This crate is the native runtime-engine implementation for NARS. It drives the
Rust SessionSupervisor, which owns session start, recovery, FIFO admission,
turn coordination, cancellation intent, event journaling, lifecycle/shutdown,
heartbeat/recovery projection, and SQLite session-authority lease updates.
The Rust runtime also owns MCP discovery/stdio lifecycle/tool dispatch and the
provider invocation boundary. A provider subprocess is an external provider
locus; it is never a NARS runtime and cannot acquire session or authority state.

Build it from this package with `pnpm run build:native`, or from this directory:

```text
cargo build --release
```

The launcher selects the resulting binary with `--runtime-engine rust`. The
binary also owns its conformance probes. It does not interpret
`NARADA_RUNTIME_DELEGATE`, `NARADA_RUNTIME_SERVER_SCRIPT`, or
`NARADA_RUNTIME_NODE_COMMAND`, and it never launches Node or Bun.

NARADA_NATIVE_PROVIDER_MODE=echo is a deterministic provider fixture used by
conformance tests. `codex`/`codex-subscription` defaults to the native
Codex-app-server broker supplied by the owning delegation surface. The runtime
authenticates with the per-host capability, sends explicit model, effort, cwd,
sandbox, and writable-root coordinates, and receives one fresh ephemeral
provider thread. `NARADA_NATIVE_CODEX_TRANSPORT=codex-exec` retains the old
subprocess behavior only as an explicit diagnostic fallback; it is never
selected silently. An unset provider mode remains blocked.

## Native HTTP provider binding

The native OpenAI-compatible adapter is selected only by an admitted,
secret-free binding at the path in NARADA_NATIVE_PROVIDER_BINDING_PATH:

    {
      "schema": "narada.native.provider_binding.v1",
      "provider": "openrouter-api",
      "protocol": "openai/chat-completions/1",
      "endpoint": "https://openrouter.ai/api/v1",
      "model": "deepseek/deepseek-v4-flash",
  "credential_secret_ref": "narada/provider/openrouter-api/api-key",
      "reasoning_effort": "medium"
    }

The runtime validates the provider, HTTPS host, protocol, model, and canonical
secret reference before sending a Chat Completions request. It resolves that
reference through PowerShell SecretManagement in a bounded child process; the
secret is never placed in the binding, an environment file, or caller
arguments. It does not perform automatic provider failover. The Responses API
is not implemented by this adapter.
