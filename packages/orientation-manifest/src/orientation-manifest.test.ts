import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CARRIER_SESSION_ACTIVATION_RECEIPT_SCHEMA,
  CARRIER_SESSION_ACTIVATION_RECEIPT_JSON_SCHEMA,
  CARRIER_SESSION_ADMISSION_RECEIPT_JSON_SCHEMA,
  CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
  CARRIER_SESSION_ORIENTATION_DELIVERY_RECEIPT_JSON_SCHEMA,
  ORIENTATION_ACKNOWLEDGEMENT_JSON_SCHEMA,
  ORIENTATION_ASSEMBLY_POLICY_SCHEMA,
  ORIENTATION_BRIEF_JSON_SCHEMA,
  ORIENTATION_COMPILATION_RESULT_JSON_SCHEMA,
  ORIENTATION_MANIFEST_JSON_SCHEMA,
  OrientationContractError,
  parseCarrierSessionActivationReceipt,
  parseCarrierSessionAdmissionReceipt,
  parseCarrierSessionOrientationDeliveryReceipt,
  parseOrientationCompilationResult,
  parseOrientationManifest,
  parseOrientationProjectionEntry,
  type CarrierSessionActivationReceipt,
  type CarrierSessionAdmissionReceipt,
  type OrientationAssemblyPolicy,
  type OrientationCompartment,
  type OrientationProjectionEntry,
} from './contracts.js';
import {
  assertManifestBoundToAdmission,
  assertOrientationManifestIntegrity,
  compileOrientationManifest,
} from './compiler.js';
import {
  buildOrientationBrief,
  buildOrientationOccupantBrief,
  buildOrientationReadyProjection,
  issueCarrierSessionOrientationAcknowledgement,
  issueCarrierSessionOrientationDeliveryReceipt,
} from './ceremony.js';

const NOW = '2026-08-08T12:00:00.000Z';
const SITE_REF = 'site:narada';
const AGENT_REF = 'agent:narada:narada.builder@17';
const SESSION_ID = 'carrier_builder_1';

function admission(overrides: Record<string, unknown> = {}): CarrierSessionAdmissionReceipt {
  return {
    schema: CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
    receipt_id: 'carrier-admission:' + SESSION_ID + ':4',
    decision: 'admitted',
    state: 'starting',
    coordinate: {
      authority_scope: 'local-site',
      site_ref: SITE_REF,
      carrier_session_id: SESSION_ID,
      authority_epoch: 4,
    },
    agent_identity: {
      source_authority_ref: 'agent-identity:narada',
      artifact_ref: AGENT_REF,
      revision: '17',
      local_agent_id: 'narada.builder',
      canonical_agent_id: 'narada.builder',
    },
    carrier_kind: 'codex',
    admission_policy: {
      source_authority_ref: 'site-law:narada',
      artifact_ref: 'carrier-session-policy:builder',
      revision: '3',
    },
    issued_at: '2026-08-08T11:59:00.000Z',
    valid_until: '2026-08-08T13:00:00.000Z',
    authority_readback_ref: 'carrier-session-authority:' + SESSION_ID,
    evidence_refs: ['agent-recognition:builder:17'],
    reason_codes: [],
    ...overrides,
  } as CarrierSessionAdmissionReceipt;
}

function policy(overrides: Partial<OrientationAssemblyPolicy> = {}): OrientationAssemblyPolicy {
  return {
    schema: ORIENTATION_ASSEMBLY_POLICY_SCHEMA,
    policy_ref: 'orientation-policy:builder',
    revision: '3',
    required_entry_kinds: ['agent_identity', 'site_law', 'entry_procedure'],
    max_entries: 24,
    max_rendered_bytes: 65_536,
    max_manifest_bytes: 262_144,
    continuity_selection: 'exact_or_omitted',
    optional_entry_behavior: 'degrade',
    negative_claims: [
      {
        claim_id: 'orientation_is_not_authorization',
        statement: 'Orientation does not authorize a later action.',
      },
      {
        claim_id: 'capability_is_not_authority',
        statement: 'A projected capability is not an authority grant.',
      },
    ],
    ...overrides,
  };
}

