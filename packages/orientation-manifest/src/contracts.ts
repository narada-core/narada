export const CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA = 'narada.carrier_session.admission_receipt.v0' as const;
export const CARRIER_SESSION_DELIVERY_RECEIPT_SCHEMA = 'narada.carrier_session.orientation_delivery_receipt.v0' as const;
export const CARRIER_SESSION_ACTIVATION_RECEIPT_SCHEMA = 'narada.carrier_session.activation_receipt.v0' as const;
export const ORIENTATION_ASSEMBLY_POLICY_SCHEMA = 'narada.orientation_manifest.assembly_policy.v0' as const;
export const ORIENTATION_MANIFEST_SCHEMA = 'narada.orientation_manifest.v0' as const;
export const ORIENTATION_COMPILATION_RESULT_SCHEMA = 'narada.orientation_manifest.compilation_result.v0' as const;

export const ORIENTATION_COMPARTMENTS = [
  'embodiment_coordinates',
  'office_and_role',
  'law_and_constraints',
  'entry_procedure',
  'continuity',
  'work_orientation',
  'capability_projection',
  'authority_references',
  'obligations',
  'negative_claims',
] as const;

export const ORIENTATION_PROJECTION_STATUSES = [
  'available',
  'omitted',
  'unavailable',
  'stale',
  'incompatible',
  'rejected',
] as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type OrientationCompartment = typeof ORIENTATION_COMPARTMENTS[number];
export type OrientationProjectionStatus = typeof ORIENTATION_PROJECTION_STATUSES[number];
export type OrientationCriticality = 'required' | 'optional';
export type OrientationReadiness = 'ready' | 'degraded' | 'blocked';

export interface SourceArtifactReference {
  readonly source_authority_ref: string;
  readonly artifact_ref: string;
  readonly revision: string;
}

export interface AdmittedAgentIdentityReference extends SourceArtifactReference {
  readonly local_agent_id: string;
  readonly canonical_agent_id: string;
}

export interface CarrierSessionAuthorityCoordinate {
  readonly authority_scope: string;
  readonly site_ref: string;
  readonly carrier_session_id: string;
  readonly authority_epoch: number;
}

export interface OrientationSubject {
  readonly site_ref: string;
  readonly agent_ref: string;
  readonly carrier_session_id: string | null;
}

export interface CarrierSessionAdmissionReceipt {
  readonly schema: typeof CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA;
  readonly receipt_id: string;
  readonly decision: 'admitted' | 'refused';
  readonly state: 'starting' | 'refused';
  readonly coordinate: CarrierSessionAuthorityCoordinate;
  readonly agent_identity: AdmittedAgentIdentityReference;
  readonly carrier_kind: string;
  readonly admission_policy: SourceArtifactReference;
  readonly issued_at: string;
  readonly valid_until: string | null;
  readonly authority_readback_ref: string;
  readonly evidence_refs: readonly string[];
  readonly reason_codes: readonly string[];
}

export interface RuntimeBindingReference extends SourceArtifactReference {
  readonly owning_site_ref: string;
  readonly observed_at: string;
}

export interface CarrierSessionActivationReceipt {
  readonly schema: typeof CARRIER_SESSION_ACTIVATION_RECEIPT_SCHEMA;
  readonly receipt_id: string;
  readonly decision: 'activated' | 'refused';
  readonly state: 'active' | 'starting';
  readonly coordinate: CarrierSessionAuthorityCoordinate;
  readonly admission_receipt_ref: string;
  readonly runtime_binding: RuntimeBindingReference | null;
  readonly issued_at: string;
  readonly authority_readback_ref: string;
  readonly evidence_refs: readonly string[];
  readonly reason_codes: readonly string[];
}

export interface CarrierSessionOrientationDeliveryReceipt {
  readonly schema: typeof CARRIER_SESSION_DELIVERY_RECEIPT_SCHEMA;
  readonly receipt_id: string;
  readonly status: 'delivered' | 'withheld';
  readonly coordinate: CarrierSessionAuthorityCoordinate;
  readonly admission_receipt_ref: string;
  readonly manifest_id: string | null;
  readonly manifest_digest: string | null;
  readonly delivered_at: string | null;
  readonly authority_readback_ref: string;
  readonly evidence_refs: readonly string[];
  readonly reason_codes: readonly string[];
}

export interface OrientationNegativeClaimPolicyEntry {
  readonly claim_id: string;
  readonly statement: string;
}

export interface OrientationAssemblyPolicy {
  readonly schema: typeof ORIENTATION_ASSEMBLY_POLICY_SCHEMA;
  readonly policy_ref: string;
  readonly revision: string;
  readonly required_entry_kinds: readonly string[];
  readonly max_entries: number;
  readonly max_rendered_bytes: number;
  readonly max_manifest_bytes: number;
  readonly continuity_selection: 'exact_or_omitted' | 'exact_required';
  readonly optional_entry_behavior: 'degrade';
  readonly negative_claims: readonly OrientationNegativeClaimPolicyEntry[];
}

export interface OrientationProjectionEntry {
  readonly entry_id: string;
  readonly compartment: OrientationCompartment;
  readonly entry_kind: string;
  readonly subject: OrientationSubject;
  readonly source_authority_ref: string;
  readonly artifact_ref: string;
  readonly revision: string;
  readonly observed_at: string;
  readonly valid_until: string | null;
  readonly criticality: OrientationCriticality;
  readonly projection_status: OrientationProjectionStatus;
  readonly revalidation_rule: string;
  readonly evidence_refs: readonly string[];
  readonly payload: JsonObject;
  readonly rendered_text: string | null;
}

