# Agent Context Tools

This package does **not** own the Agent Context MCP surface or session
admission. The sole registrar-bound implementation is
`@narada-core/agent-context-mcp` in the `mcp-surfaces` repository.

`src/session-start.ts` is a compatibility re-export of that canonical package.
The historical `agent-context-mcp-server.ts` path is an explicit refusal guard
for stale Site projections; it exposes no tools and performs no context
inference or materialization.

The remaining modules are Narada-local support utilities. Their presence does
not grant identity, Carrier Session, Orientation Manifest, or delivery
authority.

## Canonical startup boundary

- Carrier Session Authority issues the admission receipt.
- Agent Start adapts that exact receipt and persists one immutable Orientation
  Manifest generation.
- The canonical Agent Context surface reads that exact generation by manifest
  id.
- Diagnostic hydration may compile a candidate, but cannot replace the
  admitted generation.
- Later consequential actions require their own admission.

See `docs/concepts/orientation-manifest.md` and the canonical surface README.
