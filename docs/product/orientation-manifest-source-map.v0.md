# Orientation Manifest Source-Ownership Map v0

## Status And Scope

This source map originally resolved ownership before the
[`Orientation Manifest`](../concepts/orientation-manifest.md) v0 contracts and
compiler existed. It now remains the migration and falsification map for that
implemented core: source adapters and lifecycle owners must converge on these
decisions rather than preserve old behavior under new names.

The implementation snapshot is 2026-08-08 and covers:

- Narada Agent Carrier, Agent Identity, launcher, Carrier Session, NARS session
  authority, checkpoint, task, capability, and host/runtime contracts;
- the canonical `@narada-core/agent-context-mcp` implementation in the
  `mcp-surfaces` repository;
- the compatibility Agent Context packages still present in Narada proper.

This document changes no runtime authority. It classifies current fields so
adapter migration cannot preserve incoherence by merely renaming them.

## Resolved Authority Decision

The **Site-selected Carrier Session Authority** owns the admitted relation
between one Carrier Session and one durable Agent. It owns session lifecycle,
authority epoch, fencing, lease/ownership, and admission/activation receipts.

It consumes but does not own:

- exact Agent recognition from Agent identity authority;
- Site identity and policy from Site authority;
- runtime-handle observation from the runtime/host authority;
- Carrier kind and launch proposal from the launcher;
- orientation compatibility from the pure manifest compiler.

`@narada-core/nars-session-authority` is the current executable precedent, not
the universal contract. Its lifecycle mechanics should be lifted into a
carrier-neutral contract. Its one-active-NARS-session-per-principal rule remains
a selectable policy; the generic authority key is
`(authority_scope, site_ref, carrier_session_id)`.

The fact created at starting admission is:

```text
Site S admits Carrier Session C to attempt embodiment of Agent A
under policy P at authority epoch E.
```

The additional fact created at activation is:

```text
Runtime binding R is admitted as the current runtime embodiment
of Carrier Session C at authority epoch E.
```

Agent Context owns neither fact.

## Disposition Vocabulary

| Disposition | Meaning |
| --- | --- |
| `retain_reference` | Keep a typed reference and provenance to the owning source. |
| `reproject` | Keep the information, but rebuild it from the named owner. |
| `compatibility_trace` | Retain only as historical or migration evidence. |
| `move_to_owner` | Current Agent Context state belongs in another authority lifecycle. |
| `residual` | Preserve an explicit absence, conflict, staleness, or ambiguity witness. |
| `remove` | No target semantic role; do not carry it forward. |

## Target Compartment Ownership

| Manifest compartment | Source authority and readback | Freshness/revalidation | Current Agent Context posture | Target disposition |
| --- | --- | --- | --- | --- |
| Embodiment coordinates | Carrier Session Authority admission receipt, Agent identity revision, exact Site reference, and admitted runtime-binding reference. | Session epoch and state must match at delivery; runtime binding must be revalidated at activation and after restart. | Start events contain identity/runtime strings but no Carrier Session id, authority epoch, owner fencing, or runtime binding. | `move_to_owner`; project receipt references only. |
| Office and durable identity | Site-recognized Agent Identity record. | Exact revision at admission; status rechecked when policy requires. | `NARADA_AGENT_ID`, task roster, static roster, and identity-suffix inference are treated as interchangeable. | `reproject`; inference becomes `residual`. |
| Role and qualification | Agent Identity role bindings, roster projection, and qualification authority. | Revision-pinned for orientation; live qualification checked at action admission. | Role may be inferred from the identity suffix; qualification is absent. | `reproject`; inferred role is non-authoritative residual only. |
| Law and constraints | Site law and law-receipt authority, with exact source revisions or hashes. | Revalidate on law revision, expiry, or policy trigger. | Startup material contains hard-coded constraint prose and an `AGENTS.md` path without a law receipt. | `reproject`; prose without source ownership is removed or residualized. |
| Entry procedure | Versioned Carrier launch contract plus versioned Orientation Manifest assembly policy. | Pin procedure and policy revisions to the manifest generation. | Startup sequence is a self-referential call to `agent_context_startup_sequence`; no policy revision is named. | `move_to_owner` and `reproject`. |
| Continuity | Exact checkpoint/continuation authority and verified artifact references selected by explicit handoff or assembly policy. | Exact checkpoint id and content hash; no ambient latest fallback. | Current or latest checkpoint plus optional portable Markdown continuation. | `retain_reference` only when exactly selected and verified; otherwise `residual`. |
| Work orientation | Task lifecycle, inbox, project, and workflow authority read APIs. | Read at assembly and again before mutation; work references never imply a claim. | Checkpoint narrative supplies `active_task` and `next_intended_action`; older bootstrap code queries task SQLite directly. | `reproject` from owner APIs; checkpoint claims are advisory continuity. |
| Capability projection | Carrier launch policy and MCP fabric/compiler projection for the exact session. | Revalidate after surface generation, policy, or Carrier posture changes. | Roster capabilities and role-derived capability policy are returned; execution-context traces scan MCP config files. | `reproject`; roster capability names are not grants or live availability. |
| Authority references | Capability/authority grant registry and qualification authorities. | Always revalidate at consequential action admission. | No live grant references; role-derived policy says MCP shell is allowed. | `reproject`; copied permissions are forbidden. |
| Obligations | Site law, role contract, admission policy, work authority, evidence policy, and closeout/handoff contracts. | Revalidate when source revisions change; record exact obligation refs. | Scattered prose, checkpoint fields, and hard-coded startup guidance. | `reproject` as typed references; ownerless prose is removed. |
| Residuals | Pure Orientation Manifest compiler over source adapter results. | Immutable in one generation; corrected only by a new generation. | Some checkpoint/continuation errors are explicit, while identity and source conflicts often fall back. | `retain_reference` and normalize; fallback becomes residual or block. |
| Negative claims | Versioned assembly policy plus source-specific non-claims. | Pin to manifest generation and Carrier posture. | Launch packet has `not_claimed`; Agent Context hydration does not. | `reproject` into every generation. |

