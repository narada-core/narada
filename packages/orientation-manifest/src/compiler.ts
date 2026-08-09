import { createHash } from 'node:crypto';
import {
  CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
  ORIENTATION_COMPARTMENTS,
  ORIENTATION_COMPILATION_RESULT_SCHEMA,
  ORIENTATION_MANIFEST_SCHEMA,
  OrientationContractError,
  deepFreeze,
  parseCarrierSessionActivationReceipt,
  parseCarrierSessionAdmissionReceipt,
  parseOrientationAssemblyPolicy,
  parseOrientationManifest,
  parseOrientationProjectionEntry,
  type CarrierSessionActivationReceipt,
  type CarrierSessionAdmissionReceipt,
  type CarrierSessionAuthorityCoordinate,
  type CompileOrientationManifestInput,
  type JsonObject,
  type JsonValue,
  type OrientationAssemblyPolicy,
  type OrientationCompilationResult,
  type OrientationCompartment,
  type OrientationManifest,
  type OrientationProjectionEntry,
  type OrientationReadiness,
  type OrientationResidual,
} from './contracts.js';

const COMPARTMENT_ORDER = new Map(
  ORIENTATION_COMPARTMENTS.map((compartment, index) => [compartment, index]),
);

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => (
    JSON.stringify(key) + ':' + canonicalJson(value[key] as JsonValue)
  )).join(',') + '}';
}

function jsonBytes(value: JsonValue): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function digest(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OrientationContractError('iso_timestamp_required', path, 'expected a canonical ISO-8601 timestamp');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new OrientationContractError('iso_timestamp_required', path, 'expected a canonical ISO-8601 timestamp');
  }
  return value;
}

function coordinateEquals(
  left: CarrierSessionAuthorityCoordinate,
  right: CarrierSessionAuthorityCoordinate,
): boolean {
  return left.authority_scope === right.authority_scope
    && left.site_ref === right.site_ref
    && left.carrier_session_id === right.carrier_session_id
    && left.authority_epoch === right.authority_epoch;
}

function residual(
  code: string,
  criticality: 'required' | 'optional',
  message: string,
  entry: OrientationProjectionEntry | null = null,
  compartment: OrientationCompartment | null = entry?.compartment ?? null,
): OrientationResidual {
  return deepFreeze({
    code,
    compartment,
    criticality,
    message,
    source_authority_ref: entry?.source_authority_ref ?? null,
    artifact_ref: entry?.artifact_ref ?? null,
    evidence_refs: entry?.evidence_refs ?? [],
  });
}

