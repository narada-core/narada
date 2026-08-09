import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
} from '@narada-core/orientation-manifest';
import {
  adaptNarsSessionAdmissionReceipt,
  assertAdmissionReceiptForLaunch,
  canonicalOrientationSiteId,
  selectLaunchCarrierSessionAdmissionReceipt,
} from '../src/orientation-admission.js';

const AGENT_ID = 'narada-revolution.resident';
const SITE_ID = 'narada-revolution';
const CANONICAL_SITE_ID = 'narada.revolution';
const SESSION_ID = 'carrier_fixture_1';
const PRINCIPAL = {
  schema: 'narada.nars.session_principal.v1',
  authority_scope: 'local',
  site_id: SITE_ID,
  local_agent_id: 'resident',
  principal_key: 'local:' + SITE_ID + ':resident',
  identity_ref: null,
};
const ADMISSION = {
  schema: 'narada.nars.session_authority.v1',
  status: 'admitted',
  principal: PRINCIPAL,
  session_id: SESSION_ID,
  launch_session_id: SESSION_ID,
  authority_epoch: 3,
  owner_token: 'owner-secret-must-not-cross',
};
const RECORD = {
  schema: 'narada.nars.session_authority.v1',
  principal_key: PRINCIPAL.principal_key,
  authority_scope: PRINCIPAL.authority_scope,
  site_id: PRINCIPAL.site_id,
  local_agent_id: PRINCIPAL.local_agent_id,
  state: 'starting',
  session_id: SESSION_ID,
  runtime_kind: 'narada-agent-runtime-server',
  operator_surface_kind: 'agent-cli',
  authority_epoch: 3,
  started_at: '2026-08-08T12:00:00.000Z',
  owner_token: ADMISSION.owner_token,
};
const IDENTITY_REF = {
  schema: 'narada.agent_identity_ref.v2',
  identity_scope: { kind: 'narada_site', site_id: CANONICAL_SITE_ID },
  local_agent_id: 'resident',
  role: 'resident',
  canonical_agent_id: CANONICAL_SITE_ID + '.resident',
  display: CANONICAL_SITE_ID + '.resident',
  legacy_agent_id: AGENT_ID,
};
const ROLE_BINDING = {
  binding_authority: 'agent_roster',
  binding_source: 'static_roster_config',
  agent_id: AGENT_ID,
  role: 'resident',
};

function narsReceipt(overrides: Record<string, unknown> = {}) {
  return adaptNarsSessionAdmissionReceipt({
    authorityRecord: { ...RECORD, ...(overrides.authorityRecord as object ?? {}) },
    admission: { ...ADMISSION, ...(overrides.admission as object ?? {}) },
    siteId: String(overrides.siteId ?? CANONICAL_SITE_ID),
    agentId: String(overrides.agentId ?? AGENT_ID),
    carrierKind: String(overrides.carrierKind ?? 'agent-cli'),
    runtimeKind: String(overrides.runtimeKind ?? 'narada-agent-runtime-server'),
    agentIdentityRef: (overrides.agentIdentityRef as any) ?? IDENTITY_REF,
    roleBinding: (overrides.roleBinding as any) ?? ROLE_BINDING,
  });
}

test('NARS authority readback adapts to one exact owner-issued receipt without leaking its owner token', () => {
  const receipt = narsReceipt();
  assert.equal(receipt.schema, CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA);
  assert.equal(receipt.coordinate.site_ref, 'site:' + CANONICAL_SITE_ID);
  assert.equal(receipt.coordinate.carrier_session_id, SESSION_ID);
  assert.equal(receipt.coordinate.authority_epoch, 3);
  assert.equal(receipt.agent_identity.local_agent_id, AGENT_ID);
  assert.equal(receipt.agent_identity.canonical_agent_id, IDENTITY_REF.canonical_agent_id);
  assert.equal(receipt.carrier_kind, 'agent-cli');
  assert.equal(receipt.issued_at, RECORD.started_at);
  assert.equal(JSON.stringify(receipt).includes(ADMISSION.owner_token), false);
  assert.equal(canonicalOrientationSiteId('site:' + SITE_ID), CANONICAL_SITE_ID);
});

