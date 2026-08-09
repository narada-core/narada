import { createHash } from 'node:crypto';
import {
  CARRIER_SESSION_DELIVERY_RECEIPT_SCHEMA,
  ORIENTATION_ACKNOWLEDGEMENT_SCHEMA,
  ORIENTATION_BRIEF_SCHEMA,
  ORIENTATION_OCCUPANT_BRIEF_SCHEMA,
  ORIENTATION_READY_PROJECTION_SCHEMA,
  OrientationContractError,
  deepFreeze,
  parseCarrierSessionAdmissionReceipt,
  parseCarrierSessionOrientationAcknowledgement,
  parseCarrierSessionOrientationDeliveryReceipt,
  parseOrientationBrief,
  parseOrientationManifest,
  parseOrientationReadCompletionEvidence,
  parseOrientationRequiredReadStep,
  type CarrierSessionAdmissionReceipt,
  type CarrierSessionOrientationAcknowledgement,
  type CarrierSessionOrientationDeliveryReceipt,
  type JsonObject,
  type OrientationArtifactSelection,
  type OrientationBrief,
  type OrientationOccupantBrief,
  type OrientationReadyProjection,
  type OrientationManifest,
  type OrientationReadCompletionEvidence,
  type OrientationRequiredReadStep,
} from './contracts.js';
import { assertOrientationManifestIntegrity } from './compiler.js';

// The canonical Carrier-side brief retains executable read/completion
// contracts. The occupant projection remains independently capped at 3 KiB.
export const MAX_ORIENTATION_BRIEF_INLINE_BYTES = 8_192;
export const MAX_ORIENTATION_OCCUPANT_BRIEF_INLINE_BYTES = 3_072;

type UnknownRecord = Record<string, unknown>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as UnknownRecord)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as UnknownRecord)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function ceremonyError(code: string, path: string, message: string): never {
  throw new OrientationContractError(code, path, message);
}