function projectionSort(left: OrientationProjectionEntry, right: OrientationProjectionEntry): number {
  const criticality = Number(left.criticality === 'optional') - Number(right.criticality === 'optional');
  if (criticality !== 0) return criticality;
  const compartment = (COMPARTMENT_ORDER.get(left.compartment) ?? 999)
    - (COMPARTMENT_ORDER.get(right.compartment) ?? 999);
  if (compartment !== 0) return compartment;
  return compareStrings(left.entry_kind, right.entry_kind)
    || compareStrings(left.source_authority_ref, right.source_authority_ref)
    || compareStrings(left.artifact_ref, right.artifact_ref)
    || compareStrings(left.entry_id, right.entry_id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function effectiveProjection(
  entry: OrientationProjectionEntry,
  generatedAtMs: number,
): OrientationProjectionEntry {
  if (Date.parse(entry.observed_at) > generatedAtMs) {
    return deepFreeze({ ...entry, projection_status: 'incompatible' });
  }
  const expiry = entry.valid_until === null ? Number.POSITIVE_INFINITY : Date.parse(entry.valid_until);
  if (entry.projection_status === 'available' && expiry <= generatedAtMs) {
    return deepFreeze({ ...entry, projection_status: 'stale' });
  }
  return entry;
}

function addUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function addResidual(target: OrientationResidual[], value: OrientationResidual): void {
  if (!target.some((candidate) => (
    candidate.code === value.code
    && candidate.compartment === value.compartment
    && candidate.artifact_ref === value.artifact_ref
  ))) {
    target.push(value);
  }
}

function identityConflictResidual(entry: OrientationProjectionEntry): string {
  return entry.compartment === 'office_and_role'
    ? 'agent_identity_revision_ambiguous'
    : entry.entry_kind + '_revision_ambiguous';
}

function subjectReason(entry: OrientationProjectionEntry): { reason: string; residual: string } {
  if (entry.compartment === 'continuity') {
    return {
      reason: 'continuity_subject_mismatch',
      residual: 'incompatible_continuity_subject',
    };
  }
  return {
    reason: 'projection_subject_mismatch',
    residual: entry.entry_kind + '_subject_mismatch',
  };
}

function projectionFailureReason(entry: OrientationProjectionEntry): string {
  if (entry.compartment === 'law_and_constraints') {
    return 'required_law_projection_' + entry.projection_status;
  }
  return 'required_projection_' + entry.projection_status;
}

function projectionFailureResidual(entry: OrientationProjectionEntry): string {
  if (entry.compartment === 'law_and_constraints' && entry.projection_status === 'unavailable') {
    return 'law_source_unavailable';
  }
  if (entry.compartment === 'authority_references' && entry.projection_status === 'stale') {
    return 'stale_grant_projection';
  }
  return entry.entry_kind + '_' + entry.projection_status;
}

function compactProjection(entry: OrientationProjectionEntry): OrientationProjectionEntry {
  return deepFreeze({
    ...entry,
    payload: {
      projection_omitted_for_budget: true,
      source_entry_id: entry.entry_id,
    },
    rendered_text: null,
  });
}

interface ManifestParts {
  admission: CarrierSessionAdmissionReceipt;
  activation: CarrierSessionActivationReceipt | null;
  policy: OrientationAssemblyPolicy;
  generatedAt: string;
  readiness: OrientationReadiness;
  delivery: 'deliverable' | 'withheld';
  entries: readonly OrientationProjectionEntry[];
  residuals: readonly OrientationResidual[];
  reasons: readonly string[];
  omittedEntries: number;
}

function manifestSource(parts: ManifestParts): JsonObject {
  return {
    schema: ORIENTATION_MANIFEST_SCHEMA,
    generated_at: parts.generatedAt,
    coordinate: parts.admission.coordinate as unknown as JsonObject,
    admission_receipt_ref: parts.admission.receipt_id,
    agent_identity: parts.admission.agent_identity as unknown as JsonObject,
    carrier_kind: parts.admission.carrier_kind,
    assembly_policy: {
      source_authority_ref: 'orientation-assembly-policy',
      artifact_ref: parts.policy.policy_ref,
      revision: parts.policy.revision,
    },
    runtime_binding: (parts.activation?.decision === 'activated'
      ? parts.activation.runtime_binding
      : null) as unknown as JsonValue,
    readiness: parts.readiness,
    delivery: parts.delivery,
    action_admission: 'separate_required',
    entries: parts.entries as unknown as JsonValue,
    residuals: parts.residuals as unknown as JsonValue,
    negative_claims: parts.policy.negative_claims.map((claim) => ({
      ...claim,
      source_authority_ref: parts.policy.policy_ref,
      revision: parts.policy.revision,
    })) as unknown as JsonValue,
    reason_codes: parts.reasons as unknown as JsonValue,
    bounds: {
      max_entries: parts.policy.max_entries,
      max_rendered_bytes: parts.policy.max_rendered_bytes,
      max_manifest_bytes: parts.policy.max_manifest_bytes,
      included_entries: parts.entries.length,
      rendered_bytes: parts.entries.reduce(
        (total, entry) => total + new TextEncoder().encode(entry.rendered_text ?? '').byteLength,
        0,
      ),
      manifest_bytes: 0,
      omitted_entries: parts.omittedEntries,
    },
  };
}

function provisionalManifest(parts: ManifestParts): OrientationManifest {
  const source = manifestSource(parts);
  const sourceDigest = digest(source);
  const session = parts.admission.coordinate.carrier_session_id.replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    ...source,
    manifest_id: 'orientation:' + session + ':' + parts.admission.coordinate.authority_epoch + ':' + sourceDigest.slice(0, 16),
    manifest_digest: sourceDigest,
  } as unknown as OrientationManifest;
}

function stabilizeManifestByteCount(initial: OrientationManifest): OrientationManifest {
  let result = {
    ...initial,
    bounds: { ...initial.bounds, manifest_bytes: 1 },
  } as OrientationManifest;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const correctedBytes = jsonBytes(result as unknown as JsonValue);
    if (correctedBytes === result.bounds.manifest_bytes) return result;
    result = {
      ...result,
      bounds: { ...result.bounds, manifest_bytes: correctedBytes },
    };
  }
  throw new OrientationContractError(
    'manifest_byte_count_unstable',
    'manifest.bounds.manifest_bytes',
    'canonical manifest byte count did not converge',
  );
}