function projection(
  entryKind: string,
  compartment: OrientationCompartment,
  overrides: Partial<OrientationProjectionEntry> = {},
): OrientationProjectionEntry {
  return {
    entry_id: 'entry:' + entryKind,
    compartment,
    entry_kind: entryKind,
    subject: {
      site_ref: SITE_REF,
      agent_ref: AGENT_REF,
      carrier_session_id: SESSION_ID,
    },
    source_authority_ref: 'authority:' + entryKind,
    artifact_ref: 'artifact:' + entryKind,
    revision: '1',
    observed_at: '2026-08-08T11:59:30.000Z',
    valid_until: null,
    criticality: 'required',
    projection_status: 'available',
    revalidation_rule: 'on_source_revision',
    evidence_refs: ['evidence:' + entryKind],
    payload: { value: entryKind },
    rendered_text: entryKind,
    ...overrides,
  };
}

function requiredProjections(): OrientationProjectionEntry[] {
  return [
    projection('agent_identity', 'office_and_role'),
    projection('site_law', 'law_and_constraints'),
    projection('entry_procedure', 'entry_procedure'),
  ];
}

function activation(
  overrides: Record<string, unknown> = {},
): CarrierSessionActivationReceipt {
  return {
    schema: CARRIER_SESSION_ACTIVATION_RECEIPT_SCHEMA,
    receipt_id: 'carrier-activation:' + SESSION_ID + ':4',
    decision: 'activated',
    state: 'active',
    coordinate: admission().coordinate,
    admission_receipt_ref: admission().receipt_id,
    runtime_binding: {
      source_authority_ref: 'runtime-host:windows',
      artifact_ref: 'runtime:codex:exact-1',
      revision: '1',
      owning_site_ref: SITE_REF,
      observed_at: NOW,
    },
    issued_at: NOW,
    authority_readback_ref: 'carrier-session-authority:' + SESSION_ID,
    evidence_refs: ['runtime-observation:exact-1'],
    reason_codes: [],
    ...overrides,
  } as CarrierSessionActivationReceipt;
}

test('receipt contracts require exact, coherent admission, delivery, and activation evidence', () => {
  const parsed = parseCarrierSessionAdmissionReceipt(admission());
  assert.equal(parsed.decision, 'admitted');
  assert.equal(parsed.coordinate.authority_epoch, 4);
  assert.equal(Object.isFrozen(parsed), true);

  assert.throws(
    () => parseCarrierSessionAdmissionReceipt({
      ...admission(),
      decision: 'admitted',
      state: 'refused',
    }),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'admission_state_mismatch',
  );

  assert.throws(
    () => parseCarrierSessionAdmissionReceipt({
      ...admission(),
      valid_until: '2026-08-08T11:58:59.000Z',
    }),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'admission_validity_interval_invalid',
  );
  assert.throws(
    () => parseCarrierSessionAdmissionReceipt({
      ...admission(),
      coordinate: {
        ...admission().coordinate,
        authority_epoch: Number.MAX_SAFE_INTEGER + 1,
      },
    }),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'positive_integer_required',
  );
  assert.throws(
    () => parseOrientationProjectionEntry(projection('site_law', 'law_and_constraints', {
      observed_at: '2026-08-08T12:00:00.000Z',
      valid_until: '2026-08-08T11:59:59.000Z',
    })),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'projection_validity_interval_invalid',
  );

  assert.throws(
    () => parseCarrierSessionActivationReceipt({
      ...activation(),
      runtime_binding: null,
    }),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'activation_evidence_required',
  );

  assert.throws(
    () => parseCarrierSessionOrientationDeliveryReceipt({
      schema: 'narada.carrier_session.orientation_delivery_receipt.v1',
      receipt_id: 'delivery:1',
      status: 'delivered',
      coordinate: admission().coordinate,
      admission_receipt_ref: admission().receipt_id,
      manifest_id: null,
      manifest_digest: null,
      brief_id: null,
      brief_digest: null,
      delivery_mode: null,
      ordinary_work_gate: null,
      delivered_at: null,
      authority_readback_ref: 'carrier-delivery:1',
      evidence_refs: [],
      reason_codes: [],
    }),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'delivery_evidence_required',
  );
});

