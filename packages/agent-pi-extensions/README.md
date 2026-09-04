# `@narada-core/agent-pi-extensions`

Narada-owned extensions for the independent Pi carrier. The package keeps
carrier workflow behavior in the Narada monorepo instead of treating a global
`~/.pi/agent/extensions` file as source code.

## Installation

Install this local Pi package for a user or project with:

```bash
pi install /absolute/path/to/narada/packages/agent-pi-extensions
```

Use `pi install -l` when the package should be recorded in project-local Pi
settings. Pi must trust the project before loading project-local resources.

## Extension

`repeat-turns.ts` provides bounded sequential repeat and issue-tree traversal
commands:

```text
/repeat <1-200> <prompt>
/repeat-then-notify <1-200> <prompt>
/traverse-issue-tree <1-200> [root objective]
/traverse-resume [1-200]
/repeat-cancel
/repeat-status
```

`/repeat-then-notify` emits one best-effort Windows terminal BEL after the
whole repeat sequence settles. It does not notify after each model/tool turn.

The extension uses the Narada MCP bridge inbox event for traversal opening and
closing polls. It does not own canonical task, graph, or identity authority.
