import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
  ORIENTATION_ASSEMBLY_POLICY_SCHEMA,
  buildOrientationBrief,
  compileOrientationManifest,
  issueCarrierSessionOrientationAcknowledgement,
  issueCarrierSessionOrientationDeliveryReceipt,
} from '@narada-core/orientation-manifest';
import { createOrientationEntryGate } from './orientation-entry-gate.js';
import { buildProviderTurnContext } from './session-core-runtime-service.js';

const NOW = '2026-08-08T12:00:00.000Z';

function ceremonyFixture(siteRoot: string) {
  const admission: any = {
    schema: CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
    receipt_id: 'receipt:runtime-gate:1',
    decision: 'admitted',
    state: 'starting',
    coordinate: {
      authority_scope: 'test',
      site_ref: 'site:runtime-gate',
      carrier_session_id: 'carrier_runtime_gate',
      authority_epoch: 1,
    },
    agent_identity: {
      source_authority_ref: 'agent-identity:runtime-gate',
      artifact_ref: 'agent:runtime-gate:resident@1',
      revision: '1',
      local_agent_id: 'runtime-gate.resident',
      canonical_agent_id: 'runtime-gate.resident',
    },
    carrier_kind: 'agent-cli',
    admission_policy: {
      source_authority_ref: 'site-law:runtime-gate',
      artifact_ref: 'carrier-policy:runtime-gate',
      revision: '1',
    },
    issued_at: NOW,
    valid_until: null,
    authority_readback_ref: 'carrier-session-authority:runtime-gate',
    evidence_refs: [],
    reason_codes: [],
  };
  const subject = {
    site_ref: admission.coordinate.site_ref,
    agent_ref: admission.agent_identity.artifact_ref,
    carrier_session_id: admission.coordinate.carrier_session_id,
  };
  const projection = (
    entryKind: string,
    compartment: string,
    payload: Record<string, unknown>,
  ): any => ({
    entry_id: `entry:${entryKind}`,
    compartment,
    entry_kind: entryKind,
    subject,
    source_authority_ref: `authority:${entryKind}`,
    artifact_ref: `artifact:${entryKind}`,
    revision: '1',
    observed_at: NOW,
    valid_until: null,
    criticality: 'required',
    projection_status: 'available',
    revalidation_rule: 'on_source_revision',
    evidence_refs: [],
    payload,
    rendered_text: entryKind,
  });

  const requiredRead: any = {
    step_id: 'read:site-law:1',
    ordinal: 1,
    required: true,
    source: {
      source_authority_ref: 'site-law:runtime-gate',
      artifact_ref: 'site-file:AGENTS.md',
      revision: 'law-sha',
    },
    tool: {
      name: 'fs_read_file_range',
      arguments: {
        path: join(siteRoot, 'AGENTS.md'),
        start_line: 1,
        end_line: 1,
      },
    },
    completion: {
      kind: 'tool_result_fields',
      expected_result: { content_sha256: 'law-sha', offset: 1 },
      evidence_fields: ['content_sha256', 'content_window_sha256', 'offset', 'returned_lines'],
    },
  };
  const compilation: any = compileOrientationManifest({
    admission_receipt: admission,
    assembly_policy: {
      schema: ORIENTATION_ASSEMBLY_POLICY_SCHEMA,
      policy_ref: 'orientation-policy:runtime-gate',
      revision: '1',
      required_entry_kinds: ['agent_identity', 'site_law', 'entry_procedure'],
      max_entries: 12,
      max_rendered_bytes: 32_768,
      max_manifest_bytes: 131_072,
      continuity_selection: 'exact_or_omitted',
      optional_entry_behavior: 'degrade',
      negative_claims: [{
        claim_id: 'orientation_is_not_authorization',
        statement: 'Orientation does not authorize a later action.',
      }],
    },
    projections: [
      projection('agent_identity', 'office_and_role', {}),
      projection('site_law', 'law_and_constraints', {}),
      projection('exact_continuity', 'continuity', {
        occupant_summary: {
          objective: 'Continue exact Carrier-entry work.',
          next_action: 'Perform the admitted fixture step.',
        },
        inspection_call: null,
      }),
      projection('exact_work', 'work_orientation', {
        occupant_summary: {
          task_number: 42,
          title: 'Exercise the runtime gate',
          status: 'in_progress',
        },
        inspection_call: {
          surface_id: 'task-lifecycle',
          tool: 'task_lifecycle_inspect_range',
          arguments: { start_task_number: 42, end_task_number: 42, include_body: true, limit: 1 },
        },
      }),
      projection('entry_procedure', 'entry_procedure', {
        required_reads: [requiredRead],
      }),
    ],
    generated_at: NOW,
  });
  const brief: any = buildOrientationBrief({
    manifest: compilation.manifest,
    manifestArtifactRef: 'agent-context:orientation-manifests:runtime-gate',
  });
  const delivery: any = issueCarrierSessionOrientationDeliveryReceipt({
    admissionReceipt: admission,
    brief,
    deliveredAt: NOW,
  });
  const completion: any = {
    step_id: requiredRead.step_id,
    tool_name: requiredRead.tool.name,
    arguments: requiredRead.tool.arguments,
    result_evidence: {
      content_sha256: 'law-sha',
      content_window_sha256: 'window-sha',
      offset: 1,
      returned_lines: 1,
    },
    completed_at: '2026-08-08T12:00:01.000Z',
    evidence_refs: ['test:runtime-gate:read'],
  };
  const acknowledgement: any = issueCarrierSessionOrientationAcknowledgement({
    admissionReceipt: admission,
    deliveryReceipt: delivery,
    brief,
    requiredReadCompletions: [completion],
    acknowledgedAt: '2026-08-08T12:00:02.000Z',
    authorityReadbackRef: 'agent-context:orientation_acknowledgements:runtime-gate',
  });
  return { admission, brief, delivery, acknowledgement };
}