test('exported receipt schemas use carrier-portable JSON Schema nullability', () => {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    assert.equal(
      Array.isArray(record.type),
      false,
      'JSON Schema type arrays are rejected by Moonshot/Kimi carriers',
    );
    if (Array.isArray(record.anyOf)) {
      assert.equal(
        Object.hasOwn(record, 'type'),
        false,
        'Moonshot/Kimi requires each anyOf branch to declare its own type',
      );
    }
    for (const child of Object.values(record)) visit(child);
  };

  for (const schema of [
    CARRIER_SESSION_ADMISSION_RECEIPT_JSON_SCHEMA,
    CARRIER_SESSION_ACTIVATION_RECEIPT_JSON_SCHEMA,
    CARRIER_SESSION_ORIENTATION_DELIVERY_RECEIPT_JSON_SCHEMA,
    ORIENTATION_BRIEF_JSON_SCHEMA,
    ORIENTATION_ACKNOWLEDGEMENT_JSON_SCHEMA,
    ORIENTATION_MANIFEST_JSON_SCHEMA,
    ORIENTATION_COMPILATION_RESULT_JSON_SCHEMA,
  ]) {
    visit(schema);
  }
});

test('bounded brief, delivery, required-read evidence, and acknowledgement form one exact ceremony', () => {
  const requiredRead = {
    step_id: 'read:agents:1',
    ordinal: 1,
    required: true,
    source: {
      source_authority_ref: 'site-law:narada',
      artifact_ref: 'C:/site/AGENTS.md',
      revision: 'agents-sha256',
    },
    tool: {
      name: 'fs_read_file_range',
      arguments: {
        path: 'C:/site/AGENTS.md',
        start_line: 1,
        end_line: 120,
      },
    },
    completion: {
      kind: 'tool_result_fields',
      expected_result: {
        content_sha256: 'agents-sha256',
        offset: 0,
      },
      evidence_fields: ['content_sha256', 'offset', 'returned_lines'],
    },
  };
  const projections = requiredProjections().map((entry) => (
    entry.entry_kind === 'entry_procedure'
      ? {
          ...entry,
          payload: {
            required_reads: [requiredRead],
            steps: ['complete_required_reads', 'acknowledge_orientation'],
          },
        }
      : entry
  ));
  const compilation = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy(),
    projections,
    generated_at: NOW,
  });
  const brief = buildOrientationBrief({
    manifest: compilation.manifest,
    manifestArtifactRef: 'agent-context:orientation-manifests:exact',
  });
  assert.equal(brief.inline_bytes <= 3_072, true);
  assert.equal(brief.required_reads.length, 1);
  assert.equal(brief.continuity_selection.mode, 'omitted');
  assert.equal(brief.work_selection.mode, 'omitted');
  const occupantBrief = buildOrientationOccupantBrief(brief);
  assert.equal(occupantBrief.schema, 'narada.orientation_occupant_brief.v1');
  assert.equal(occupantBrief.position.local_agent_id, 'narada.builder');
  assert.equal(occupantBrief.manifest_readiness, 'ready');
  assert.equal('readiness' in occupantBrief, false);
  assert.equal(occupantBrief.required_reads.length, 1);
  assert.equal('brief_id' in occupantBrief, false);
  assert.equal('brief_digest' in occupantBrief, false);
  assert.equal('manifest_ref' in occupantBrief, false);
  assert.equal('negative_claims' in occupantBrief, false);
  assert.equal('completion' in occupantBrief.required_reads[0], false);
  const readyProjection = buildOrientationReadyProjection(brief);
  assert.equal(readyProjection.schema, 'narada.orientation_ready_projection.v1');
  assert.equal(readyProjection.orientation_status, 'acknowledged');
  assert.equal(readyProjection.next_meaningful_call, null);
  assert.equal('required_reads' in readyProjection, false);

  const delivery = issueCarrierSessionOrientationDeliveryReceipt({
    admissionReceipt: admission(),
    brief,
    deliveredAt: NOW,
  });
  assert.equal(delivery.status, 'delivered');
  assert.equal(
    delivery.authority_readback_ref,
    `agent-context:orientation_delivery_receipts:${delivery.receipt_id}`,
  );

  const completion = {
    step_id: requiredRead.step_id,
    tool_name: requiredRead.tool.name,
    arguments: requiredRead.tool.arguments,
    result_evidence: {
      content_sha256: 'agents-sha256',
      offset: 0,
      returned_lines: 120,
    },
    completed_at: '2026-08-08T12:00:01.000Z',
    evidence_refs: ['mcp-result:fs-read:1'],
  };
  const acknowledgement = issueCarrierSessionOrientationAcknowledgement({
    admissionReceipt: admission(),
    deliveryReceipt: delivery,
    brief,
    requiredReadCompletions: [completion],
    acknowledgedAt: '2026-08-08T12:00:02.000Z',
    authorityReadbackRef: 'agent-context:orientation_acknowledgements:exact',
  });
  assert.equal(acknowledgement.status, 'acknowledged');
  assert.equal(
    acknowledgement.acknowledgement_semantics,
    'receipt_and_required_reads_not_comprehension',
  );
  assert.equal(acknowledgement.action_admission, 'separate_required');

  assert.throws(
    () => issueCarrierSessionOrientationAcknowledgement({
      admissionReceipt: admission(),
      deliveryReceipt: delivery,
      brief,
      requiredReadCompletions: [],
      acknowledgedAt: '2026-08-08T12:00:02.000Z',
      authorityReadbackRef: 'agent-context:orientation_acknowledgements:missing',
    }),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'required_read_completion_missing',
  );
});

