# `@narada-core/orientation-manifest`

Narada-owned, storage-neutral contracts for the Agent Embodiment Admission
Crossing and a pure compiler for one immutable Orientation Manifest generation.

The package owns no authority or runtime state. It cannot admit a Carrier
Session, recognize an Agent, choose a checkpoint, read a Site, deliver a
manifest, activate a runtime, or authorize a later action. It validates
owner-issued receipts and compiles caller-supplied, source-indexed projections.

## Boundary

- `./contracts` exports versioned admission, delivery, activation, projection,
  policy, residual, and manifest contracts plus strict parsers.
- `./compiler` exports deterministic assembly and exact binding validation.
- The compiler has no ambient clock or I/O. `generated_at` and every source
  observation must be supplied explicitly.
- A manifest can be `ready`, `degraded`, or `blocked`; only ready or degraded
  generations are deliverable.
- Manifest delivery and Carrier activation produce separate authority-owned
  receipts. Neither grants authority for later effects.

The governing concept is
[`docs/concepts/orientation-manifest.md`](../../docs/concepts/orientation-manifest.md).
