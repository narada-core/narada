import { createHash } from 'node:crypto';
import {
  CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
  parseCarrierSessionAdmissionReceipt,
  type CarrierSessionAdmissionReceipt,
} from '@narada-core/orientation-manifest';
import { canonicalJson } from './launcher-cli-contract.js';

type RecordValue = Record<string, any>;

export function canonicalOrientationSiteId(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('carrier_session_admission_site_id_required');
  return text.replace(/^site:/i, '').replace(/^narada[.-]/, 'narada.');
}

export function admissionIdentityRevision(
  agentIdentityRef: unknown,
  roleBinding: unknown,
): string {
  return createHash('sha256').update(canonicalJson({
    agent_identity_ref: agentIdentityRef,
    role_binding: roleBinding,
  })).digest('hex');
}

function parseReceiptInput(value: unknown): CarrierSessionAdmissionReceipt | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    try {
      return parseCarrierSessionAdmissionReceipt(JSON.parse(value));
    } catch (error) {
      throw new Error(
        'carrier_session_admission_receipt_invalid:'
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  try {
    return parseCarrierSessionAdmissionReceipt(value);
  } catch (error) {
    throw new Error(
      'carrier_session_admission_receipt_invalid:'
      + (error instanceof Error ? error.message : String(error)),
    );
  }
}

export function selectLaunchCarrierSessionAdmissionReceipt({
  explicitReceipt = null,
  inheritedReceipt = null,
  expectedSessionId,
}: {
  explicitReceipt?: unknown;
  inheritedReceipt?: unknown;
  expectedSessionId: string;
}): CarrierSessionAdmissionReceipt | null {
  const explicit = parseReceiptInput(explicitReceipt);
  if (explicit) return explicit;
  const inherited = parseReceiptInput(inheritedReceipt);
  if (!inherited) return null;
  return inherited.coordinate.carrier_session_id === expectedSessionId ? inherited : null;
}

export function assertAdmissionReceiptForLaunch(
  receiptValue: unknown,
  {
    siteId,
    agentId,
    carrierSessionId,
    carrierKind,
    evaluatedAt,
  }: {
    siteId: string;
    agentId: string;
    carrierSessionId: string;
    carrierKind: string;
    evaluatedAt: string;
  },
): CarrierSessionAdmissionReceipt {
  const receipt = parseCarrierSessionAdmissionReceipt(receiptValue);
  if (receipt.decision !== 'admitted' || receipt.state !== 'starting') {
    throw new Error('carrier_session_starting_admission_required');
  }
  const canonicalSiteId = canonicalOrientationSiteId(siteId);
  if (receipt.coordinate.site_ref !== 'site:' + canonicalSiteId) {
    throw new Error('carrier_session_admission_site_mismatch');
  }
  if (receipt.coordinate.carrier_session_id !== carrierSessionId) {
    throw new Error('carrier_session_admission_session_mismatch');
  }
  if (receipt.agent_identity.local_agent_id !== agentId) {
    throw new Error('carrier_session_admission_agent_mismatch');
  }
  if (receipt.carrier_kind !== carrierKind) {
    throw new Error('carrier_session_admission_carrier_kind_mismatch');
  }
  const evaluatedAtMs = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs) || new Date(evaluatedAtMs).toISOString() !== evaluatedAt) {
    throw new Error('carrier_session_admission_evaluation_time_invalid');
  }
  if (Date.parse(receipt.issued_at) > evaluatedAtMs) {
    throw new Error('carrier_session_admission_receipt_not_yet_issued');
  }
  if (receipt.valid_until !== null && Date.parse(receipt.valid_until) <= evaluatedAtMs) {
    throw new Error('carrier_session_admission_receipt_expired');
  }
  return receipt;
}