test('compiler is deterministic, immutable, source indexed, and action-authority neutral', () => {
  const source = {
    admission_receipt: admission(),
    activation_receipt: activation(),
    assembly_policy: policy(),
    projections: requiredProjections(),
    generated_at: NOW,
  };
  const snapshot = JSON.stringify(source);
  const first = compileOrientationManifest(source);
  const second = compileOrientationManifest({
    ...source,
    projections: [...source.projections].reverse(),
  });

  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(first.source_mutation, false);
  assert.equal(first.manifest.readiness, 'ready');
  assert.equal(first.manifest.delivery, 'deliverable');
  assert.equal(first.manifest.action_admission, 'separate_required');
  assert.equal(first.manifest.manifest_digest, second.manifest.manifest_digest);
  assert.equal(first.manifest.manifest_id, second.manifest.manifest_id);
  assert.equal(first.manifest.entries.every((entry) => entry.source_authority_ref.length > 0), true);
  assert.equal(Object.isFrozen(first.manifest), true);
  assert.equal(first.manifest.bounds.manifest_bytes <= first.manifest.bounds.max_manifest_bytes, true);
  assert.deepEqual(
    parseOrientationManifest(JSON.parse(JSON.stringify(first.manifest))),
    first.manifest,
  );
  assert.deepEqual(
    parseOrientationCompilationResult(JSON.parse(JSON.stringify(first))),
    first,
  );
  assert.deepEqual(assertOrientationManifestIntegrity(first.manifest), first.manifest);
  assert.equal(
    new TextEncoder().encode(JSON.stringify(first.manifest)).byteLength
      <= first.manifest.bounds.max_manifest_bytes,
    true,
  );
});

