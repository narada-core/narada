# Orientation Manifest

## Status

This document remains a **target-shape conjecture** for the complete embodiment
crossing. Its core assembly boundary now has a canonical v0 realization in
`@narada-core/orientation-manifest`: shared receipt and manifest contracts, a
pure compiler, adversarial fixtures, and Agent Start/Agent Context adapters.

That implementation does not make the full crossing complete. Owner-issued
delivery and activation lifecycles, additional source adapters, and broader
cross-carrier acceptance remain independently falsifiable work. The name must
not imply that the compatibility Agent Context surface owns or fully realizes
the authority topology described here.

## Governing Objective

```text
Error-correctable continuity under occupant turnover.
```

A durable Agent may be embodied by different models, processes, hosts,
operators, or other replaceable intelligence substrates over time. Narada must
let a new occupant enter the work without making continuity depend on the prior
occupant's memory, while keeping errors visible and correctable.

The governing problem is therefore not "give the model more context." It is:

```text
How can a replaceable intellect inhabit one durable Agent office,
inside one bounded Narada authority topology,
without confusing orientation, identity, capability, or evidence with authority?
```

## Definition

An **Orientation Manifest** is an immutable, bounded, source-indexed projection
assembled for one admitted pairing of a durable Agent and one Carrier Session.
It tells the new occupant what office it is inhabiting, which law and
constraints apply, which entry procedures must run, what continuity and work
references are relevant, which capability surfaces are projected, which live
authority grants may be consulted, which obligations accompany the embodiment,
and which incompatibilities remain unresolved.

An Orientation Manifest is epistemic and orienting. It is not:

- the Agent identity;
- the act that admits an embodiment;
- an authority grant;
- a task claim or work-order mutation;
- a credential bundle;
- a copy of source authority;
- proof that the occupant understood the material;
- admission for any later consequential action.

## Governing Crossing

The manifest belongs to an **Agent Embodiment Admission Crossing**: the governed
crossing by which a replaceable intelligence substrate is bound into one
Carrier Session embodying one durable Agent under one Site's law.

```text
replaceable intelligence substrate
  -> arrival proposal
  -> Agent Embodiment Admission Crossing
  -> admitted Agent/Carrier Session embodiment binding
  -> admission receipt + Orientation Manifest
  -> oriented occupant
  -> later effect proposals
  -> owner-specific Carrier Action Admission crossings
```

Arrival is not admission. Embodiment admission is not general admission into
every authority zone of the Site. The Carrier remains a non-authoritative
runtime embodiment, and every consequential action must still resolve and cross
the boundary of the authority that owns the effect.

The crossing regime must identify:

1. the durable Agent being embodied;
2. the Carrier Session and runtime identity being bound;
3. the Site and applicable authority topology;
4. the source authorities consulted;
5. the required compatibility and readiness rules;
6. the admission or refusal artifact;
7. the manifest generation delivered to the occupant;
8. the evidence and acknowledgement required for entry, handoff, and closeout.

The **starting admission receipt** records the exact Agent/Carrier Session
relation and authority epoch, and supplies its authoritative readback
coordinate. A separate delivery receipt records which Orientation Manifest
generation reached the Carrier Session. The activation receipt later records
the admitted runtime binding. None substitutes for later action admission.

## Embodiment Admission Authority Decision

The authority that owns embodiment admission is the **Carrier Session
Authority selected by the Site**. Agent Context, the launcher, the Agent
identity registry, the Carrier process, the model substrate, and the PC runtime
registry are participants or evidence sources; none of them owns the admitted
relation.

The exact authority fact is:

```text
At authority epoch E, Site S admits Carrier Session C
to embody durable Agent A through Carrier kind K
under admission policy P and the recorded lifecycle state.
```

When the session becomes active, the authority additionally records:

```text
Runtime binding R was observed and admitted as the current runtime embodiment
for Carrier Session C at authority epoch E.
```

The split is:

| Participant | Owns | Does not own |
| --- | --- | --- |
| Agent identity authority | Recognition, status, role references, and the exact durable Agent revision. | Carrier Session lifecycle or runtime truth. |
| Carrier Session Authority | Session identity, admitted Agent relation, lifecycle state, authority epoch, fencing, lease/ownership, and admission/activation receipts. | Agent identity, Site law, task state, grants, or host observation. |
| Launcher | Exact admission proposal and process-start attempt. | Admission merely because it can spawn a process. |
| Runtime/host authority | Observed process, vendor-session, transport, window, or API-thread handles. | Durable Agent identity or session admission. |
| Carrier | Delivery, acknowledgement, capability projection, and session evidence. | The authority relation it embodies. |
| Orientation compiler | Pure assembly and validation over admitted coordinates and source readbacks. | Source mutation, session admission, or action admission. |
| Agent Context facade | Temporary compatibility and diagnostic projection. | Session, identity, continuity, or manifest authority. |

