# Carrier Entry Orientation Contract

This file retains its historical name, but the current contract is not a menu of
startup helpers. Carrier entry is one bounded, receipt-bound orientation
ceremony. It establishes what an admitted occupant must receive before ordinary
work can cross the Carrier boundary; it does not create Agent identity or grant
action authority.

## Occupant-facing tools

A normal occupant projection exposes exactly:

- `agent_orientation_read`
- `mcp_output_show` as shared carrier transport readback, not as a second
  orientation workflow

The occupant begins with `agent_orientation_read({})`. The response contains a
thin cognitive brief and, when more work is required, the exact next
`agent_orientation_read` call with an opaque `continuation`. Required reads,
paging, completion evidence, and final acknowledgement remain server-owned. The
occupant must not manufacture offsets, step identifiers, digests, receipts, or
completion claims.

Every orientation response must remain inline. Required-read page sizing is
transport-aware, and delivery validation runs inside the same transaction as
page/completion persistence. If the exact response cannot be delivered, no
completion evidence may commit.

Normal discovery must not expose `startup_sequence`,
`agent_context_startup_sequence`, or `agent_context_hydrate_current`. Those names
may remain callable on explicitly retained compatibility or administrative
facades, but they are not valid Carrier-entry alternatives and cannot activate
ordinary work.

## Admission and failure behavior

The Carrier runtime admits only the orientation ceremony until canonical
delivery and acknowledgement evidence matches the current Site, Agent, Carrier
Session, manifest generation, and authority epoch. Ordinary domain calls are
refused before that point. A prompt saying that orientation happened is not
evidence that it happened.

If the occupant-facing tool is absent, continuation state is invalid, a
required read cannot be completed, or acknowledgement cannot be recorded, the
carrier reports a launch-affordance defect. It must not guess state, silently
fall back to a legacy helper, or bypass the gate through native shell.

## Verification

The adjacent coherence gate checks the declared projection:

```powershell
node tools\mcp-fabric\adjacent-coherence-gate.mjs --pretty
```

`@narada-core/mcp-fabric` owns loading and carrier projection semantics. Static
declaration evidence is necessary but insufficient: acceptance also requires a
real MCP handshake, the actual orientation continuation loop, refusal of an
ordinary effect before acknowledgement, and successful performance of that
effect afterward.

The complete authority, evidence, and lifecycle model is defined in
[`Orientation Manifest`](./orientation-manifest.md).