export interface OrientationResidual {
  readonly code: string;
  readonly compartment: OrientationCompartment | null;
  readonly criticality: OrientationCriticality;
  readonly message: string;
  readonly source_authority_ref: string | null;
  readonly artifact_ref: string | null;
  readonly evidence_refs: readonly string[];
}

export interface OrientationNegativeClaim {
  readonly claim_id: string;
  readonly statement: string;
  readonly source_authority_ref: string;
  readonly revision: string;
}

export interface OrientationManifest {
  readonly schema: typeof ORIENTATION_MANIFEST_SCHEMA;
  readonly manifest_id: string;
  readonly manifest_digest: string;
  readonly generated_at: string;
  readonly coordinate: CarrierSessionAuthorityCoordinate;
  readonly admission_receipt_ref: string;
  readonly agent_identity: AdmittedAgentIdentityReference;
  readonly carrier_kind: string;
  readonly assembly_policy: SourceArtifactReference;
  readonly runtime_binding: RuntimeBindingReference | null;
  readonly readiness: OrientationReadiness;
  readonly delivery: 'deliverable' | 'withheld';
  readonly action_admission: 'separate_required';
  readonly entries: readonly OrientationProjectionEntry[];
  readonly residuals: readonly OrientationResidual[];
  readonly negative_claims: readonly OrientationNegativeClaim[];
  readonly reason_codes: readonly string[];
  readonly bounds: {
    readonly max_entries: number;
    readonly max_rendered_bytes: number;
    readonly max_manifest_bytes: number;
    readonly included_entries: number;
    readonly rendered_bytes: number;
    readonly manifest_bytes: number;
    readonly omitted_entries: number;
  };
}

export interface CompileOrientationManifestInput {
  readonly admission_receipt: CarrierSessionAdmissionReceipt;
  readonly activation_receipt?: CarrierSessionActivationReceipt | null;
  readonly assembly_policy: OrientationAssemblyPolicy;
  readonly projections: readonly OrientationProjectionEntry[];
  readonly generated_at: string;
}

export interface OrientationCompilationResult {
  readonly schema: typeof ORIENTATION_COMPILATION_RESULT_SCHEMA;
  readonly status: 'compiled';
  readonly source_mutation: false;
  readonly manifest: OrientationManifest;
}

export class OrientationContractError extends TypeError {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(`${code}:${path}:${message}`);
    this.name = 'OrientationContractError';
    this.code = code;
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

function contractError(code: string, path: string, message: string): never {
  throw new OrientationContractError(code, path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return contractError('object_required', path, 'expected an object');
  }
  return value as UnknownRecord;
}

function onlyKeys(value: UnknownRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    contractError('unexpected_field', `${path}.${unexpected[0]}`, 'field is not part of this contract version');
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return contractError('string_required', path, 'expected a non-empty string');
  }
  return value.trim();
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : requiredString(value, path);
}

function isoTimestamp(value: unknown, path: string): string {
  const candidate = requiredString(value, path);
  const time = Date.parse(candidate);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== candidate) {
    return contractError('iso_timestamp_required', path, 'expected a canonical ISO-8601 timestamp');
  }
  return candidate;
}

function nullableIsoTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : isoTimestamp(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return contractError('positive_integer_required', path, 'expected a positive safe integer');
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return contractError('non_negative_integer_required', path, 'expected a non-negative safe integer');
  }
  return Number(value);
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) return contractError('array_required', path, 'expected an array');
  return value.map((entry, index) => requiredString(entry, `${path}[${index}]`));
}