### Two-Phase Crossing

Embodiment admission is necessarily two-phase because a live runtime handle does
not exist before launch:

1. **Propose** exact Site, Agent identity reference, Carrier Session id, Carrier
   kind, admission policy, and launch intent. No authority fact exists yet.
2. **Reserve/admit starting** after exact Agent recognition and policy checks.
   The Carrier Session Authority issues an epoch-fenced starting receipt.
3. **Assemble and deliver orientation** only against that exact starting
   receipt. A blocked manifest prevents normal substrate handoff. Delivery emits
   its own receipt naming the exact manifest generation.
4. **Observe and activate** after the runtime/host authority supplies an exact
   runtime binding. The Carrier Session Authority admits that evidence and
   issues an activation receipt.
5. **Heartbeat, stop, close, fail, or reconcile** through the same fenced
   lifecycle. Runtime disappearance is evidence for reconciliation, not silent
   reassignment.

A starting receipt admits only the bounded launch and orientation ceremony.
Policy may withhold consequential Carrier actions until activation. Activation
still grants no task, inbox, command, publication, credential, or external
effect authority.

### Cardinality Is Policy

The authority key is the Site-scoped Carrier Session identity
`(authority_scope, site_ref, carrier_session_id)`, not the Agent identity.
Multiple Carrier Sessions may embody one Agent when explicit Site policy admits
them. A Site may choose a singleton policy for a particular runtime or role, but
that is a policy constraint rather than the definition of Agent embodiment.

This preserves Plural Embodiment, Singular Authority: embodiment may be plural
while every governed mutation still resolves to one owning authority.

### Existing Realization And Migration

`@narada-core/nars-session-authority` is the current executable precedent. It
already supplies starting/active/stopping/closed/failed states, authority epochs,
owner tokens, leases, fencing, heartbeats, reconciliation, and explicit
admission evidence. Its current principal-key singleton is a NARS policy and
must not be copied into the carrier-neutral identity key.

The target does not introduce another authority Zone. It lifts the existing
session-authority lifecycle into a carrier-neutral contract and treats NARS as
one realization. Current special cases then become projections or adapters:

- `agent_context_start_session` stops claiming session authority and becomes a
  compatibility projection or delegates to the Carrier Session Authority;
- `agent_start_events` become downstream trace events keyed to an admission
  receipt rather than the source of admission;
- Codex session admission becomes a carrier-specific runtime-evidence adapter
  for activation, not a separate authority;
- PC runtime carrier-session records remain host/runtime observations and
  restart coordinates;
- Agent Context identity resolution accepts exact environment plus admission
  readback and removes latest-checkpoint/latest-start-event identity fallback.

## Boundary Package

In human-resources language, the durable Agent is an organizational office and
the intelligence substrate is a temporary occupant. The Carrier Session is the
placement. Runtime identity binding is analogous to assigning the badge to that
placement. The Orientation Manifest is the packet handed over at entry.
Authority grants remain revocable delegations, tasks remain work orders in their
own lifecycle, and handoff remains a separate continuity act.

The analogy is explanatory, not ontological. The target boundary package should
contain typed compartments rather than one undifferentiated context blob:

| Compartment | Contents | Authority posture |
| --- | --- | --- |
| Embodiment coordinates | Manifest generation, Site, Agent, Carrier Session, runtime binding, and admission receipt references. | Identifies the admitted placement; does not create identity. |
| Office and role | Durable Agent, role, qualification, and organizational-position projections. | Readbacks from their owning sources. |
| Law and constraints | Applicable law receipts, directives, prohibitions, and invariant constraints. | Constrains the embodiment; the manifest does not author law. |
| Entry procedure | Ordered startup instructions, required readbacks, diagnostics, and recovery affordances. | Procedural projection; any mutating step still routes through its owning authority. |
| Continuity | Handoff, checkpoint, trace, prior-session, and unresolved-work references selected for this embodiment. | Orientation evidence, not a claim that prior narrative is current truth. |
| Work orientation | Relevant task, inbox, project, and workflow references. | Points to live lifecycle authorities; does not claim, activate, or close work. |
| Capability projection | Surfaces and capability families available through the Carrier. | Availability only; capability is not authority. |
| Authority references | Identifiers for live, revocable grants that an action boundary may consult. | References rather than copied rights; live enforcement remains source-owned. |
| Obligations | Evidence, confirmation, escalation, review, handoff, and closeout duties. | Conditions of the admitted embodiment. |
| Residuals | Missing, stale, contradictory, rejected, or incompatible source projections. | Explicit obstruction witnesses; never silently coerced into compatibility. |
| Negative claims | What is not bound, not known, not admitted, and not guaranteed. | Prevents inference from omission, proximity, or possession. |