## Required Source Adapter Boundary

Every adapter is read-only and returns typed projections or typed residuals. A
minimal adapter result must carry:

```text
source_authority_ref
artifact_ref
revision
observed_at
valid_until?
projection_status
revalidation_rule
evidence_refs
```

Adapters receive exact Site, Agent, Carrier Session, admission receipt, and
assembly-policy coordinates. They must not discover identity, choose a session,
or mutate their source while assembling orientation.

## Current Canonical Agent Context Field Map

The canonical live implementation is
`mcp-surfaces/packages/agent-context-mcp`. Narada proper still contains
compatibility shims and older hydration helpers; those do not supersede the
canonical surface.

### `agent_context_start_session`

| Current field or behavior | Actual source today | Target owner/disposition | Reason |
| --- | --- | --- | --- |
| `schema`, `status` | Agent Context response envelope. | `compatibility_trace`. | Envelope metadata is not domain authority. |
| `agent_start_event` | New row in Agent Context SQLite. | `compatibility_trace`, keyed to Carrier Session admission receipt. | A start trace may record admission but cannot create it. |
| `identity` | Caller argument, checked against task roster/static roster or accepted by inference. | Agent identity authority; `reproject`. | Caller possession and suffix shape are not identity recognition. |
| `role`, `role_binding` | Task-lifecycle roster, static roster, or identity-suffix inference. | Agent identity/roster authority; `reproject`. Inference becomes `residual`. | Role is a source-owned binding, not a naming convention. |
| `capabilities` | String array from roster. | Capability projection owner; `reproject` or remove. | Roster metadata is neither live availability nor authority. |
| `capability_policy` | Static role-derived defaults created inside Agent Context. | Site/Carrier policy owner; `move_to_owner`. | Agent Context cannot grant MCP or shell posture by constructing prose. |
| `runtime`, `cwd` | Caller arguments. | Launcher and runtime/host evidence; `reproject`. | Requested runtime and directory are proposal data until observed/admitted. |
| `db_path` | Agent Context process configuration. | Diagnostic-only; `remove` from occupant orientation. | Storage location is not semantic context. |
| `resume_command` | String synthesized from runtime plus identity. | Carrier continuity/entry-procedure projection; `reproject`. | It lacks exact Carrier Session and runtime binding evidence. |
| `required_environment` | Agent Context-generated `NARADA_AGENT_ID` and start-event id. | Carrier launch projection derived from admission receipt; `move_to_owner`. | Environment transports a binding; it cannot create one. |
| `startup_sequence` | One self-referential call to `agent_context_startup_sequence`. | Versioned entry procedure; `replace`. | The current sequence names a facade but no source policy or ordered obligations. |
| `execution_context_materialization` | Expiring Agent Context SQLite payload. | `compatibility_trace`; split into source-owned projections. | It mixes launch proposal, MCP file scan, identity strings, and policy prose. |
| `intelligence_context_materialization` | Expiring hard-coded evaluation/work-frame payload. | `remove`, except independently source-owned typed entries. | Generated diagnosis is not law, identity, continuity, or authority. |
| `proposal_id` | Pending Agent Context evaluation proposal. | `remove` from embodiment admission. | A generic evaluation proposal has no role in session authority. |
| `expires_at` | Shared one-hour expiry for context materializations. | Per-entry validity plus session lifecycle; `reproject`. | Different authorities have different freshness and revocation semantics. |
| `l1_bootstrap_summary` | Fold over Agent Context checkpoints. | Exact continuity adapter; `reproject`. | A summary is useful only with checkpoint identity, revision, and selection evidence. |

### `agent_context_hydrate_current` And `agent_context_startup_sequence`