function estimatedManifestBytes(parts: ManifestParts): number {
  return stabilizeManifestByteCount(provisionalManifest(parts)).bounds.manifest_bytes;
}

function finalizeManifest(parts: ManifestParts): OrientationManifest {
  return deepFreeze(stabilizeManifestByteCount(provisionalManifest(parts)));
}

function manifestIntegritySource(manifest: OrientationManifest): JsonObject {
  const {
    manifest_id: _manifestId,
    manifest_digest: _manifestDigest,
    bounds,
    ...source
  } = manifest;
  return {
    ...(source as unknown as JsonObject),
    bounds: {
      ...bounds,
      manifest_bytes: 0,
    },
  } as unknown as JsonObject;
}

function expectedManifestId(manifest: OrientationManifest, manifestDigest: string): string {
  const session = manifest.coordinate.carrier_session_id.replace(/[^A-Za-z0-9._-]/g, '_');
  return 'orientation:' + session + ':' + manifest.coordinate.authority_epoch
    + ':' + manifestDigest.slice(0, 16);
}

export function assertOrientationManifestIntegrity(value: unknown): OrientationManifest {
  const manifest = parseOrientationManifest(value);
  const actualDigest = digest(manifestIntegritySource(manifest));
  if (manifest.manifest_digest !== actualDigest) {
    throw new OrientationContractError(
      'manifest_digest_mismatch',
      'orientation_manifest.manifest_digest',
      'manifest content does not match its immutable generation digest',
    );
  }
  if (manifest.manifest_id !== expectedManifestId(manifest, actualDigest)) {
    throw new OrientationContractError(
      'manifest_id_mismatch',
      'orientation_manifest.manifest_id',
      'manifest identity does not match its session, authority epoch, and digest',
    );
  }
  const actualBytes = jsonBytes(manifest as unknown as JsonValue);
  if (manifest.bounds.manifest_bytes !== actualBytes) {
    throw new OrientationContractError(
      'manifest_byte_count_mismatch',
      'orientation_manifest.bounds.manifest_bytes',
      'manifest canonical byte count does not match its declared bound evidence',
    );
  }
  return manifest;
}

export function assertManifestBoundToAdmission(
  manifestValue: unknown,
  admissionValue: unknown,
): OrientationManifest {
  const manifest = assertOrientationManifestIntegrity(manifestValue);
  const admission = parseCarrierSessionAdmissionReceipt(admissionValue);
  if (admission.decision !== 'admitted') {
    throw new OrientationContractError(
      'exact_admission_receipt_required',
      'admission_receipt.decision',
      'manifest delivery requires an admitted starting receipt',
    );
  }
  if (!coordinateEquals(manifest.coordinate, admission.coordinate)) {
    throw new OrientationContractError(
      'manifest_session_binding_mismatch',
      'manifest.coordinate',
      'manifest and admission coordinates differ',
    );
  }
  if (manifest.admission_receipt_ref !== admission.receipt_id) {
    throw new OrientationContractError(
      'stale_admission_receipt',
      'manifest.admission_receipt_ref',
      'manifest names a different admission receipt',
    );
  }
  if (
    manifest.agent_identity.source_authority_ref !== admission.agent_identity.source_authority_ref
    || manifest.agent_identity.local_agent_id !== admission.agent_identity.local_agent_id
    || manifest.agent_identity.canonical_agent_id !== admission.agent_identity.canonical_agent_id
    || manifest.agent_identity.artifact_ref !== admission.agent_identity.artifact_ref
    || manifest.agent_identity.revision !== admission.agent_identity.revision
  ) {
    throw new OrientationContractError(
      'manifest_agent_binding_mismatch',
      'manifest.agent_identity',
      'manifest and admission Agent identity references differ',
    );
  }
  if (manifest.carrier_kind !== admission.carrier_kind) {
    throw new OrientationContractError(
      'manifest_carrier_kind_mismatch',
      'manifest.carrier_kind',
      'manifest and admission Carrier kinds differ',
    );
  }
  return manifest;
}