## Source-Indexed Entry Grammar

Every projected entry should retain enough information to reconstruct why it
appeared and how its currency can be challenged:

| Field | Meaning |
| --- | --- |
| `entry_kind` | Stable semantic kind, not a source-specific display label. |
| `source_authority_ref` | Authority locus that owns the fact or lifecycle. |
| `artifact_ref` | Stable readback coordinate in that authority. |
| `revision` | Exact source revision, hash, sequence, or equivalent evidence. |
| `observed_at` | When the projection was read. |
| `valid_until` | Optional bounded validity horizon; absence must not imply permanence. |
| `criticality` | `required` or `optional` for this embodiment posture. |
| `projection_status` | `available`, `omitted`, `unavailable`, `stale`, `incompatible`, or `rejected`. |
| `revalidation_rule` | When the live owner must be consulted again. |
| `evidence_refs` | Receipts or traces supporting the projection and its disposition. |

The manifest may include a human-readable rendering, but the typed entries and
their provenance are the contract. Free-form prose is an explanation layer, not
the source of binding identity, rights, or constraints.

## Assembly Policy

A versioned assembly policy defines the required entry kinds, source adapters,
compatibility rules, freshness limits, rendering budgets, and omission behavior
for an embodiment posture. The compiler receives exact Site, Agent, Carrier
Session, and runtime-binding coordinates; it does not discover identity from
recency or conversational resemblance.

Selection must be deterministic and reviewable. Material enters because a named
policy selected a source-owned projection, not because a model guessed that it
looked relevant. Excluded and truncated material receives bounded omission
evidence so packet size cannot be reduced by silently hiding uncertainty.

## Readiness And Residuals

Orientation readiness is a property of manifest assembly, not action authority:

| Readiness | Meaning |
| --- | --- |
| `ready` | Every required projection is present, current enough, and compatible for entry. |
| `degraded` | Required invariants hold, but optional material is missing, stale, or unresolved. |
| `blocked` | A required projection is absent, ambiguous, stale beyond policy, or incompatible. |

Readiness must be derived from explicit policy. It must not be inferred from a
compiler completing, a file existing, or a prompt being delivered.

When projections do not compose, the result is not a best-effort merged prompt.
The manifest records the incompatible entries and the obstruction. Policy then
decides whether entry is blocked, degraded, or routed for correction.

## Lifecycle

An Orientation Manifest is an immutable generation:

```text
assembled -> deliverable | blocked
deliverable -> delivered -> acknowledged
assembled | deliverable | delivered | acknowledged -> superseded | expired
```

- Assembly reads source authorities without mutating them.
- A blocked generation is retained as repair evidence and is not represented as
  ready orientation.
- Delivery records exactly which generation reached which Carrier Session.
- Acknowledgement confirms receipt, not comprehension or competence.
- Refresh produces a new generation; it does not rewrite historical evidence.
- A new Carrier Session requires a separately bound generation, even when most
  projections are unchanged.
- Revoking a grant does not require rewriting history. Later actions revalidate
  the live grant, and a later manifest generation can project the revocation.
- Handoff and closeout produce their own evidence and do not mutate the entry
  manifest into an exit record.

## Source Ownership And Assembly

The assembler is a pure compiler and validator over source-owned readbacks. It
must not become another authority database.

Each source authority projects only the facts it owns. Those projections are
reindexed over the admitted Agent/Carrier Session coordinates and checked for
compatibility. In category-theoretic language, a successful manifest is a
compatible tuple -- a limit-like assembly over one admitted embodiment. Failed
gluing remains an explicit residual or obstruction witness.

This avoids a central-compilation bottleneck becoming a hidden authority locus:

- identity remains owned by Agent identity authority;
- runtime binding remains owned by runtime/session authority;
- law remains owned by its law source;
- tasks and inbox state remain owned by their lifecycles;
- grants remain owned and enforced by grant authorities;
- capability availability remains a Carrier projection;
- evidence remains trace evidence rather than future permission.

## Anti-Collapse Rules