function sameCoordinate(
  left: CarrierSessionAdmissionReceipt['coordinate'],
  right: CarrierSessionAdmissionReceipt['coordinate'],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function availableEntry(
  manifest: OrientationManifest,
  compartment: string,
): OrientationManifest['entries'][number] | null {
  return manifest.entries.find(
    (entry) => entry.compartment === compartment && entry.projection_status === 'available',
  ) ?? null;
}

function artifactSelection(
  manifest: OrientationManifest,
  compartment: 'continuity' | 'work_orientation',
): OrientationArtifactSelection {
  const entry = availableEntry(manifest, compartment);
  if (!entry) {
    return deepFreeze({
      mode: 'omitted',
      source_authority_ref: null,
      artifact_ref: null,
      revision: null,
      reason_code: compartment === 'continuity'
        ? 'continuity_not_selected_at_entry'
        : 'work_not_selected_at_entry',
      summary: null,
      inspection_call: null,
    });
  }
  const occupantSummary = entry.payload?.occupant_summary;
  const summary = occupantSummary
    && typeof occupantSummary === 'object'
    && !Array.isArray(occupantSummary)
    ? occupantSummary as JsonObject
    : { label: entry.rendered_text ?? entry.artifact_ref };
  const projectedCall = entry.payload?.inspection_call;
  const inspectionCall = projectedCall
    && typeof projectedCall === 'object'
    && !Array.isArray(projectedCall)
    ? projectedCall as unknown as OrientationArtifactSelection['inspection_call']
    : null;
  return deepFreeze({
    mode: 'exact',
    source_authority_ref: entry.source_authority_ref,
    artifact_ref: entry.artifact_ref,
    revision: entry.revision,
    reason_code: null,
    summary,
    inspection_call: inspectionCall,
  });
}

function roleBinding(manifest: OrientationManifest): JsonObject | null {
  const entry = manifest.entries.find(
    (candidate) => candidate.entry_kind === 'role_binding'
      && candidate.projection_status === 'available',
  );
  const binding = entry?.payload?.role_binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  return binding as JsonObject;
}

function requiredReads(manifest: OrientationManifest): readonly OrientationRequiredReadStep[] {
  const entry = manifest.entries.find(
    (candidate) => candidate.entry_kind === 'entry_procedure'
      && candidate.projection_status === 'available',
  );
  const value = entry?.payload?.required_reads;
  if (!Array.isArray(value) || value.length === 0) {
    return ceremonyError(
      'orientation_required_reads_missing',
      'manifest.entries.entry_procedure.payload.required_reads',
      'entry procedure must project at least one executable required read',
    );
  }
  return value.map((step, index) => (
    parseOrientationRequiredReadStep(step, `manifest.required_reads[${index}]`)
  ));
}

function briefDigestInput(value: UnknownRecord): UnknownRecord {
  const { brief_digest: _briefDigest, inline_bytes: _inlineBytes, ...input } = value;
  return input;
}

export function assertOrientationBriefIntegrity(value: unknown): OrientationBrief {
  const brief = parseOrientationBrief(value);
  const expectedDigest = sha256(canonicalJson(briefDigestInput(brief as unknown as UnknownRecord)));
  if (brief.brief_digest !== expectedDigest) {
    return ceremonyError(
      'orientation_brief_digest_mismatch',
      'orientation_brief.brief_digest',
      `expected ${expectedDigest}`,
    );
  }
  const actualBytes = byteLength(brief);
  if (brief.inline_bytes !== actualBytes) {
    return ceremonyError(
      'orientation_brief_byte_count_mismatch',
      'orientation_brief.inline_bytes',
      `expected ${actualBytes}`,
    );
  }
  if (
    brief.manifest_ref.revision !== brief.manifest_ref.manifest_digest
  ) {
    return ceremonyError(
      'orientation_manifest_ref_revision_mismatch',
      'orientation_brief.manifest_ref.revision',
      'canonical manifest reference revision must equal manifest digest',
    );
  }
  return brief;
}

export function buildOrientationBrief({
  manifest: manifestValue,
  manifestArtifactRef,
  maxInlineBytes = MAX_ORIENTATION_BRIEF_INLINE_BYTES,
}: {
  manifest: unknown;
  manifestArtifactRef: string;
  maxInlineBytes?: number;
}): OrientationBrief {
  const manifest = assertOrientationManifestIntegrity(parseOrientationManifest(manifestValue));
  if (manifest.delivery !== 'deliverable') {
    return ceremonyError(
      'orientation_manifest_not_deliverable',
      'manifest.delivery',
      'withheld manifests cannot produce an entry brief',
    );
  }
  if (!Number.isInteger(maxInlineBytes) || maxInlineBytes < 1) {
    return ceremonyError(
      'orientation_brief_bound_invalid',
      'max_inline_bytes',
      'expected a positive integer',
    );
  }
  const briefId = `orientation-brief:${manifest.manifest_id}`;
  const unsigned: UnknownRecord = {
    schema: ORIENTATION_BRIEF_SCHEMA,
    brief_id: briefId,
    generated_at: manifest.generated_at,
    coordinate: manifest.coordinate,
    admission_receipt_ref: manifest.admission_receipt_ref,
    agent_identity: manifest.agent_identity,
    carrier_kind: manifest.carrier_kind,
    readiness: manifest.readiness,
    entry_state: 'orientation_required',
    action_admission: 'separate_required',
    manifest_ref: {
      source_authority_ref: 'agent-context:orientation-manifest-store',
      artifact_ref: manifestArtifactRef,
      revision: manifest.manifest_digest,
      manifest_id: manifest.manifest_id,
      manifest_digest: manifest.manifest_digest,
    },
    role_binding: roleBinding(manifest),
    continuity_selection: artifactSelection(manifest, 'continuity'),
    work_selection: artifactSelection(manifest, 'work_orientation'),
    required_reads: requiredReads(manifest),
    residual_codes: [...new Set(manifest.residuals.map((residual) => residual.code))].sort(),
    negative_claims: manifest.negative_claims.map((claim) => claim.statement),
    max_inline_bytes: maxInlineBytes,
  };
  const briefDigest = sha256(canonicalJson(unsigned));
  let inlineBytes = 1;
  let candidate: UnknownRecord = {};
  for (let attempt = 0; attempt < 4; attempt += 1) {
    candidate = {
      ...unsigned,
      brief_digest: briefDigest,
      inline_bytes: inlineBytes,
    };
    const measured = byteLength(candidate);
    if (measured === inlineBytes) break;
    inlineBytes = measured;
  }
  candidate = {
    ...unsigned,
    brief_digest: briefDigest,
    inline_bytes: byteLength({ ...candidate, inline_bytes: inlineBytes }),
  };
  const stableBytes = byteLength(candidate);
  if (candidate.inline_bytes !== stableBytes) candidate.inline_bytes = stableBytes;
  if (stableBytes > maxInlineBytes) {
    return ceremonyError(
      'orientation_brief_bound_exceeded',
      'orientation_brief.inline_bytes',
      `${stableBytes} bytes exceeds ${maxInlineBytes}`,
    );
  }
  return assertOrientationBriefIntegrity(candidate);
}

function occupantRole(brief: OrientationBrief): string | null {
  const binding = brief.role_binding as UnknownRecord | null;
  if (!binding) return null;
  const nested = binding.binding && typeof binding.binding === 'object'
    ? binding.binding as UnknownRecord
    : null;
  const value = binding.role ?? binding.role_id ?? nested?.role;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function occupantSelection(selection: OrientationArtifactSelection): JsonObject {
  if (selection.mode === 'omitted') {
    return {
      mode: 'omitted',
      reason_code: selection.reason_code ?? 'not_selected',
    };
  }
  return {
    mode: 'exact',
    snapshot_posture: 'selected_at_carrier_entry_not_live_state',
    source_authority_ref: selection.source_authority_ref,
    artifact_ref: selection.artifact_ref,
    revision: selection.revision,
    summary: selection.summary,
    inspection_call: selection.inspection_call,
  };
}

/**
 * Derive the occupant-facing card without weakening or replacing the exact
 * canonical brief retained by the Carrier and evidence store.
 */
export function buildOrientationOccupantBrief(value: unknown): OrientationOccupantBrief {
  const brief = assertOrientationBriefIntegrity(value);
  const projection: OrientationOccupantBrief = {
    schema: ORIENTATION_OCCUPANT_BRIEF_SCHEMA,
    position: {
      local_agent_id: brief.agent_identity.local_agent_id,
      canonical_agent_id: brief.agent_identity.canonical_agent_id,
      site_ref: brief.coordinate.site_ref,
      carrier_kind: brief.carrier_kind,
      role: occupantRole(brief),
    },
    entry_snapshot_at: brief.generated_at,
    manifest_readiness: brief.readiness,
    continuity: occupantSelection(brief.continuity_selection),
    work: occupantSelection(brief.work_selection),
    required_reads: brief.required_reads.map((step) => ({
      ordinal: step.ordinal,
      source_ref: step.source.artifact_ref,
      purpose: step.source.artifact_ref === 'site-file:AGENTS.md'
        ? 'site_operating_instructions'
        : 'required_orientation_material',
    })),
    residual_codes: brief.residual_codes,
    authority_posture: {
      continuity: 'historical_context_only',
      selected_work: 'entry_orientation_not_action_authority',
      consequential_action: 'owning_admission_still_required',
    },
  };
  const bytes = byteLength(projection);
  if (bytes > MAX_ORIENTATION_OCCUPANT_BRIEF_INLINE_BYTES) {
    return ceremonyError(
      'orientation_occupant_brief_bound_exceeded',
      'orientation_occupant_brief',
      `${bytes} bytes exceeds ${MAX_ORIENTATION_OCCUPANT_BRIEF_INLINE_BYTES}`,
    );
  }
  return deepFreeze(projection);
}

export function buildOrientationReadyProjection(value: unknown): OrientationReadyProjection {
  const brief = buildOrientationOccupantBrief(value);
  const { schema: _schema, required_reads: _requiredReads, ...orientation } = brief;
  const workCall = brief.work.mode === 'exact'
    && brief.work.inspection_call
    && typeof brief.work.inspection_call === 'object'
    ? brief.work.inspection_call as OrientationReadyProjection['next_meaningful_call']
    : null;
  return deepFreeze({
    schema: ORIENTATION_READY_PROJECTION_SCHEMA,
    orientation_status: 'acknowledged',
    ...orientation,
    next_meaningful_call: workCall,
  });
}

export function assertDeliveryReceiptBoundToBrief({
  deliveryReceipt: deliveryValue,
  admissionReceipt: admissionValue,
  brief: briefValue,
}: {
  deliveryReceipt: unknown;
  admissionReceipt: unknown;
  brief: unknown;
}): CarrierSessionOrientationDeliveryReceipt {
  const delivery = parseCarrierSessionOrientationDeliveryReceipt(deliveryValue);
  const admission = parseCarrierSessionAdmissionReceipt(admissionValue);
  const brief = assertOrientationBriefIntegrity(briefValue);
  if (
    delivery.status !== 'delivered'
    || !sameCoordinate(delivery.coordinate, admission.coordinate)
    || !sameCoordinate(delivery.coordinate, brief.coordinate)
    || delivery.admission_receipt_ref !== admission.receipt_id
    || brief.admission_receipt_ref !== admission.receipt_id
    || delivery.manifest_id !== brief.manifest_ref.manifest_id
    || delivery.manifest_digest !== brief.manifest_ref.manifest_digest
    || delivery.brief_id !== brief.brief_id
    || delivery.brief_digest !== brief.brief_digest
  ) {
    return ceremonyError(
      'orientation_delivery_binding_mismatch',
      'delivery_receipt',
      'delivery receipt, admission receipt, and brief must share exact coordinates and identities',
    );
  }
  return delivery;
}

export function issueCarrierSessionOrientationDeliveryReceipt({
  admissionReceipt: admissionValue,
  brief: briefValue,
  deliveredAt,
  authorityReadbackRef = null,
  evidenceRefs = [],
}: {
  admissionReceipt: unknown;
  brief: unknown;
  deliveredAt: string;
  authorityReadbackRef?: string | null;
  evidenceRefs?: readonly string[];
}): CarrierSessionOrientationDeliveryReceipt {
  const admission = parseCarrierSessionAdmissionReceipt(admissionValue);
  const brief = assertOrientationBriefIntegrity(briefValue);
  if (
    !sameCoordinate(admission.coordinate, brief.coordinate)
    || admission.receipt_id !== brief.admission_receipt_ref
  ) {
    return ceremonyError(
      'orientation_brief_admission_mismatch',
      'orientation_brief',
      'brief must be bound to the exact admission receipt',
    );
  }
  const receiptId = [
    'orientation-delivery',
    admission.coordinate.carrier_session_id,
    admission.coordinate.authority_epoch,
    brief.brief_digest.slice(0, 16),
  ].join(':');
  const receipt = parseCarrierSessionOrientationDeliveryReceipt({
    schema: CARRIER_SESSION_DELIVERY_RECEIPT_SCHEMA,
    receipt_id: receiptId,
    status: 'delivered',
    coordinate: admission.coordinate,
    admission_receipt_ref: admission.receipt_id,
    manifest_id: brief.manifest_ref.manifest_id,
    manifest_digest: brief.manifest_ref.manifest_digest,
    brief_id: brief.brief_id,
    brief_digest: brief.brief_digest,
    delivery_mode: 'carrier_entry_injection',
    ordinary_work_gate: 'delivery_required',
    delivered_at: deliveredAt,
    authority_readback_ref: authorityReadbackRef
      ?? `agent-context:orientation_delivery_receipts:${receiptId}`,
    evidence_refs: [...new Set([
      brief.manifest_ref.artifact_ref,
      brief.brief_id,
      ...evidenceRefs,
    ])],
    reason_codes: [],
  });
  return assertDeliveryReceiptBoundToBrief({
    deliveryReceipt: receipt,
    admissionReceipt: admission,
    brief,
  });
}

function matchesExpectedResult(actual: JsonObject, expected: JsonObject): boolean {
  return Object.entries(expected).every(
    ([key, value]) => Object.hasOwn(actual, key) && canonicalJson(actual[key]) === canonicalJson(value),
  );
}

function validateRequiredReadCompletions(
  brief: OrientationBrief,
  completionsValue: readonly unknown[],
  deliveredAt: string,
  acknowledgedAt: string,
): readonly OrientationReadCompletionEvidence[] {
  const completions = completionsValue.map((value, index) => (
    parseOrientationReadCompletionEvidence(value, `required_read_completions[${index}]`)
  ));
  const byStep = new Map(completions.map((completion) => [completion.step_id, completion]));
  if (byStep.size !== completions.length) {
    return ceremonyError(
      'duplicate_read_completion',
      'required_read_completions',
      'each required read may be evidenced once',
    );
  }
  for (const step of brief.required_reads) {
    const completion = byStep.get(step.step_id);
    if (!completion) {
      return ceremonyError(
        'required_read_completion_missing',
        `required_read_completions.${step.step_id}`,
        'all required reads must be evidenced before acknowledgement',
      );
    }
    if (
      completion.tool_name !== step.tool.name
      || canonicalJson(completion.arguments) !== canonicalJson(step.tool.arguments)
      || !matchesExpectedResult(completion.result_evidence, step.completion.expected_result)
      || !step.completion.evidence_fields.every((field) => Object.hasOwn(completion.result_evidence, field))
    ) {
      return ceremonyError(
        'required_read_completion_mismatch',
        `required_read_completions.${step.step_id}`,
        'tool, arguments, and expected result evidence must match the executable read step',
      );
    }
    const completedMs = Date.parse(completion.completed_at);
    if (completedMs < Date.parse(deliveredAt) || completedMs > Date.parse(acknowledgedAt)) {
      return ceremonyError(
        'required_read_completion_time_invalid',
        `required_read_completions.${step.step_id}.completed_at`,
        'completion must occur after delivery and no later than acknowledgement',
      );
    }
  }
  if (completions.some((completion) => !brief.required_reads.some((step) => step.step_id === completion.step_id))) {
    return ceremonyError(
      'unknown_read_completion',
      'required_read_completions',
      'acknowledgement may only cite reads required by this brief',
    );
  }
  return completions;
}

export function issueCarrierSessionOrientationAcknowledgement({
  admissionReceipt: admissionValue,
  deliveryReceipt: deliveryValue,
  brief: briefValue,
  requiredReadCompletions,
  acknowledgedAt,
  authorityReadbackRef,
  evidenceRefs = [],
}: {
  admissionReceipt: unknown;
  deliveryReceipt: unknown;
  brief: unknown;
  requiredReadCompletions: readonly unknown[];
  acknowledgedAt: string;
  authorityReadbackRef: string;
  evidenceRefs?: readonly string[];
}): CarrierSessionOrientationAcknowledgement {
  const admission = parseCarrierSessionAdmissionReceipt(admissionValue);
  const brief = assertOrientationBriefIntegrity(briefValue);
  const delivery = assertDeliveryReceiptBoundToBrief({
    deliveryReceipt: deliveryValue,
    admissionReceipt: admission,
    brief,
  });
  if (!delivery.delivered_at || Date.parse(acknowledgedAt) < Date.parse(delivery.delivered_at)) {
    return ceremonyError(
      'orientation_acknowledgement_time_invalid',
      'acknowledged_at',
      'acknowledgement cannot precede delivery',
    );
  }
  const completions = validateRequiredReadCompletions(
    brief,
    requiredReadCompletions,
    delivery.delivered_at,
    acknowledgedAt,
  );
  const acknowledgementDigest = sha256(canonicalJson({
    delivery_receipt_ref: delivery.receipt_id,
    brief_digest: brief.brief_digest,
    acknowledged_at: acknowledgedAt,
    required_read_completions: completions,
  }));
  return parseCarrierSessionOrientationAcknowledgement({
    schema: ORIENTATION_ACKNOWLEDGEMENT_SCHEMA,
    acknowledgement_id: [
      'orientation-ack',
      admission.coordinate.carrier_session_id,
      admission.coordinate.authority_epoch,
      acknowledgementDigest.slice(0, 16),
    ].join(':'),
    status: 'acknowledged',
    coordinate: admission.coordinate,
    admission_receipt_ref: admission.receipt_id,
    delivery_receipt_ref: delivery.receipt_id,
    manifest_id: brief.manifest_ref.manifest_id,
    manifest_digest: brief.manifest_ref.manifest_digest,
    brief_id: brief.brief_id,
    brief_digest: brief.brief_digest,
    acknowledged_at: acknowledgedAt,
    required_read_completions: completions,
    acknowledgement_semantics: 'receipt_and_required_reads_not_comprehension',
    action_admission: 'separate_required',
    authority_readback_ref: authorityReadbackRef,
    evidence_refs: [...new Set([
      delivery.receipt_id,
      ...completions.flatMap((completion) => completion.evidence_refs),
      ...evidenceRefs,
    ])],
  });
}