test('persisted manifests reject content, identity, and byte-evidence tampering', () => {
  const result = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy(),
    projections: requiredProjections(),
    generated_at: NOW,
  });
  const tamperedContent = JSON.parse(JSON.stringify(result.manifest));
  tamperedContent.entries[0].payload = { value: 'tampered' };
  assert.throws(
    () => assertOrientationManifestIntegrity(tamperedContent),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'manifest_digest_mismatch',
  );

  const tamperedId = {
    ...result.manifest,
    manifest_id: result.manifest.manifest_id + '-other',
  };
  assert.throws(
    () => assertOrientationManifestIntegrity(tamperedId),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'manifest_id_mismatch',
  );

  const tamperedBytes = {
    ...result.manifest,
    bounds: {
      ...result.manifest.bounds,
      manifest_bytes: result.manifest.bounds.manifest_bytes + 1,
    },
  };
  assert.throws(
    () => assertOrientationManifestIntegrity(tamperedBytes),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'manifest_byte_count_mismatch',
  );
});

test('required source absence, source conflicts, and wrong-subject continuity block delivery', () => {
  const missingLaw = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy(),
    projections: requiredProjections().map((entry) => (
      entry.entry_kind === 'site_law'
        ? { ...entry, projection_status: 'unavailable' as const }
        : entry
    )),
    generated_at: NOW,
  });
  assert.equal(missingLaw.manifest.readiness, 'blocked');
  assert.equal(missingLaw.manifest.delivery, 'withheld');
  assert.ok(missingLaw.manifest.reason_codes.includes('required_law_projection_unavailable'));
  assert.ok(missingLaw.manifest.residuals.some((item) => item.code === 'law_source_unavailable'));

  const conflictingIdentity = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy(),
    projections: [
      ...requiredProjections(),
      projection('agent_identity_copy', 'office_and_role', {
        entry_id: 'entry:agent_identity:revision-18',
        source_authority_ref: 'authority:agent_identity',
        artifact_ref: 'artifact:agent_identity',
        revision: '18',
        criticality: 'required',
      }),
    ],
    generated_at: NOW,
  });
  assert.equal(conflictingIdentity.manifest.readiness, 'blocked');
  assert.ok(conflictingIdentity.manifest.reason_codes.includes('source_revision_conflict'));
  assert.ok(conflictingIdentity.manifest.residuals.some(
    (item) => item.code === 'agent_identity_revision_ambiguous',
  ));

  const wrongHandoff = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy(),
    projections: [
      ...requiredProjections(),
      projection('continuity', 'continuity', {
        entry_id: 'entry:wrong-handoff',
        criticality: 'optional',
        subject: {
          site_ref: SITE_REF,
          agent_ref: 'agent:narada:narada.architect@8',
          carrier_session_id: SESSION_ID,
        },
      }),
    ],
    generated_at: NOW,
  });
  assert.equal(wrongHandoff.manifest.readiness, 'blocked');
  assert.ok(wrongHandoff.manifest.reason_codes.includes('continuity_subject_mismatch'));
  assert.equal(
    wrongHandoff.manifest.entries.some((entry) => entry.entry_id === 'entry:wrong-handoff'),
    false,
  );
});

test('optional staleness and bounded omission degrade without becoming authority', () => {
  const result = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy({ max_rendered_bytes: 64 }),
    projections: [
      ...requiredProjections().map((entry) => ({ ...entry, rendered_text: null })),
      projection('continuity', 'continuity', {
        entry_id: 'entry:large-continuity',
        criticality: 'optional',
        rendered_text: 'x'.repeat(1_024),
      }),
      projection('grant_reference', 'authority_references', {
        entry_id: 'entry:stale-grant',
        criticality: 'optional',
        projection_status: 'stale',
        rendered_text: null,
      }),
    ],
    generated_at: NOW,
  });
  assert.equal(result.manifest.readiness, 'degraded');
  assert.equal(result.manifest.delivery, 'deliverable');
  assert.ok(result.manifest.reason_codes.includes('optional_entry_omitted_for_budget'));
  assert.ok(result.manifest.reason_codes.includes('grant_live_revalidation_required'));
  assert.ok(result.manifest.residuals.some(
    (item) => item.code === 'continuity_omission_with_source_ref',
  ));
  assert.ok(result.manifest.residuals.some((item) => item.code === 'stale_grant_projection'));
});