function uniqueStrings(value: unknown, path: string): readonly string[] {
  const values = stringArray(value, path);
  if (new Set(values).size !== values.length) {
    contractError('duplicate_value', path, 'values must be unique');
  }
  return values;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return contractError('enum_value_required', path, `expected one of ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as UnknownRecord).map(([key, entry]) => [key, jsonValue(entry, `${path}.${key}`)]),
    );
  }
  return contractError('json_value_required', path, 'expected a finite JSON value');
}

function jsonObject(value: unknown, path: string): JsonObject {
  const parsed = jsonValue(value, path);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    return contractError('json_object_required', path, 'expected a JSON object');
  }
  return parsed;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function parseSourceArtifactReference(value: unknown, path = 'source_artifact_ref'): SourceArtifactReference {
  const input = record(value, path);
  onlyKeys(input, ['source_authority_ref', 'artifact_ref', 'revision'], path);
  return deepFreeze({
    source_authority_ref: requiredString(input.source_authority_ref, `${path}.source_authority_ref`),
    artifact_ref: requiredString(input.artifact_ref, `${path}.artifact_ref`),
    revision: requiredString(input.revision, `${path}.revision`),
  });
}

export function parseAdmittedAgentIdentityReference(
  value: unknown,
  path = 'agent_identity',
): AdmittedAgentIdentityReference {
  const input = record(value, path);
  onlyKeys(input, [
    'source_authority_ref', 'artifact_ref', 'revision', 'local_agent_id', 'canonical_agent_id',
  ], path);
  return deepFreeze({
    source_authority_ref: requiredString(input.source_authority_ref, path + '.source_authority_ref'),
    artifact_ref: requiredString(input.artifact_ref, path + '.artifact_ref'),
    revision: requiredString(input.revision, path + '.revision'),
    local_agent_id: requiredString(input.local_agent_id, path + '.local_agent_id'),
    canonical_agent_id: requiredString(input.canonical_agent_id, path + '.canonical_agent_id'),
  });
}

export function parseCarrierSessionAuthorityCoordinate(
  value: unknown,
  path = 'coordinate',
): CarrierSessionAuthorityCoordinate {
  const input = record(value, path);
  onlyKeys(input, ['authority_scope', 'site_ref', 'carrier_session_id', 'authority_epoch'], path);
  return deepFreeze({
    authority_scope: requiredString(input.authority_scope, `${path}.authority_scope`),
    site_ref: requiredString(input.site_ref, `${path}.site_ref`),
    carrier_session_id: requiredString(input.carrier_session_id, `${path}.carrier_session_id`),
    authority_epoch: positiveInteger(input.authority_epoch, `${path}.authority_epoch`),
  });
}

export function parseOrientationSubject(value: unknown, path = 'subject'): OrientationSubject {
  const input = record(value, path);
  onlyKeys(input, ['site_ref', 'agent_ref', 'carrier_session_id'], path);
  return deepFreeze({
    site_ref: requiredString(input.site_ref, `${path}.site_ref`),
    agent_ref: requiredString(input.agent_ref, `${path}.agent_ref`),
    carrier_session_id: nullableString(input.carrier_session_id, `${path}.carrier_session_id`),
  });
}

export function parseCarrierSessionAdmissionReceipt(value: unknown): CarrierSessionAdmissionReceipt {
  const path = 'admission_receipt';
  const input = record(value, path);
  onlyKeys(input, [
    'schema', 'receipt_id', 'decision', 'state', 'coordinate', 'agent_identity', 'carrier_kind',
    'admission_policy', 'issued_at', 'valid_until', 'authority_readback_ref', 'evidence_refs', 'reason_codes',
  ], path);
  if (input.schema !== CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA) {
    contractError('schema_mismatch', `${path}.schema`, CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA);
  }
  const decision = enumValue(input.decision, ['admitted', 'refused'] as const, `${path}.decision`);
  const state = enumValue(input.state, ['starting', 'refused'] as const, `${path}.state`);
  const reasonCodes = uniqueStrings(input.reason_codes, `${path}.reason_codes`);
  if ((decision === 'admitted') !== (state === 'starting')) {
    contractError('admission_state_mismatch', `${path}.state`, 'admitted requires starting; refused requires refused');
  }
  if (decision === 'refused' && reasonCodes.length === 0) {
    contractError('refusal_reason_required', `${path}.reason_codes`, 'a refused receipt must explain the refusal');
  }
  const issuedAt = isoTimestamp(input.issued_at, `${path}.issued_at`);
  const validUntil = nullableIsoTimestamp(input.valid_until, `${path}.valid_until`);
  if (validUntil !== null && Date.parse(validUntil) <= Date.parse(issuedAt)) {
    contractError(
      'admission_validity_interval_invalid',
      `${path}.valid_until`,
      'valid_until must be later than issued_at',
    );
  }
  return deepFreeze({
    schema: CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA,
    receipt_id: requiredString(input.receipt_id, `${path}.receipt_id`),
    decision,
    state,
    coordinate: parseCarrierSessionAuthorityCoordinate(input.coordinate, `${path}.coordinate`),
    agent_identity: parseAdmittedAgentIdentityReference(input.agent_identity, `${path}.agent_identity`),
    carrier_kind: requiredString(input.carrier_kind, `${path}.carrier_kind`),
    admission_policy: parseSourceArtifactReference(input.admission_policy, `${path}.admission_policy`),
    issued_at: issuedAt,
    valid_until: validUntil,
    authority_readback_ref: requiredString(input.authority_readback_ref, `${path}.authority_readback_ref`),
    evidence_refs: uniqueStrings(input.evidence_refs, `${path}.evidence_refs`),
    reason_codes: reasonCodes,
  });
}

export function parseRuntimeBindingReference(value: unknown, path = 'runtime_binding'): RuntimeBindingReference {
  const input = record(value, path);
  onlyKeys(input, ['source_authority_ref', 'artifact_ref', 'revision', 'owning_site_ref', 'observed_at'], path);
  return deepFreeze({
    ...parseSourceArtifactReference({
      source_authority_ref: input.source_authority_ref,
      artifact_ref: input.artifact_ref,
      revision: input.revision,
    }, path),
    owning_site_ref: requiredString(input.owning_site_ref, `${path}.owning_site_ref`),
    observed_at: isoTimestamp(input.observed_at, `${path}.observed_at`),
  });
}

export function parseCarrierSessionActivationReceipt(value: unknown): CarrierSessionActivationReceipt {
  const path = 'activation_receipt';
  const input = record(value, path);
  onlyKeys(input, [
    'schema', 'receipt_id', 'decision', 'state', 'coordinate', 'admission_receipt_ref', 'runtime_binding',
    'issued_at', 'authority_readback_ref', 'evidence_refs', 'reason_codes',
  ], path);
  if (input.schema !== CARRIER_SESSION_ACTIVATION_RECEIPT_SCHEMA) {
    contractError('schema_mismatch', `${path}.schema`, CARRIER_SESSION_ACTIVATION_RECEIPT_SCHEMA);
  }
  const decision = enumValue(input.decision, ['activated', 'refused'] as const, `${path}.decision`);
  const state = enumValue(input.state, ['active', 'starting'] as const, `${path}.state`);
  const runtimeBinding = input.runtime_binding === null
    ? null
    : parseRuntimeBindingReference(input.runtime_binding, `${path}.runtime_binding`);
  const reasonCodes = uniqueStrings(input.reason_codes, `${path}.reason_codes`);
  if (decision === 'activated' && (state !== 'active' || runtimeBinding === null)) {
    contractError('activation_evidence_required', path, 'activation requires active state and one exact runtime binding');
  }
  if (decision === 'refused' && (state !== 'starting' || reasonCodes.length === 0)) {
    contractError('activation_refusal_invalid', path, 'refusal requires starting state and a reason code');
  }
  return deepFreeze({
    schema: CARRIER_SESSION_ACTIVATION_RECEIPT_SCHEMA,
    receipt_id: requiredString(input.receipt_id, `${path}.receipt_id`),
    decision,
    state,
    coordinate: parseCarrierSessionAuthorityCoordinate(input.coordinate, `${path}.coordinate`),
    admission_receipt_ref: requiredString(input.admission_receipt_ref, `${path}.admission_receipt_ref`),
    runtime_binding: runtimeBinding,
    issued_at: isoTimestamp(input.issued_at, `${path}.issued_at`),
    authority_readback_ref: requiredString(input.authority_readback_ref, `${path}.authority_readback_ref`),
    evidence_refs: uniqueStrings(input.evidence_refs, `${path}.evidence_refs`),
    reason_codes: reasonCodes,
  });
}

export function parseCarrierSessionOrientationDeliveryReceipt(
  value: unknown,
): CarrierSessionOrientationDeliveryReceipt {
  const path = 'delivery_receipt';
  const input = record(value, path);
  onlyKeys(input, [
    'schema', 'receipt_id', 'status', 'coordinate', 'admission_receipt_ref', 'manifest_id', 'manifest_digest',
    'delivered_at', 'authority_readback_ref', 'evidence_refs', 'reason_codes',
  ], path);
  if (input.schema !== CARRIER_SESSION_DELIVERY_RECEIPT_SCHEMA) {
    contractError('schema_mismatch', `${path}.schema`, CARRIER_SESSION_DELIVERY_RECEIPT_SCHEMA);
  }
  const status = enumValue(input.status, ['delivered', 'withheld'] as const, `${path}.status`);
  const manifestId = nullableString(input.manifest_id, `${path}.manifest_id`);
  const manifestDigest = nullableString(input.manifest_digest, `${path}.manifest_digest`);
  const deliveredAt = nullableIsoTimestamp(input.delivered_at, `${path}.delivered_at`);
  const reasonCodes = uniqueStrings(input.reason_codes, `${path}.reason_codes`);
  if (status === 'delivered' && (!manifestId || !manifestDigest || !deliveredAt)) {
    contractError('delivery_evidence_required', path, 'delivered requires manifest identity, digest, and timestamp');
  }
  if (status === 'withheld' && reasonCodes.length === 0) {
    contractError('withheld_reason_required', `${path}.reason_codes`, 'withheld delivery requires a reason');
  }
  return deepFreeze({
    schema: CARRIER_SESSION_DELIVERY_RECEIPT_SCHEMA,
    receipt_id: requiredString(input.receipt_id, `${path}.receipt_id`),
    status,
    coordinate: parseCarrierSessionAuthorityCoordinate(input.coordinate, `${path}.coordinate`),
    admission_receipt_ref: requiredString(input.admission_receipt_ref, `${path}.admission_receipt_ref`),
    manifest_id: manifestId,
    manifest_digest: manifestDigest,
    delivered_at: deliveredAt,
    authority_readback_ref: requiredString(input.authority_readback_ref, `${path}.authority_readback_ref`),
    evidence_refs: uniqueStrings(input.evidence_refs, `${path}.evidence_refs`),
    reason_codes: reasonCodes,
  });
}

export function parseOrientationAssemblyPolicy(value: unknown): OrientationAssemblyPolicy {
  const path = 'assembly_policy';
  const input = record(value, path);
  onlyKeys(input, [
    'schema', 'policy_ref', 'revision', 'required_entry_kinds', 'max_entries', 'max_rendered_bytes',
    'max_manifest_bytes', 'continuity_selection', 'optional_entry_behavior', 'negative_claims',
  ], path);
  if (input.schema !== ORIENTATION_ASSEMBLY_POLICY_SCHEMA) {
    contractError('schema_mismatch', `${path}.schema`, ORIENTATION_ASSEMBLY_POLICY_SCHEMA);
  }
  const requiredEntryKinds = uniqueStrings(input.required_entry_kinds, `${path}.required_entry_kinds`);
  if (requiredEntryKinds.length === 0) {
    contractError('required_entry_kind_required', `${path}.required_entry_kinds`, 'at least one required entry kind is necessary');
  }
  if (!Array.isArray(input.negative_claims) || input.negative_claims.length === 0) {
    contractError('negative_claim_required', `${path}.negative_claims`, 'policy must state at least one explicit non-claim');
  }
  const negativeClaims = input.negative_claims.map((value, index) => {
    const claimPath = `${path}.negative_claims[${index}]`;
    const claim = record(value, claimPath);
    onlyKeys(claim, ['claim_id', 'statement'], claimPath);
    return {
      claim_id: requiredString(claim.claim_id, `${claimPath}.claim_id`),
      statement: requiredString(claim.statement, `${claimPath}.statement`),
    };
  });
  if (new Set(negativeClaims.map((claim) => claim.claim_id)).size !== negativeClaims.length) {
    contractError('duplicate_negative_claim', `${path}.negative_claims`, 'claim_id values must be unique');
  }
  return deepFreeze({
    schema: ORIENTATION_ASSEMBLY_POLICY_SCHEMA,
    policy_ref: requiredString(input.policy_ref, `${path}.policy_ref`),
    revision: requiredString(input.revision, `${path}.revision`),
    required_entry_kinds: requiredEntryKinds,
    max_entries: positiveInteger(input.max_entries, `${path}.max_entries`),
    max_rendered_bytes: positiveInteger(input.max_rendered_bytes, `${path}.max_rendered_bytes`),
    max_manifest_bytes: positiveInteger(input.max_manifest_bytes, `${path}.max_manifest_bytes`),
    continuity_selection: enumValue(
      input.continuity_selection,
      ['exact_or_omitted', 'exact_required'] as const,
      `${path}.continuity_selection`,
    ),
    optional_entry_behavior: enumValue(
      input.optional_entry_behavior,
      ['degrade'] as const,
      `${path}.optional_entry_behavior`,
    ),
    negative_claims: negativeClaims,
  });
}

export function parseOrientationProjectionEntry(value: unknown, path = 'projection'): OrientationProjectionEntry {
  const input = record(value, path);
  onlyKeys(input, [
    'entry_id', 'compartment', 'entry_kind', 'subject', 'source_authority_ref', 'artifact_ref', 'revision',
    'observed_at', 'valid_until', 'criticality', 'projection_status', 'revalidation_rule', 'evidence_refs',
    'payload', 'rendered_text',
  ], path);
  const observedAt = isoTimestamp(input.observed_at, `${path}.observed_at`);
  const validUntil = nullableIsoTimestamp(input.valid_until, `${path}.valid_until`);
  if (validUntil !== null && Date.parse(validUntil) <= Date.parse(observedAt)) {
    contractError(
      'projection_validity_interval_invalid',
      `${path}.valid_until`,
      'valid_until must be later than observed_at',
    );
  }
  return deepFreeze({
    entry_id: requiredString(input.entry_id, `${path}.entry_id`),
    compartment: enumValue(input.compartment, ORIENTATION_COMPARTMENTS, `${path}.compartment`),
    entry_kind: requiredString(input.entry_kind, `${path}.entry_kind`),
    subject: parseOrientationSubject(input.subject, `${path}.subject`),
    source_authority_ref: requiredString(input.source_authority_ref, `${path}.source_authority_ref`),
    artifact_ref: requiredString(input.artifact_ref, `${path}.artifact_ref`),
    revision: requiredString(input.revision, `${path}.revision`),
    observed_at: observedAt,
    valid_until: validUntil,
    criticality: enumValue(input.criticality, ['required', 'optional'] as const, `${path}.criticality`),
    projection_status: enumValue(
      input.projection_status,
      ORIENTATION_PROJECTION_STATUSES,
      `${path}.projection_status`,
    ),
    revalidation_rule: requiredString(input.revalidation_rule, `${path}.revalidation_rule`),
    evidence_refs: uniqueStrings(input.evidence_refs, `${path}.evidence_refs`),
    payload: jsonObject(input.payload, `${path}.payload`),
    rendered_text: input.rendered_text === null
      ? null
      : requiredString(input.rendered_text, `${path}.rendered_text`),
  });
}

export function parseOrientationResidual(value: unknown, path = 'residual'): OrientationResidual {
  const input = record(value, path);
  onlyKeys(input, [
    'code', 'compartment', 'criticality', 'message', 'source_authority_ref',
    'artifact_ref', 'evidence_refs',
  ], path);
  return deepFreeze({
    code: requiredString(input.code, `${path}.code`),
    compartment: input.compartment === null
      ? null
      : enumValue(input.compartment, ORIENTATION_COMPARTMENTS, `${path}.compartment`),
    criticality: enumValue(input.criticality, ['required', 'optional'] as const, `${path}.criticality`),
    message: requiredString(input.message, `${path}.message`),
    source_authority_ref: nullableString(input.source_authority_ref, `${path}.source_authority_ref`),
    artifact_ref: nullableString(input.artifact_ref, `${path}.artifact_ref`),
    evidence_refs: uniqueStrings(input.evidence_refs, `${path}.evidence_refs`),
  });
}

export function parseOrientationNegativeClaim(
  value: unknown,
  path = 'negative_claim',
): OrientationNegativeClaim {
  const input = record(value, path);
  onlyKeys(input, ['claim_id', 'statement', 'source_authority_ref', 'revision'], path);
  return deepFreeze({
    claim_id: requiredString(input.claim_id, `${path}.claim_id`),
    statement: requiredString(input.statement, `${path}.statement`),
    source_authority_ref: requiredString(input.source_authority_ref, `${path}.source_authority_ref`),
    revision: requiredString(input.revision, `${path}.revision`),
  });
}

export function parseOrientationManifest(value: unknown): OrientationManifest {
  const path = 'orientation_manifest';
  const input = record(value, path);
  onlyKeys(input, [
    'schema', 'manifest_id', 'manifest_digest', 'generated_at', 'coordinate',
    'admission_receipt_ref', 'agent_identity', 'carrier_kind', 'assembly_policy',
    'runtime_binding', 'readiness', 'delivery', 'action_admission', 'entries',
    'residuals', 'negative_claims', 'reason_codes', 'bounds',
  ], path);
  if (input.schema !== ORIENTATION_MANIFEST_SCHEMA) {
    contractError('schema_mismatch', `${path}.schema`, ORIENTATION_MANIFEST_SCHEMA);
  }
  if (!Array.isArray(input.entries)) contractError('array_required', `${path}.entries`, 'expected an array');
  if (!Array.isArray(input.residuals)) contractError('array_required', `${path}.residuals`, 'expected an array');
  if (!Array.isArray(input.negative_claims)) {
    contractError('array_required', `${path}.negative_claims`, 'expected an array');
  }
  const entries = input.entries.map((entry, index) => (
    parseOrientationProjectionEntry(entry, `${path}.entries[${index}]`)
  ));
  if (new Set(entries.map((entry) => entry.entry_id)).size !== entries.length) {
    contractError('duplicate_entry_id', `${path}.entries`, 'entry_id values must be unique');
  }
  const residuals = input.residuals.map((entry, index) => (
    parseOrientationResidual(entry, `${path}.residuals[${index}]`)
  ));
  const negativeClaims = input.negative_claims.map((entry, index) => (
    parseOrientationNegativeClaim(entry, `${path}.negative_claims[${index}]`)
  ));
  if (negativeClaims.length === 0) {
    contractError('negative_claim_required', `${path}.negative_claims`, 'manifest must preserve explicit non-claims');
  }
  if (new Set(negativeClaims.map((claim) => claim.claim_id)).size !== negativeClaims.length) {
    contractError('duplicate_negative_claim', `${path}.negative_claims`, 'claim_id values must be unique');
  }
  const coordinate = parseCarrierSessionAuthorityCoordinate(input.coordinate, `${path}.coordinate`);
  const agentIdentity = parseAdmittedAgentIdentityReference(input.agent_identity, `${path}.agent_identity`);
  for (const [index, entry] of entries.entries()) {
    if (
      entry.subject.site_ref !== coordinate.site_ref
      || entry.subject.agent_ref !== agentIdentity.artifact_ref
      || (
        entry.subject.carrier_session_id !== null
        && entry.subject.carrier_session_id !== coordinate.carrier_session_id
      )
    ) {
      contractError(
        'manifest_entry_subject_mismatch',
        `${path}.entries[${index}].subject`,
        'included entries must belong to the manifest embodiment',
      );
    }
  }
  const boundsInput = record(input.bounds, `${path}.bounds`);
  onlyKeys(boundsInput, [
    'max_entries', 'max_rendered_bytes', 'max_manifest_bytes', 'included_entries',
    'rendered_bytes', 'manifest_bytes', 'omitted_entries',
  ], `${path}.bounds`);
  const bounds = {
    max_entries: positiveInteger(boundsInput.max_entries, `${path}.bounds.max_entries`),
    max_rendered_bytes: positiveInteger(boundsInput.max_rendered_bytes, `${path}.bounds.max_rendered_bytes`),
    max_manifest_bytes: positiveInteger(boundsInput.max_manifest_bytes, `${path}.bounds.max_manifest_bytes`),
    included_entries: nonNegativeInteger(boundsInput.included_entries, `${path}.bounds.included_entries`),
    rendered_bytes: nonNegativeInteger(boundsInput.rendered_bytes, `${path}.bounds.rendered_bytes`),
    manifest_bytes: positiveInteger(boundsInput.manifest_bytes, `${path}.bounds.manifest_bytes`),
    omitted_entries: nonNegativeInteger(boundsInput.omitted_entries, `${path}.bounds.omitted_entries`),
  };
  if (bounds.included_entries !== entries.length || bounds.included_entries > bounds.max_entries) {
    contractError('manifest_entry_bound_mismatch', `${path}.bounds.included_entries`, 'entry count does not match declared bounds');
  }
  const actualRenderedBytes = entries.reduce(
    (total, entry) => total + new TextEncoder().encode(entry.rendered_text ?? '').byteLength,
    0,
  );
  if (bounds.rendered_bytes !== actualRenderedBytes) {
    contractError(
      'manifest_rendered_byte_count_mismatch',
      `${path}.bounds.rendered_bytes`,
      'rendered byte count does not match included entry text',
    );
  }
  if (bounds.rendered_bytes > bounds.max_rendered_bytes || bounds.manifest_bytes > bounds.max_manifest_bytes) {
    contractError('manifest_size_bound_exceeded', `${path}.bounds`, 'manifest exceeds a declared assembly bound');
  }
  const readiness = enumValue(input.readiness, ['ready', 'degraded', 'blocked'] as const, `${path}.readiness`);
  const delivery = enumValue(input.delivery, ['deliverable', 'withheld'] as const, `${path}.delivery`);
  if (readiness === 'blocked' && delivery !== 'withheld') {
    contractError('blocked_manifest_not_deliverable', `${path}.delivery`, 'blocked readiness requires withheld delivery');
  }
  if (input.action_admission !== 'separate_required') {
    contractError('action_admission_separation_required', `${path}.action_admission`, 'orientation cannot admit later action');
  }
  return deepFreeze({
    schema: ORIENTATION_MANIFEST_SCHEMA,
    manifest_id: requiredString(input.manifest_id, `${path}.manifest_id`),
    manifest_digest: requiredString(input.manifest_digest, `${path}.manifest_digest`),
    generated_at: isoTimestamp(input.generated_at, `${path}.generated_at`),
    coordinate,
    admission_receipt_ref: requiredString(input.admission_receipt_ref, `${path}.admission_receipt_ref`),
    agent_identity: agentIdentity,
    carrier_kind: requiredString(input.carrier_kind, `${path}.carrier_kind`),
    assembly_policy: parseSourceArtifactReference(input.assembly_policy, `${path}.assembly_policy`),
    runtime_binding: input.runtime_binding === null
      ? null
      : parseRuntimeBindingReference(input.runtime_binding, `${path}.runtime_binding`),
    readiness,
    delivery,
    action_admission: 'separate_required',
    entries,
    residuals,
    negative_claims: negativeClaims,
    reason_codes: uniqueStrings(input.reason_codes, `${path}.reason_codes`),
    bounds,
  });
}

export function parseOrientationCompilationResult(value: unknown): OrientationCompilationResult {
  const path = 'orientation_compilation_result';
  const input = record(value, path);
  onlyKeys(input, ['schema', 'status', 'source_mutation', 'manifest'], path);
  if (input.schema !== ORIENTATION_COMPILATION_RESULT_SCHEMA) {
    contractError('schema_mismatch', `${path}.schema`, ORIENTATION_COMPILATION_RESULT_SCHEMA);
  }
  if (input.status !== 'compiled') {
    contractError('compiled_status_required', `${path}.status`, 'expected compiled');
  }
  if (input.source_mutation !== false) {
    contractError('source_mutation_forbidden', `${path}.source_mutation`, 'orientation compilation must be pure');
  }
  return deepFreeze({
    schema: ORIENTATION_COMPILATION_RESULT_SCHEMA,
    status: 'compiled',
    source_mutation: false,
    manifest: parseOrientationManifest(input.manifest),
  });
}

export const SOURCE_ARTIFACT_REFERENCE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    source_authority_ref: { type: 'string', minLength: 1 },
    artifact_ref: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
  },
  required: ['source_authority_ref', 'artifact_ref', 'revision'],
} as const);

export const ADMITTED_AGENT_IDENTITY_REFERENCE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    source_authority_ref: { type: 'string', minLength: 1 },
    artifact_ref: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
    local_agent_id: { type: 'string', minLength: 1 },
    canonical_agent_id: { type: 'string', minLength: 1 },
  },
  required: [
    'source_authority_ref', 'artifact_ref', 'revision', 'local_agent_id', 'canonical_agent_id',
  ],
} as const);

export const CARRIER_SESSION_COORDINATE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    authority_scope: { type: 'string', minLength: 1 },
    site_ref: { type: 'string', minLength: 1 },
    carrier_session_id: { type: 'string', minLength: 1 },
    authority_epoch: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
  required: ['authority_scope', 'site_ref', 'carrier_session_id', 'authority_epoch'],
} as const);

export const CARRIER_SESSION_ADMISSION_RECEIPT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema: { type: 'string', const: CARRIER_SESSION_ADMISSION_RECEIPT_SCHEMA },
    receipt_id: { type: 'string', minLength: 1 },
    decision: { type: 'string', enum: ['admitted', 'refused'] },
    state: { type: 'string', enum: ['starting', 'refused'] },
    coordinate: CARRIER_SESSION_COORDINATE_JSON_SCHEMA,
    agent_identity: ADMITTED_AGENT_IDENTITY_REFERENCE_JSON_SCHEMA,
    carrier_kind: { type: 'string', minLength: 1 },
    admission_policy: SOURCE_ARTIFACT_REFERENCE_JSON_SCHEMA,
    issued_at: { type: 'string', minLength: 1 },
    valid_until: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    authority_readback_ref: { type: 'string', minLength: 1 },
    evidence_refs: { type: 'array', items: { type: 'string', minLength: 1 } },
    reason_codes: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: [
    'schema', 'receipt_id', 'decision', 'state', 'coordinate', 'agent_identity', 'carrier_kind',
    'admission_policy', 'issued_at', 'valid_until', 'authority_readback_ref', 'evidence_refs', 'reason_codes',
  ],
} as const);

export const RUNTIME_BINDING_REFERENCE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    source_authority_ref: { type: 'string', minLength: 1 },
    artifact_ref: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
    owning_site_ref: { type: 'string', minLength: 1 },
    observed_at: { type: 'string', minLength: 1 },
  },
  required: [
    'source_authority_ref', 'artifact_ref', 'revision', 'owning_site_ref', 'observed_at',
  ],
} as const);

export const CARRIER_SESSION_ACTIVATION_RECEIPT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema: { type: 'string', const: CARRIER_SESSION_ACTIVATION_RECEIPT_SCHEMA },
    receipt_id: { type: 'string', minLength: 1 },
    decision: { type: 'string', enum: ['activated', 'refused'] },
    state: { type: 'string', enum: ['active', 'starting'] },
    coordinate: CARRIER_SESSION_COORDINATE_JSON_SCHEMA,
    admission_receipt_ref: { type: 'string', minLength: 1 },
    runtime_binding: {
      anyOf: [
        RUNTIME_BINDING_REFERENCE_JSON_SCHEMA,
        { type: 'null' },
      ],
    },
    issued_at: { type: 'string', minLength: 1 },
    authority_readback_ref: { type: 'string', minLength: 1 },
    evidence_refs: { type: 'array', items: { type: 'string', minLength: 1 } },
    reason_codes: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: [
    'schema', 'receipt_id', 'decision', 'state', 'coordinate', 'admission_receipt_ref',
    'runtime_binding', 'issued_at', 'authority_readback_ref', 'evidence_refs', 'reason_codes',
  ],
} as const);

export const CARRIER_SESSION_ORIENTATION_DELIVERY_RECEIPT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema: { type: 'string', const: CARRIER_SESSION_DELIVERY_RECEIPT_SCHEMA },
    receipt_id: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['delivered', 'withheld'] },
    coordinate: CARRIER_SESSION_COORDINATE_JSON_SCHEMA,
    admission_receipt_ref: { type: 'string', minLength: 1 },
    manifest_id: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    manifest_digest: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    delivered_at: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    authority_readback_ref: { type: 'string', minLength: 1 },
    evidence_refs: { type: 'array', items: { type: 'string', minLength: 1 } },
    reason_codes: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: [
    'schema', 'receipt_id', 'status', 'coordinate', 'admission_receipt_ref', 'manifest_id',
    'manifest_digest', 'delivered_at', 'authority_readback_ref', 'evidence_refs', 'reason_codes',
  ],
} as const);

export const ORIENTATION_ASSEMBLY_POLICY_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema: { type: 'string', const: ORIENTATION_ASSEMBLY_POLICY_SCHEMA },
    policy_ref: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
    required_entry_kinds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    max_entries: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    max_rendered_bytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    max_manifest_bytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    continuity_selection: { type: 'string', enum: ['exact_or_omitted', 'exact_required'] },
    optional_entry_behavior: { type: 'string', const: 'degrade' },
    negative_claims: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim_id: { type: 'string', minLength: 1 },
          statement: { type: 'string', minLength: 1 },
        },
        required: ['claim_id', 'statement'],
      },
    },
  },
  required: [
    'schema', 'policy_ref', 'revision', 'required_entry_kinds', 'max_entries', 'max_rendered_bytes',
    'max_manifest_bytes', 'continuity_selection', 'optional_entry_behavior', 'negative_claims',
  ],
} as const);

export const ORIENTATION_PROJECTION_ENTRY_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    entry_id: { type: 'string', minLength: 1 },
    compartment: { type: 'string', enum: [...ORIENTATION_COMPARTMENTS] },
    entry_kind: { type: 'string', minLength: 1 },
    subject: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site_ref: { type: 'string', minLength: 1 },
        agent_ref: { type: 'string', minLength: 1 },
        carrier_session_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['site_ref', 'agent_ref', 'carrier_session_id'],
    },
    source_authority_ref: { type: 'string', minLength: 1 },
    artifact_ref: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
    observed_at: { type: 'string', minLength: 1 },
    valid_until: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    criticality: { type: 'string', enum: ['required', 'optional'] },
    projection_status: { type: 'string', enum: [...ORIENTATION_PROJECTION_STATUSES] },
    revalidation_rule: { type: 'string', minLength: 1 },
    evidence_refs: { type: 'array', items: { type: 'string', minLength: 1 } },
    payload: { type: 'object' },
    rendered_text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'entry_id', 'compartment', 'entry_kind', 'subject', 'source_authority_ref', 'artifact_ref', 'revision',
    'observed_at', 'valid_until', 'criticality', 'projection_status', 'revalidation_rule', 'evidence_refs',
    'payload', 'rendered_text',
  ],
} as const);

export const ORIENTATION_RESIDUAL_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', minLength: 1 },
    compartment: {
      anyOf: [
        { type: 'string', enum: [...ORIENTATION_COMPARTMENTS] },
        { type: 'null' },
      ],
    },
    criticality: { type: 'string', enum: ['required', 'optional'] },
    message: { type: 'string', minLength: 1 },
    source_authority_ref: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    artifact_ref: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    evidence_refs: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: [
    'code', 'compartment', 'criticality', 'message', 'source_authority_ref',
    'artifact_ref', 'evidence_refs',
  ],
} as const);

export const ORIENTATION_NEGATIVE_CLAIM_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    claim_id: { type: 'string', minLength: 1 },
    statement: { type: 'string', minLength: 1 },
    source_authority_ref: { type: 'string', minLength: 1 },
    revision: { type: 'string', minLength: 1 },
  },
  required: ['claim_id', 'statement', 'source_authority_ref', 'revision'],
} as const);

export const ORIENTATION_MANIFEST_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema: { type: 'string', const: ORIENTATION_MANIFEST_SCHEMA },
    manifest_id: { type: 'string', minLength: 1 },
    manifest_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    generated_at: { type: 'string', minLength: 1 },
    coordinate: CARRIER_SESSION_COORDINATE_JSON_SCHEMA,
    admission_receipt_ref: { type: 'string', minLength: 1 },
    agent_identity: ADMITTED_AGENT_IDENTITY_REFERENCE_JSON_SCHEMA,
    carrier_kind: { type: 'string', minLength: 1 },
    assembly_policy: SOURCE_ARTIFACT_REFERENCE_JSON_SCHEMA,
    runtime_binding: {
      anyOf: [
        RUNTIME_BINDING_REFERENCE_JSON_SCHEMA,
        { type: 'null' },
      ],
    },
    readiness: { type: 'string', enum: ['ready', 'degraded', 'blocked'] },
    delivery: { type: 'string', enum: ['deliverable', 'withheld'] },
    action_admission: { type: 'string', const: 'separate_required' },
    entries: { type: 'array', items: ORIENTATION_PROJECTION_ENTRY_JSON_SCHEMA },
    residuals: { type: 'array', items: ORIENTATION_RESIDUAL_JSON_SCHEMA },
    negative_claims: {
      type: 'array',
      minItems: 1,
      items: ORIENTATION_NEGATIVE_CLAIM_JSON_SCHEMA,
    },
    reason_codes: { type: 'array', items: { type: 'string', minLength: 1 } },
    bounds: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_entries: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        max_rendered_bytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        max_manifest_bytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        included_entries: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        rendered_bytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        manifest_bytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        omitted_entries: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: [
        'max_entries', 'max_rendered_bytes', 'max_manifest_bytes', 'included_entries',
        'rendered_bytes', 'manifest_bytes', 'omitted_entries',
      ],
    },
  },
  required: [
    'schema', 'manifest_id', 'manifest_digest', 'generated_at', 'coordinate',
    'admission_receipt_ref', 'agent_identity', 'carrier_kind', 'assembly_policy',
    'runtime_binding', 'readiness', 'delivery', 'action_admission', 'entries',
    'residuals', 'negative_claims', 'reason_codes', 'bounds',
  ],
} as const);

export const ORIENTATION_COMPILATION_RESULT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schema: { type: 'string', const: ORIENTATION_COMPILATION_RESULT_SCHEMA },
    status: { type: 'string', const: 'compiled' },
    source_mutation: { type: 'boolean', const: false },
    manifest: ORIENTATION_MANIFEST_JSON_SCHEMA,
  },
  required: ['schema', 'status', 'source_mutation', 'manifest'],
} as const);