export function compileOrientationManifest(
  input: CompileOrientationManifestInput,
): OrientationCompilationResult {
  if (typeof input !== 'object' || input === null) {
    throw new OrientationContractError('compiler_input_required', 'input', 'expected compiler input');
  }
  const generatedAt = timestamp(input.generated_at, 'generated_at');
  const generatedAtMs = Date.parse(generatedAt);
  const admission = parseCarrierSessionAdmissionReceipt(input.admission_receipt);
  if (admission.schema !== CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA || admission.decision !== 'admitted') {
    throw new OrientationContractError(
      'exact_admission_receipt_required',
      'admission_receipt',
      'orientation assembly requires an exact admitted starting receipt',
    );
  }
  const policy = parseOrientationAssemblyPolicy(input.assembly_policy);
  const activation = input.activation_receipt === undefined || input.activation_receipt === null
    ? null
    : parseCarrierSessionActivationReceipt(input.activation_receipt);
  if (!Array.isArray(input.projections)) {
    throw new OrientationContractError(
      'projection_array_required',
      'projections',
      'orientation assembly requires an array of source projections',
    );
  }
  const parsed = input.projections.map((entry, index) => (
    effectiveProjection(parseOrientationProjectionEntry(entry, 'projections[' + index + ']'), generatedAtMs)
  ));
  if (new Set(parsed.map((entry) => entry.entry_id)).size !== parsed.length) {
    throw new OrientationContractError(
      'duplicate_projection_entry',
      'projections',
      'entry_id values must be unique',
    );
  }

  const reasons: string[] = [];
  const residuals: OrientationResidual[] = [];
  const excludedEntryIds = new Set<string>();
  let readinessBlocked = false;
  let readinessDegraded = false;
  let deliveryBlocked = false;

  if (generatedAtMs < Date.parse(admission.issued_at)) {
    readinessBlocked = true;
    deliveryBlocked = true;
    addUnique(reasons, 'assembly_precedes_admission');
    addResidual(residuals, residual(
      'admission_receipt_not_yet_issued',
      'required',
      'The manifest generation timestamp precedes the admission receipt.',
    ));
  }

  if (admission.valid_until !== null && Date.parse(admission.valid_until) <= generatedAtMs) {
    readinessBlocked = true;
    deliveryBlocked = true;
    addUnique(reasons, 'admission_receipt_expired');
    addResidual(residuals, residual(
      'stale_admission_receipt',
      'required',
      'The Carrier Session admission receipt expired before assembly.',
    ));
  }

  if (activation !== null) {
    const activationIssuedAt = Date.parse(activation.issued_at);
    if (
      activationIssuedAt < Date.parse(admission.issued_at)
      || activationIssuedAt > generatedAtMs
    ) {
      readinessBlocked = true;
      deliveryBlocked = true;
      addUnique(reasons, 'activation_receipt_temporally_invalid');
      addResidual(residuals, residual(
        'incompatible_activation_receipt',
        'required',
        'Activation receipt issuance is outside the admission-to-assembly interval.',
      ));
    }
    if (
      activation.runtime_binding !== null
      && Date.parse(activation.runtime_binding.observed_at) > activationIssuedAt
    ) {
      readinessBlocked = true;
      deliveryBlocked = true;
      addUnique(reasons, 'activation_runtime_observation_after_receipt');
      addResidual(residuals, residual(
        'incompatible_runtime_binding',
        'required',
        'Runtime observation occurred after the activation receipt that cites it.',
      ));
    }
    if (!coordinateEquals(activation.coordinate, admission.coordinate)) {
      readinessBlocked = true;
      deliveryBlocked = true;
      const sameSession = activation.coordinate.authority_scope === admission.coordinate.authority_scope
        && activation.coordinate.site_ref === admission.coordinate.site_ref
        && activation.coordinate.carrier_session_id === admission.coordinate.carrier_session_id;
      addUnique(reasons, sameSession ? 'authority_epoch_fenced' : 'activation_session_binding_mismatch');
      addResidual(residuals, residual(
        sameSession ? 'stale_admission_receipt' : 'incompatible_activation_receipt',
        'required',
        'Activation and starting-admission coordinates do not match.',
      ));
    }
    if (activation.admission_receipt_ref !== admission.receipt_id) {
      readinessBlocked = true;
      deliveryBlocked = true;
      addUnique(reasons, 'activation_admission_receipt_mismatch');
      addResidual(residuals, residual(
        'stale_admission_receipt',
        'required',
        'Activation names a different starting-admission receipt.',
      ));
    }
    if (activation.decision === 'refused') {
      deliveryBlocked = true;
      for (const reason of activation.reason_codes) addUnique(reasons, reason);
    }
    if (
      activation.runtime_binding !== null
      && activation.runtime_binding.owning_site_ref !== admission.coordinate.site_ref
    ) {
      deliveryBlocked = true;
      addUnique(reasons, 'runtime_binding_site_mismatch');
      addResidual(residuals, residual(
        'cross_site_runtime_binding',
        'required',
        'The observed runtime binding belongs to another Site.',
      ));
    }
  }

  const revisions = new Map<string, Map<string, OrientationProjectionEntry>>();
  for (const entry of parsed) {
    const key = entry.source_authority_ref + '|' + entry.artifact_ref;
    const byRevision = revisions.get(key) ?? new Map<string, OrientationProjectionEntry>();
    byRevision.set(entry.revision, entry);
    revisions.set(key, byRevision);
  }
  for (const byRevision of revisions.values()) {
    if (byRevision.size <= 1) continue;
    readinessBlocked = true;
    deliveryBlocked = true;
    const entry = [...byRevision.values()].sort(projectionSort)[0]!;
    addUnique(reasons, 'source_revision_conflict');
    addResidual(residuals, residual(
      identityConflictResidual(entry),
      'required',
      'The same source artifact was projected at conflicting revisions.',
      entry,
    ));
  }

  const requiredKinds = new Set(policy.required_entry_kinds);
  for (const entry of parsed) {
    const required = requiredKinds.has(entry.entry_kind) || entry.criticality === 'required';
    if (
      entry.subject.site_ref !== admission.coordinate.site_ref
      || entry.subject.agent_ref !== admission.agent_identity.artifact_ref
      || (
        entry.subject.carrier_session_id !== null
        && entry.subject.carrier_session_id !== admission.coordinate.carrier_session_id
      )
    ) {
      const finding = subjectReason(entry);
      readinessBlocked = true;
      deliveryBlocked = true;
      addUnique(reasons, finding.reason);
      addResidual(residuals, residual(
        finding.residual,
        required ? 'required' : 'optional',
        'Projection subject does not match the admitted embodiment.',
        entry,
      ));
      excludedEntryIds.add(entry.entry_id);
      continue;
    }
    if (requiredKinds.has(entry.entry_kind) && entry.criticality !== 'required') {
      readinessBlocked = true;
      deliveryBlocked = true;
      addUnique(reasons, 'required_projection_mislabeled_optional');
      addResidual(residuals, residual(
        entry.entry_kind + '_criticality_mismatch',
        'required',
        'Assembly policy requires this entry kind, but the adapter marked it optional.',
        entry,
      ));
    }
    if (Date.parse(entry.observed_at) > generatedAtMs) {
      addResidual(residuals, residual(
        entry.entry_kind + '_observation_after_assembly',
        required ? 'required' : 'optional',
        'Projection observation occurred after this manifest generation.',
        entry,
      ));
      addUnique(reasons, 'projection_observation_after_assembly');
      excludedEntryIds.add(entry.entry_id);
      if (required) {
        readinessBlocked = true;
        deliveryBlocked = true;
      } else {
        readinessDegraded = true;
      }
      continue;
    }
    if (entry.projection_status !== 'available') {
      addResidual(residuals, residual(
        projectionFailureResidual(entry),
        required ? 'required' : 'optional',
        'Projection is ' + entry.projection_status + '.',
        entry,
      ));
      if (required) {
        readinessBlocked = true;
        deliveryBlocked = true;
        addUnique(reasons, projectionFailureReason(entry));
      } else {
        readinessDegraded = true;
        if (entry.compartment === 'authority_references' && entry.projection_status === 'stale') {
          addUnique(reasons, 'grant_live_revalidation_required');
        } else {
          addUnique(reasons, 'optional_projection_' + entry.projection_status);
        }
      }
    }
  }

  for (const requiredKind of policy.required_entry_kinds) {
    if (!parsed.some((entry) => entry.entry_kind === requiredKind)) {
      readinessBlocked = true;
      deliveryBlocked = true;
      addUnique(reasons, 'required_projection_missing');
      addResidual(residuals, residual(
        'required_' + requiredKind + '_projection_missing',
        'required',
        'Assembly policy requires entry kind ' + requiredKind + '.',
      ));
    }
  }

  if (
    policy.continuity_selection === 'exact_required'
    && !parsed.some((entry) => (
      entry.compartment === 'continuity'
      && entry.projection_status === 'available'
      && entry.subject.carrier_session_id === admission.coordinate.carrier_session_id
    ))
  ) {
    readinessBlocked = true;
    deliveryBlocked = true;
    addUnique(reasons, 'exact_continuity_reference_required');
    addResidual(residuals, residual(
      'continuity_selection_ambiguous',
      'required',
      'This posture requires one exact, session-bound continuity reference.',
      null,
      'continuity',
    ));
  }

  const selected: OrientationProjectionEntry[] = [];
  let renderedBytes = 0;
  let omittedEntries = 0;
  for (const entry of [...parsed].sort(projectionSort)) {
    if (excludedEntryIds.has(entry.entry_id)) {
      omittedEntries += 1;
      continue;
    }
    const required = requiredKinds.has(entry.entry_kind) || entry.criticality === 'required';
    const entryRenderedBytes = new TextEncoder().encode(entry.rendered_text ?? '').byteLength;
    const countFits = selected.length < policy.max_entries;
    const renderingFits = renderedBytes + entryRenderedBytes <= policy.max_rendered_bytes;
    if (countFits && renderingFits) {
      selected.push(entry);
      renderedBytes += entryRenderedBytes;
      continue;
    }
    omittedEntries += 1;
    if (required) {
      readinessBlocked = true;
      deliveryBlocked = true;
      addUnique(reasons, 'required_entries_exceed_budget');
      addResidual(residuals, residual(
        'required_entry_omitted_for_budget',
        'required',
        'A required entry cannot fit within the declared packet bounds.',
        entry,
      ));
      if (countFits) selected.push(compactProjection(entry));
    } else {
      readinessDegraded = true;
      addUnique(reasons, 'optional_entry_omitted_for_budget');
      addResidual(residuals, residual(
        entry.compartment === 'continuity'
          ? 'continuity_omission_with_source_ref'
          : 'optional_entry_omitted_for_budget',
        'optional',
        'An optional entry was omitted to preserve the declared packet bounds.',
        entry,
      ));
    }
  }

  function currentParts(): ManifestParts {
    const readiness: OrientationReadiness = readinessBlocked
      ? 'blocked'
      : readinessDegraded
        ? 'degraded'
        : 'ready';
    return {
      admission,
      activation,
      policy,
      generatedAt,
      readiness,
      delivery: readiness === 'blocked' || deliveryBlocked ? 'withheld' : 'deliverable',
      entries: selected,
      residuals,
      reasons,
      omittedEntries,
    };
  }

  while (estimatedManifestBytes(currentParts()) > policy.max_manifest_bytes) {
    let optionalIndex = -1;
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const entry = selected[index]!;
      if (entry.criticality === 'optional' && !requiredKinds.has(entry.entry_kind)) {
        optionalIndex = index;
        break;
      }
    }
    if (optionalIndex >= 0) {
      const [entry] = selected.splice(optionalIndex, 1);
      omittedEntries += 1;
      readinessDegraded = true;
      addUnique(reasons, 'optional_entry_omitted_for_budget');
      addResidual(residuals, residual(
        entry!.compartment === 'continuity'
          ? 'continuity_omission_with_source_ref'
          : 'optional_entry_omitted_for_budget',
        'optional',
        'An optional entry was omitted to preserve the total manifest bound.',
        entry!,
      ));
      continue;
    }
    const compactableIndex = selected.findIndex((entry) => (
      entry.rendered_text !== null
      || !('projection_omitted_for_budget' in entry.payload)
    ));
    if (compactableIndex >= 0) {
      const entry = selected[compactableIndex]!;
      selected[compactableIndex] = compactProjection(entry);
      readinessBlocked = true;
      deliveryBlocked = true;
      addUnique(reasons, 'required_entries_exceed_budget');
      addResidual(residuals, residual(
        'required_entry_payload_omitted_for_budget',
        'required',
        'Required source material exceeded the total manifest bound; only its source reference remains.',
        entry,
      ));
      continue;
    }
    throw new OrientationContractError(
      'manifest_budget_unrepresentable',
      'assembly_policy.max_manifest_bytes',
      'the declared bound cannot represent coordinates, residuals, and source references',
    );
  }

  const manifest = finalizeManifest(currentParts());
  if (manifest.bounds.manifest_bytes > policy.max_manifest_bytes) {
    throw new OrientationContractError(
      'manifest_budget_exceeded',
      'manifest.bounds.manifest_bytes',
      'final manifest exceeds the declared total bound',
    );
  }
  return deepFreeze({
    schema: ORIENTATION_COMPILATION_RESULT_SCHEMA,
    status: 'compiled',
    source_mutation: false,
    manifest,
  });
}