test('NARS adaptation refuses inferred identity and stale or mismatched authority readback', () => {
  assert.throws(
    () => narsReceipt({
      roleBinding: {
        ...ROLE_BINDING,
        binding_authority: 'identity_inference_non_authoritative',
      },
    }),
    /carrier_session_admission_requires_authoritative_agent_identity/,
  );
  for (const authorityRecord of [
    { authority_epoch: 2 },
    { state: 'active' },
    { session_id: 'carrier_other' },
    { principal_key: 'local:other:resident' },
    { operator_surface_kind: 'codex' },
    { runtime_kind: 'other-runtime' },
  ]) {
    assert.throws(
      () => narsReceipt({ authorityRecord }),
      /carrier_session_authority_readback_mismatch/,
    );
  }
  assert.throws(
    () => narsReceipt({
      agentIdentityRef: { ...IDENTITY_REF, legacy_agent_id: 'other.agent' },
      agentId: AGENT_ID,
    }),
    /carrier_session_admission_agent_identity_ref_mismatch/,
  );
  assert.throws(
    () => narsReceipt({
      agentIdentityRef: {
        ...IDENTITY_REF,
        local_agent_id: 'other',
        legacy_agent_id: AGENT_ID,
      },
    }),
    /carrier_session_admission_principal_identity_mismatch/,
  );
  assert.throws(
    () => narsReceipt({
      roleBinding: {
        ...ROLE_BINDING,
        agent_id: 'other.agent',
      },
    }),
    /carrier_session_admission_role_binding_mismatch/,
  );
});

test('direct-carrier receipts are exact, time-bounded, and never inherited across sessions', () => {
  const receipt = {
    schema: CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
    receipt_id: 'direct-owner:' + SESSION_ID,
    decision: 'admitted',
    state: 'starting',
    coordinate: {
      authority_scope: 'direct-test-owner',
      site_ref: 'site:' + CANONICAL_SITE_ID,
      carrier_session_id: SESSION_ID,
      authority_epoch: 1,
    },
    agent_identity: {
      source_authority_ref: 'agent-identity:test',
      artifact_ref: 'agent:' + AGENT_ID,
      revision: '1',
      local_agent_id: AGENT_ID,
      canonical_agent_id: IDENTITY_REF.canonical_agent_id,
    },
    carrier_kind: 'codex',
    admission_policy: {
      source_authority_ref: 'test-policy',
      artifact_ref: 'direct-carrier',
      revision: '1',
    },
    issued_at: '2026-08-08T12:00:00.000Z',
    valid_until: '2026-08-08T13:00:00.000Z',
    authority_readback_ref: 'test-owner:' + SESSION_ID,
    evidence_refs: ['test:direct-owner'],
    reason_codes: [],
  };
  const selected = selectLaunchCarrierSessionAdmissionReceipt({
    explicitReceipt: JSON.stringify(receipt),
    inheritedReceipt: null,
    expectedSessionId: SESSION_ID,
  });
  assert.deepEqual(
    assertAdmissionReceiptForLaunch(selected, {
      siteId: SITE_ID,
      agentId: AGENT_ID,
      carrierSessionId: SESSION_ID,
      carrierKind: 'codex',
      evaluatedAt: '2026-08-08T12:30:00.000Z',
    }),
    receipt,
  );
  assert.equal(
    selectLaunchCarrierSessionAdmissionReceipt({
      inheritedReceipt: JSON.stringify(receipt),
      expectedSessionId: 'carrier_new',
    }),
    null,
  );
  assert.throws(
    () => assertAdmissionReceiptForLaunch(selected, {
      siteId: SITE_ID,
      agentId: AGENT_ID,
      carrierSessionId: SESSION_ID,
      carrierKind: 'codex',
      evaluatedAt: '2026-08-08T13:00:00.000Z',
    }),
    /carrier_session_admission_receipt_expired/,
  );
  assert.throws(
    () => assertAdmissionReceiptForLaunch(selected, {
      siteId: SITE_ID,
      agentId: AGENT_ID,
      carrierSessionId: SESSION_ID,
      carrierKind: 'codex',
      evaluatedAt: '2026-08-08T11:59:59.000Z',
    }),
    /carrier_session_admission_receipt_not_yet_issued/,
  );
  assert.throws(
    () => selectLaunchCarrierSessionAdmissionReceipt({
      explicitReceipt: '{not-json',
      expectedSessionId: SESSION_ID,
    }),
    /carrier_session_admission_receipt_invalid/,
  );
});