test('activation fencing and cross-Site runtime evidence withhold delivery without inventing source truth', () => {
  const staleEpoch = compileOrientationManifest({
    admission_receipt: admission(),
    activation_receipt: activation({
      coordinate: { ...admission().coordinate, authority_epoch: 5 },
    }),
    assembly_policy: policy(),
    projections: requiredProjections(),
    generated_at: NOW,
  });
  assert.equal(staleEpoch.manifest.readiness, 'blocked');
  assert.ok(staleEpoch.manifest.reason_codes.includes('authority_epoch_fenced'));

  const crossSite = compileOrientationManifest({
    admission_receipt: admission(),
    activation_receipt: activation({
      decision: 'refused',
      state: 'starting',
      runtime_binding: {
        ...activation().runtime_binding,
        owning_site_ref: 'site:other',
      },
      reason_codes: ['runtime_binding_site_mismatch'],
    }),
    assembly_policy: policy(),
    projections: requiredProjections(),
    generated_at: NOW,
  });
  assert.equal(crossSite.manifest.readiness, 'ready');
  assert.equal(crossSite.manifest.delivery, 'withheld');
  assert.ok(crossSite.manifest.residuals.some((item) => item.code === 'cross_site_runtime_binding'));
});

test('a manifest cannot be reused for another Carrier Session or authority epoch', () => {
  const result = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy(),
    projections: requiredProjections(),
    generated_at: NOW,
  });
  assert.doesNotThrow(() => assertManifestBoundToAdmission(result.manifest, admission()));
  assert.throws(
    () => assertManifestBoundToAdmission(result.manifest, admission({
      receipt_id: 'carrier-admission:other:1',
      coordinate: {
        ...admission().coordinate,
        carrier_session_id: 'carrier_other',
        authority_epoch: 1,
      },
    })),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'manifest_session_binding_mismatch',
  );
  assert.throws(
    () => assertManifestBoundToAdmission(result.manifest, admission({
      agent_identity: {
        ...admission().agent_identity,
        local_agent_id: 'narada.intruder',
        canonical_agent_id: 'narada.intruder',
      },
    })),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'manifest_agent_binding_mismatch',
  );
  assert.throws(
    () => assertManifestBoundToAdmission(result.manifest, admission({
      carrier_kind: 'kimi',
    })),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'manifest_carrier_kind_mismatch',
  );
});

test('manifest budgeting measures the stabilized packet and removes optional payload before refusal', () => {
  const result = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy({ max_manifest_bytes: 8_192 }),
    projections: [
      ...requiredProjections(),
      projection('large_optional_context', 'work_orientation', {
        entry_id: 'entry:large-optional-context',
        criticality: 'optional',
        payload: { value: 'x'.repeat(32_000) },
        rendered_text: null,
      }),
    ],
    generated_at: NOW,
  });
  assert.equal(result.manifest.bounds.manifest_bytes <= 8_192, true);
  assert.equal(
    result.manifest.entries.some((entry) => entry.entry_id === 'entry:large-optional-context'),
    false,
  );
  assert.ok(result.manifest.reason_codes.includes('optional_entry_omitted_for_budget'));
  assert.deepEqual(assertOrientationManifestIntegrity(result.manifest), result.manifest);
});