function requireNarsReadbackMatch(
  record: RecordValue | null,
  admission: RecordValue,
  {
    siteId,
    agentId,
    carrierKind,
    runtimeKind,
  }: {
    siteId: string;
    agentId: string;
    carrierKind: string;
    runtimeKind: string;
  },
): RecordValue {
  const principal = admission?.principal;
  if (
    admission?.status !== 'admitted'
    || !principal
    || !record
    || record.state !== 'starting'
    || record.session_id !== admission.session_id
    || Number(record.authority_epoch) !== Number(admission.authority_epoch)
    || record.principal_key !== principal.principal_key
    || record.authority_scope !== principal.authority_scope
    || record.site_id !== principal.site_id
    || record.local_agent_id !== principal.local_agent_id
    || canonicalOrientationSiteId(record.site_id) !== canonicalOrientationSiteId(siteId)
    || record.operator_surface_kind !== carrierKind
    || record.runtime_kind !== runtimeKind
  ) {
    throw new Error('carrier_session_authority_readback_mismatch');
  }
  if (
    typeof agentId !== 'string'
    || agentId.trim() === ''
    || typeof record.started_at !== 'string'
    || record.started_at.trim() === ''
  ) {
    throw new Error('carrier_session_authority_readback_mismatch');
  }
  return record;
}

export function adaptNarsSessionAdmissionReceipt({
  authorityRecord,
  admission,
  siteId,
  agentId,
  carrierKind,
  runtimeKind,
  agentIdentityRef,
  roleBinding,
}: {
  authorityRecord: RecordValue | null;
  admission: RecordValue;
  siteId: string;
  agentId: string;
  carrierKind: string;
  runtimeKind: string;
  agentIdentityRef: RecordValue;
  roleBinding: RecordValue;
}): CarrierSessionAdmissionReceipt {
  if (roleBinding?.binding_authority !== 'agent_roster') {
    throw new Error('carrier_session_admission_requires_authoritative_agent_identity');
  }
  const identityAliases = [
    agentIdentityRef?.local_agent_id,
    agentIdentityRef?.legacy_agent_id,
    agentIdentityRef?.canonical_agent_id,
  ].filter((value) => typeof value === 'string' && value.trim() !== '');
  if (
    typeof agentIdentityRef?.local_agent_id !== 'string'
    || agentIdentityRef.local_agent_id.trim() === ''
    || typeof agentIdentityRef?.canonical_agent_id !== 'string'
    || agentIdentityRef.canonical_agent_id.trim() === ''
    || !identityAliases.includes(agentId)
  ) {
    throw new Error('carrier_session_admission_agent_identity_ref_mismatch');
  }
  if (agentIdentityRef.local_agent_id !== admission?.principal?.local_agent_id) {
    throw new Error('carrier_session_admission_principal_identity_mismatch');
  }
  if (!identityAliases.includes(roleBinding?.agent_id)) {
    throw new Error('carrier_session_admission_role_binding_mismatch');
  }
  const record = requireNarsReadbackMatch(authorityRecord, admission, {
    siteId,
    agentId,
    carrierKind,
    runtimeKind,
  });
  const revision = admissionIdentityRevision(agentIdentityRef, roleBinding);
  const principalKey = admission.principal.principal_key;
  return parseCarrierSessionAdmissionReceipt({
    schema: CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
    receipt_id: 'nars-admission:' + admission.session_id + ':' + admission.authority_epoch,
    decision: 'admitted',
    state: 'starting',
    coordinate: {
      authority_scope: 'nars-session-authority:' + admission.principal.authority_scope,
      site_ref: 'site:' + canonicalOrientationSiteId(siteId),
      carrier_session_id: admission.session_id,
      authority_epoch: admission.authority_epoch,
    },
    agent_identity: {
      source_authority_ref: roleBinding.binding_authority,
      artifact_ref: 'agent:' + agentIdentityRef.canonical_agent_id,
      revision,
      local_agent_id: agentId,
      canonical_agent_id: agentIdentityRef.canonical_agent_id,
    },
    carrier_kind: carrierKind,
    admission_policy: {
      source_authority_ref: 'nars-session-authority-policy:' + canonicalOrientationSiteId(siteId),
      artifact_ref: 'nars-principal-singleton:' + principalKey,
      revision: 'narada.nars.session_authority.v1',
    },
    issued_at: record.started_at,
    valid_until: null,
    authority_readback_ref: 'nars-session-authority:' + principalKey
      + ':' + admission.session_id + ':' + admission.authority_epoch,
    evidence_refs: [
      'nars-session-authority-event:' + principalKey
        + ':' + admission.session_id + ':' + admission.authority_epoch,
      'sha256:' + revision,
    ],
    reason_codes: [],
  });
}