| Current field or behavior | Actual source today | Target owner/disposition | Reason |
| --- | --- | --- | --- |
| Implicit identity selection | `NARADA_AGENT_ID`, then `whoami`. | Exact Carrier Session admission readback only. | Startup may not choose identity from ambient history. |
| `whoami.identity` | Environment, else latest checkpoint, else latest start event. | Agent identity plus Carrier Session Authority; `reproject`. | Both latest fallbacks can bind the wrong occupant. |
| `whoami.role` | Roster validation or identity inference. | Identity/roster projection; inference is `residual`. | Role inference cannot make a blocked admission ready. |
| `site_id`, `site_root` | Surface process arguments/configuration. | Exact Site authority reference and revision. | Process configuration is evidence, not Site recognition. |
| `hydrated_at` | Compiler clock. | Manifest `generated_at`; retain as evidence. | Timestamp is useful but carries no authority. |
| `checkpoint` | Agent Context current checkpoint or exact archived checkpoint. | Continuity authority projection. | Exact selection is admissible; ambient latest selection is not. |
| `portable_continuation` | Checkpoint-linked Markdown with path/hash checks. | Continuity projection; `retain_reference` when exact and verified. | Portable rendering remains evidence, not a second authority. |
| `startup_checkpoint` | Optional checkpoint mutation performed during hydration. | `remove` from compiler path. | Orientation assembly must be read-only; acknowledgement needs a separate evidence command. |
| `next_required_action` | Checkpoint narrative `next_intended_action`. | Rename as advisory continuity or replace with live work-owner readback. | Historical intent is not a current obligation or task state. |
| `checkpoint_not_found` and stale continuation states | Agent Context readback. | Typed manifest residuals. | Explicit absence is correct and must never trigger latest fallback. |

### Older Bootstrap Synthesis

| Current layer | Current source | Target disposition |
| --- | --- | --- |
| `layer_0_invariant` | Path to `AGENTS.md` with no receipt or revision. | Law adapter with exact hash/revision and receipt, or blocked residual. |
| `layer_1_residue` | Five latest checkpoint events by Agent. | Explicitly selected, bounded continuity references; no ambient recency authority. |
| `layer_2_active_work` | Direct query of task-lifecycle SQLite. | Task lifecycle read API projection with source revision and freshness. |
| `layer_3_ephemeral` | Unstructured session-only note. | Remove or represent through a declared Carrier-local non-authoritative entry kind. |

## Existing Special Cases Reclassified

| Current construct | Target classification |
| --- | --- |
| `@narada-core/nars-session-authority` | Executable lifecycle precedent and NARS realization of the carrier-neutral Carrier Session Authority; its principal-key singleton is policy, not the generic authority key. |
| Agent-start NARS authority admission | Correct ordering precedent: validate, reserve/fence, then create Agent Context trace and spawn. Generalize across carriers. |
| PC runtime `carrier_session.v0` record | Runtime/host observation, restart coordinate, and projection. It is not the admission owner. |
| Codex `codex_session_admissions` table | Carrier-specific runtime-evidence adapter. Its exact Codex session id/file can support activation but should not create a separate admission authority. |
| Agent Context `agent_start_events` | Compatibility event log downstream of Carrier Session Authority receipts. |
| Agent Context `proposal_records` and intelligence-context payload | Historical experimentation/diagnostic material, not Orientation Manifest inputs unless another named authority owns a typed entry. |
| `agent-context-memory` descriptor package | Useful non-mutating contract precedent; fold valid descriptors into the shared Orientation Manifest contract rather than preserve a parallel ontology. |

## Immediate Semantic Consequences

1. No Orientation Manifest is deliverable without an exact Carrier Session
   starting-admission receipt.
2. Agent Context may not infer identity from the latest checkpoint, latest start
   event, process title, transcript label, or conversational claim.
3. Orientation assembly is read-only. A receipt, checkpoint, acknowledgement,
   or handoff mutation is a separate governed command.
4. Role inference, roster capability strings, and generated capability policy
   can never unblock admission or authorize an action.
5. Continuity defaults must be policy-selected and subject-bound. Exact handoff
   references are preferred; absence remains explicit.
6. Task, inbox, grant, qualification, and runtime state are read through owner
   APIs or owner-issued readback artifacts, not arbitrary cross-database queries.
7. Free-form intelligence-context diagnosis is not silently promoted into law,
   constraint, residual, or work obligation.
8. Carrier-specific evidence adapters may vary, but every successful activation
   resolves to the same Carrier Session Authority relation and receipt shape.

## Falsification Corpus

The machine-readable
[`Orientation Manifest Adversarial Cases v0`](fixtures/orientation-manifest/adversarial-cases.v0.json)
exercises the authority decision, source map, readiness distinctions, explicit
residuals, packet bounds, and action-time grant revalidation. It began as a
precontract corpus. The v0 compiler and boundary-adapter tests now account for
each case at its owning boundary; later revisions must extend that corpus rather
than replace it with easier happy-path examples.