test('manifest parsing recomputes rendered bounds and rejects foreign included subjects', () => {
  const result = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy(),
    projections: requiredProjections(),
    generated_at: NOW,
  });
  const wrongRenderedBytes = {
    ...result.manifest,
    bounds: {
      ...result.manifest.bounds,
      rendered_bytes: result.manifest.bounds.rendered_bytes + 1,
    },
  };
  assert.throws(
    () => parseOrientationManifest(wrongRenderedBytes),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'manifest_rendered_byte_count_mismatch',
  );

  const foreignSubject = JSON.parse(JSON.stringify(result.manifest));
  foreignSubject.entries[0].subject.agent_ref = 'agent:foreign';
  assert.throws(
    () => parseOrientationManifest(foreignSubject),
    (error: unknown) => error instanceof OrientationContractError
      && error.code === 'manifest_entry_subject_mismatch',
  );
});

test('receipt, activation, and source evidence cannot arrive from the compiler future', () => {
  const beforeAdmission = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy(),
    projections: requiredProjections(),
    generated_at: '2026-08-08T11:58:59.000Z',
  });
  assert.equal(beforeAdmission.manifest.delivery, 'withheld');
  assert.ok(beforeAdmission.manifest.reason_codes.includes('assembly_precedes_admission'));

  const futureActivation = compileOrientationManifest({
    admission_receipt: admission(),
    activation_receipt: activation({
      issued_at: '2026-08-08T12:00:01.000Z',
      runtime_binding: {
        ...activation().runtime_binding,
        observed_at: '2026-08-08T12:00:01.000Z',
      },
    }),
    assembly_policy: policy(),
    projections: requiredProjections(),
    generated_at: NOW,
  });
  assert.equal(futureActivation.manifest.delivery, 'withheld');
  assert.ok(futureActivation.manifest.reason_codes.includes('activation_receipt_temporally_invalid'));

  const futureProjection = compileOrientationManifest({
    admission_receipt: admission(),
    assembly_policy: policy(),
    projections: requiredProjections().map((entry, index) => (
      index === 0
        ? { ...entry, observed_at: '2026-08-08T12:00:01.000Z' }
        : entry
    )),
    generated_at: NOW,
  });
  assert.equal(futureProjection.manifest.delivery, 'withheld');
  assert.equal(
    futureProjection.manifest.entries.some((entry) => entry.entry_kind === 'agent_identity'),
    false,
  );
  assert.ok(futureProjection.manifest.reason_codes.includes('projection_observation_after_assembly'));
  assert.ok(futureProjection.manifest.residuals.some(
    (entry) => entry.code === 'agent_identity_observation_after_assembly',
  ));
});

test('the production tests account for every precontract falsification case by owning boundary', () => {
  const fixturePath = fileURLToPath(new URL(
    '../../../docs/product/fixtures/orientation-manifest/adversarial-cases.v0.json',
    import.meta.url,
  ));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    cases: Array<{ case_id: string }>;
  };
  const boundaryByCase: Record<string, string> = {
    healthy_exact_binding: 'compiler',
    missing_required_law_projection: 'compiler',
    conflicting_identity_revisions: 'compiler',
    stale_grant_projection: 'compiler_and_action_revalidation',
    grant_revoked_after_manifest_delivery: 'action_admission',
    resume_requires_exact_checkpoint: 'compiler',
    parallel_sessions_explicitly_allowed: 'carrier_session_authority_policy',
    singleton_policy_refuses_second_session: 'carrier_session_authority_policy',
    ambient_latest_identity_fallback: 'admission_contract',
    wrong_agent_handoff: 'compiler',
    ambiguous_runtime_binding: 'activation_contract_and_delivery_gate',
    optional_continuity_exceeds_packet_budget: 'compiler',
    assembly_attempts_checkpoint_write: 'pure_compiler_boundary',
    manifest_reused_for_new_session: 'delivery_binding',
    stale_authority_epoch: 'compiler_fencing',
    runtime_binding_crosses_site_boundary: 'activation_contract_and_delivery_gate',
  };
  assert.deepEqual(
    fixture.cases.map((entry) => entry.case_id).sort(),
    Object.keys(boundaryByCase).sort(),
  );
  assert.equal(new Set(Object.values(boundaryByCase)).has('pure_compiler_boundary'), true);
});