test('ordinary provider turns retain the exact Orientation Card while bootstrap stays isolated', () => {
  const fixture = ceremonyFixture('C:/orientation-card-fixture');
  const ordinary: any = buildProviderTurnContext({
    eventsPath: 'not-read-in-current-only-mode',
    orientationBrief: fixture.brief,
    input: {
      event_id: 'ordinary-1',
      content: 'Perform the admitted next step.',
      metadata: {
        intelligence_invocation: {
          intent_id: 'intent:ordinary-1',
          mode: 'retry',
        },
      },
    },
  });
  assert.equal(ordinary.messages.length, 2);
  assert.equal(ordinary.messages[0].role, 'system');
  assert.match(ordinary.messages[0].content, /narada\.orientation_context_card\.v1/);
  assert.match(ordinary.messages[0].content, /runtime-gate\.resident/);
  assert.match(ordinary.messages[0].content, /acknowledged_before_ordinary_turn/);
  assert.match(ordinary.messages[0].content, /entry_handoff/);
  assert.match(ordinary.messages[0].content, /selected_at_carrier_entry_not_live_state/);
  assert.equal(Buffer.byteLength(ordinary.messages[0].content, 'utf8') < 3_072, true);
  assert.doesNotMatch(ordinary.messages[0].content, /negative_claims/);
  const card: any = JSON.parse(ordinary.messages[0].content.slice(
    ordinary.messages[0].content.indexOf('{'),
  ));
  assert.equal(card.continuity.summary.objective, 'Continue exact Carrier-entry work.');
  assert.equal(card.work.summary.task_number, 42);
  assert.equal(card.work.snapshot_posture, 'selected_at_carrier_entry_not_live_state');
  assert.equal(card.work.inspect.tool, 'task_lifecycle_inspect_range');
  assert.equal('brief_ref' in card, false);
  assert.deepEqual(ordinary.messages[1], {
    role: 'user',
    content: 'Perform the admitted next step.',
  });

  const eventsRoot = mkdtempSync(join(tmpdir(), 'orientation-recurring-card-'));
  try {
    const eventsPath = join(eventsRoot, 'events.jsonl');
    writeFileSync(eventsPath, `${[
      { event_sequence: 1, event: 'user_message', event_id: 'ordinary-1', content: 'Perform the admitted next step.' },
      { event_sequence: 2, event: 'assistant_message', event_id: 'ordinary-1', content: 'First ordinary turn complete.' },
    ].map((event: any) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    const recurring: any = buildProviderTurnContext({
      eventsPath,
      orientationBrief: fixture.brief,
      input: { event_id: 'ordinary-2', content: 'Continue from live state.' },
    });
    const recurringCard: any = JSON.parse(recurring.messages[0].content.slice(
      recurring.messages[0].content.indexOf('{'),
    ));
    assert.equal(recurringCard.projection_mode, 'recurring_position');
    assert.equal('entry_snapshot_at' in recurringCard, false);
    assert.equal('continuity' in recurringCard, false);
    assert.equal('work' in recurringCard, false);
    assert.equal(recurringCard.work_refresh.tool, 'task_lifecycle_inspect_range');
    assert.doesNotMatch(recurring.messages[0].content, /Continue exact Carrier-entry work/);
    assert.deepEqual(recurring.messages.slice(1), [
      { role: 'user', content: 'Perform the admitted next step.' },
      { role: 'assistant', content: 'First ordinary turn complete.' },
      { role: 'user', content: 'Continue from live state.' },
    ]);
  } finally {
    rmSync(eventsRoot, { recursive: true, force: true });
  }

  const bootstrap: any = buildProviderTurnContext({
    eventsPath: 'unused-for-bootstrap',
    orientationBrief: fixture.brief,
    input: {
      event_id: 'bootstrap-1',
      content: 'Bootstrap only.',
      metadata: { orientation_bootstrap: true },
    },
  });
  assert.deepEqual(bootstrap.messages, [{ role: 'system', content: 'Bootstrap only.' }]);
});

test('orientation requirement signal cannot be erased by omitting the entry path', () => {
  assert.throws(
    () => createOrientationEntryGate({ requiredSignal: '1' }),
    /orientation_entry_packet_required/,
  );
  assert.throws(
    () => createOrientationEntryGate({ requiredSignal: 'unexpected' }),
    /orientation_required_signal_invalid/,
  );
  assert.throws(
    () => createOrientationEntryGate({
      requiredSignal: '0',
      entryFile: 'C:/unexpected-entry.json',
    }),
    /orientation_required_signal_conflict/,
  );
  const notRequired: any = createOrientationEntryGate({ requiredSignal: '0' });
  assert.equal(notRequired.required, false);
  assert.equal(notRequired.inspect().ordinary_work_gate, 'open');
});

test('Narada runtime gate admits ordinary work only after exact append-only acknowledgement', () => {
  const siteRoot = mkdtempSync(join(tmpdir(), 'narada-runtime-orientation-gate-'));
  const artifactRoot = join(siteRoot, '.ai', 'runtime', 'orientation-entry', 'carrier-runtime-gate');
  const entryFile = join(artifactRoot, 'entry.json');
  const dbPath = join(siteRoot, '.ai', 'state', 'agent-context.sqlite');
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });
  writeFileSync(join(siteRoot, 'AGENTS.md'), '# Runtime gate\n', 'utf8');
  const fixture = ceremonyFixture(siteRoot);
  writeFileSync(entryFile, JSON.stringify({
    schema: 'narada.carrier_entry.orientation_packet.v1',
    ordinary_work_gate: 'acknowledgement_required',
    orientation_brief: fixture.brief,
    delivery_receipt: fixture.delivery,
  }), 'utf8');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orientation_delivery_receipts (
      receipt_id TEXT PRIMARY KEY,
      receipt_json TEXT NOT NULL
    );
    CREATE TABLE orientation_acknowledgements (
      delivery_receipt_ref TEXT PRIMARY KEY,
      acknowledgement_json TEXT NOT NULL
    );
  `);
  const previousAdmission = process.env.NARADA_CARRIER_SESSION_ADMISSION_RECEIPT;
  process.env.NARADA_CARRIER_SESSION_ADMISSION_RECEIPT = JSON.stringify(fixture.admission);
  try {
    const gate: any = createOrientationEntryGate({ entryFile, siteRoot, dbPath });
    assert.equal(gate.required, true);
    assert.equal(gate.inspect().reason, 'orientation_delivery_not_admitted');
    assert.throws(
      () => gate.assertOpen(),
      /orientation_acknowledgement_required:orientation_delivery_not_admitted/,
    );

    db.prepare(
      'INSERT INTO orientation_delivery_receipts (receipt_id, receipt_json) VALUES (?, ?)',
    ).run(fixture.delivery.receipt_id, JSON.stringify(fixture.delivery));
    assert.equal(gate.inspect().reason, 'orientation_acknowledgement_required');

    db.prepare(
      'INSERT INTO orientation_acknowledgements (delivery_receipt_ref, acknowledgement_json) VALUES (?, ?)',
    ).run(fixture.delivery.receipt_id, JSON.stringify(fixture.acknowledgement));
    const open: any = gate.assertOpen();
    assert.equal(open.status, 'open');
    assert.equal(open.ordinary_work_gate, 'open');
    assert.equal(open.action_admission, 'separate_required');
  } finally {
    db.close();
    if (previousAdmission === undefined) {
      delete process.env.NARADA_CARRIER_SESSION_ADMISSION_RECEIPT;
    } else {
      process.env.NARADA_CARRIER_SESSION_ADMISSION_RECEIPT = previousAdmission;
    }
    rmSync(siteRoot, { recursive: true, force: true });
  }
});