- The intellect is not the Agent.
- The Carrier Session is not the Agent.
- Arrival is not embodiment admission.
- Embodiment admission is not action admission.
- Orientation is not authorization.
- A capability projection is not an authority grant.
- A grant reference is not a copied or permanent right.
- A work reference is not a task claim.
- A checkpoint or handoff is not live source truth.
- Manifest delivery is not acknowledgement.
- Acknowledgement is not comprehension, competence, consent, or correct action.
- A compatible manifest is not permission to suppress residuals.
- The assembler does not gain authority over the sources it reads.
- No `latest`, nearest-process, display-label, or conversational fallback may
  choose Agent identity, runtime binding, or continuity implicitly.
- The manifest must remain bounded; an unreviewable dump is failed orientation,
  not comprehensive orientation.
- Canonical `Context` remains the policy-pipeline concept defined by Narada
  semantics; the Orientation Manifest must not redefine it as a startup blob.

## Falsification Tests

The conjecture is refuted by any implementation in which:

1. a handoff for one Agent or Session can silently orient another;
2. a revoked grant remains effective because it was copied into a manifest;
3. listing a tool or capability is sufficient to authorize its use;
4. a task becomes claimed, activated, or closed because it appears in the packet;
5. a missing required source still yields `ready` without an explicit policy;
6. contradictory source projections are resolved by hidden precedence or prose;
7. assembly mutates any source authority;
8. a new Carrier Session reuses an old binding without explicit readback and admission;
9. the exact source revisions and admission receipt cannot be reconstructed;
10. the packet grows without a declared bound, selection rule, or omission evidence;
11. acknowledgement is presented as proof that the occupant understood or complied;
12. later effects bypass their owning authority because the embodiment was admitted.

## Implementation Direction

The desired implementation is a shared contract plus pure compilation and
validation, callable by Carrier implementations. It does not require an
independent Agent Context authority, mutable store, or permanently running
process.

Source adapters should read owner APIs and return typed, provenance-preserving
projections. The Carrier should assemble the manifest for its exact admitted
session, persist the immutable generation and delivery evidence, and render only
the bounded human-facing view needed by the occupant.

The existing Agent Context MCP may survive temporarily as a compatibility facade
or diagnostic surface. It should not remain the semantic owner of startup
context. Once callers consume the shared contract directly, the facade may
disappear without deleting a Narada authority zone, because no such authority
zone should have been created.

The current Agent Carrier launch packet is a partial predecessor. It records
important launch, environment, policy, and non-claim evidence, but it should not
be stretched into an undifferentiated authority-bearing context blob. Migration
should distinguish:

- launch mechanics and launch-result evidence;
- embodiment admission and its receipt;
- the Orientation Manifest;
- later owner-specific action admissions;
- closeout and handoff evidence.

`SessionBinding` remains the Operator Surface continuity concept. It must not be
reused as the authoritative embodiment-admission name.

## Relationship To Existing Concepts

- [`Orientation Manifest Source-Ownership Map v0`](../product/orientation-manifest-source-map.v0.md) resolves the admission owner and classifies current Agent Context fields by their target source and migration disposition.
- [`Orientation Manifest Adversarial Cases v0`](../product/fixtures/orientation-manifest/adversarial-cases.v0.json) makes the conjecture's known failure modes machine-readable.
- [`Narada Semantics`](../../SEMANTICS.md) retains the canonical meaning of `Context` inside the policy pipeline; Orientation Manifest is a bounded embodiment-entry artifact.
- [`Governed Crossing`](governed-crossing.md) supplies the boundary law: arrival is not admission, and crossing precedes consequence.
- [`Agent Carrier`](agent-carrier.md) defines the non-authoritative runtime embodiment that receives and presents the manifest.
- [`Agent Carrier Launch Packet v1`](../product/agent-carrier-launch-packet.v1.json) is the canonical exact-admission and exact-manifest launch contract.
- [`Agent Carrier Launch Packet v0`](../product/agent-carrier-launch-packet.v0.json) is the superseded partial predecessor retained to make the rejected hydrate/latest startup shape inspectable.
- [`Agent Identity Object`](../product/agent-identity.v0.md) defines the durable office being embodied.
- [`Runtime Identity Binding`](runtime-identity-binding.md) binds volatile runtime evidence to durable identity coordinates.
- [`AuthorityGrant`](authority-grant.md) defines the live, revocable authority that the manifest may reference but never copy or create.
- [`Carrier Action Admission Boundary`](carrier-action-admission-boundary.md) governs every later consequential proposal.
- [`Plural Embodiment, Singular Authority`](plural-embodiment-singular-authority.md) prevents occupant or Carrier plurality from multiplying authority.
- [`Operator Surface`](operator-surface.md) defines `SessionBinding` as continuity evidence rather than embodiment admission.
- [`Authority-Revealing Inversion`](authority-revealing-inversion.md) requires the manifest to remain a projection of explicit owners and crossings rather than an artifact-first authority substitute.
