import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SqliteInboxStore } from '@narada-core/control-plane';
import { onboardingCascadeForSiteKind } from './onboarding-cascade.js';
import { readOperatorSurfaceIdentities, type OperatorSurfaceIdentity } from './operator-surface-registry.js';
import { siteAuthorityRootFromSiteRoot } from '@narada-core/site-paths';

export type SiteReadinessPosture =
  | 'site_absent'
  | 'initialized_unready'
  | 'ready_missing_role_binding'
  | 'ready_missing_transport'
  | 'ready_pending_inbox'
  | 'fully_idle';

export interface SiteReadinessCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  next_command?: string;
}

export interface SiteCapabilityChoice {
  number: number;
  id: string;
  status: 'answered' | 'deferred' | 'unresolved';
  prompt: string;
  options: string[];
  current: unknown | null;
}

export interface SiteReadinessResult {
  posture: SiteReadinessPosture;
  target_locus: {
    site: string;
    site_id: string;
    site_root: string;
    operation: string | null;
  };
  onboarding: {
    state: string;
    source: 'governance.readiness_phase' | 'readiness_phase' | 'default';
  };
  coordinates: {
    governing_law_source: unknown | null;
    authority_locus: unknown | null;
    evidence_locus: unknown | null;
    embodiments: unknown[];
    operator_surface_posture: {
      role: string;
      required: boolean;
      identity_id: string | null;
      identity_admitted: boolean;
      submit_transport_declared: boolean;
      runtime_handle_bound: boolean;
      bound_transport: boolean;
      binding_status: 'bound' | 'unbound' | 'stale' | 'ambiguous';
      runtime_locus: string | null;
      submit_strategy: string | null;
      evidence_paths: {
        identity_registry: string;
        runtime_bindings: string;
      };
    };
  };
  readiness_strata: {
    structural: SiteReadinessPosture;
    business_capability: {
      status: 'not_applicable' | 'ready' | 'choices_unresolved';
      unresolved_count: number;
      note: string;
    };
  };
  capability_choices: {
    site_kind: string | null;
    required_before_inhabited_readiness: boolean;
    choices: SiteCapabilityChoice[];
  };
  checks: SiteReadinessCheck[];
  blockers: SiteReadinessCheck[];
  warnings: SiteReadinessCheck[];
  pending_inbox: Array<{ envelope_id: string; kind: string; title: string | null }>;
  next_command: string;
  bounded_output: true;
}

export interface AssessSiteReadinessOptions {
  site: string;
  operation?: string | null;
  role?: string;
  /** Require the requested role even when the Site has not declared one. */
  roleRequired?: boolean;
}

function titleFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  return typeof record.title === 'string'
    ? record.title
    : typeof record.summary === 'string'
      ? record.summary
      : null;
}

function listPendingInbox(siteRoot: string): SiteReadinessResult['pending_inbox'] {
  const dbPath = join(siteRoot, '.ai', 'inbox.db');
  if (!existsSync(dbPath)) return [];
  const store = new SqliteInboxStore(dbPath);
  try {
    return store.list({ status: 'received', limit: 5 }).map((envelope) => ({
      envelope_id: envelope.envelope_id,
      kind: envelope.kind,
      title: titleFromPayload(envelope.payload),
    }));
  } finally {
    store.close();
  }
}

type RuntimeBindingRecord = {
  binding_id?: string;
  identity_id?: string;
  runtime_locus?: string;
  handle?: string;
  transport?: string;
  input_capabilities?: string[];
  status?: string;
  stale_after?: string;
};

type RuntimeBindingPosture = {
  status: 'bound' | 'unbound' | 'stale' | 'ambiguous';
  binding_id: string | null;
  runtime_locus: string | null;
  handle: string | null;
};

type IdentityRegistryRead = {
  registry: { identities: OperatorSurfaceIdentity[] };
  path: string;
  source: 'canonical' | 'legacy' | 'missing';
};

function declaredTransport(identity: OperatorSurfaceIdentity | null): boolean {
  if (!identity) return false;
  const capabilities = identity.input_capabilities ?? [];
  return capabilities.includes('type_text') || capabilities.includes('submit') || Boolean(identity.submit_strategy);
}

function isStaleRuntimeBinding(binding: RuntimeBindingRecord, now = Date.now()): boolean {
  if (binding.status === 'stale' || binding.status === 'revoked') return true;
  if (!binding.stale_after) return false;
  const timestamp = Date.parse(binding.stale_after);
  return Number.isFinite(timestamp) && timestamp <= now;
}

function runtimeBindingPosture(identityId: string | null, bindings: RuntimeBindingRecord[]): RuntimeBindingPosture {
  if (!identityId) return { status: 'unbound', binding_id: null, runtime_locus: null, handle: null };
  const matching = bindings.filter((binding) => binding.identity_id === identityId);
  if (matching.length === 0) return { status: 'unbound', binding_id: null, runtime_locus: null, handle: null };
  const active = matching.filter((binding) => !isStaleRuntimeBinding(binding));
  if (active.length === 0) {
    const binding = matching[0];
    return { status: 'stale', binding_id: binding?.binding_id ?? null, runtime_locus: binding?.runtime_locus ?? null, handle: binding?.handle ?? null };
  }
  if (active.length > 1) return { status: 'ambiguous', binding_id: null, runtime_locus: null, handle: null };
  const binding = active[0];
  if (!binding?.runtime_locus || !binding.handle) {
    return { status: 'unbound', binding_id: binding?.binding_id ?? null, runtime_locus: binding?.runtime_locus ?? null, handle: binding?.handle ?? null };
  }
  return { status: 'bound', binding_id: binding.binding_id ?? null, runtime_locus: binding.runtime_locus, handle: binding.handle };
}

async function readIdentityRegistry(siteRoot: string): Promise<IdentityRegistryRead> {
  const authorityRoot = siteAuthorityRootFromSiteRoot(siteRoot);
  const candidates: Array<{ root: string; source: 'canonical' | 'legacy' }> = [
    { root: authorityRoot, source: 'canonical' },
    { root: siteRoot, source: 'legacy' },
  ];
  for (const candidate of candidates) {
    const path = join(candidate.root, 'operator-surfaces', 'identities.json');
    if (!existsSync(path)) continue;
    return { registry: await readOperatorSurfaceIdentities(candidate.root), path, source: candidate.source };
  }
  return {
    registry: { identities: [] },
    path: join(authorityRoot, 'operator-surfaces', 'identities.json'),
    source: 'missing',
  };
}

function readRuntimeBindings(siteRoot: string): { bindings: RuntimeBindingRecord[]; path: string } {
  const authorityRoot = siteAuthorityRootFromSiteRoot(siteRoot);
  const candidates = [
    join(authorityRoot, 'operator-surfaces', 'runtime-bindings.json'),
    join(siteRoot, 'operator-surfaces', 'runtime-bindings.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  if (!existsSync(path)) return { bindings: [], path };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const values: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as Record<string, unknown>).bindings)
        ? (parsed as { bindings: unknown[] }).bindings
        : [];
    return {
      bindings: values.filter((binding): binding is RuntimeBindingRecord => Boolean(binding && typeof binding === 'object' && !Array.isArray(binding))),
      path,
    };
  } catch {
    return { bindings: [], path };
  }
}

function siteIdForReadiness(config: Record<string, unknown> | null, materialization: Record<string, unknown> | null): string {
  const site = objectField(config, 'site');
  const candidates = [
    config?.site_id,
    site?.site_id,
    materialization?.site_id,
    objectField(materialization, 'site')?.site_id,
  ];
  const value = candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  return value?.trim() ?? '<site-id>';
}

function nextCommandFor(
  posture: SiteReadinessPosture,
  siteRoot: string,
  authorityRoot: string,
  siteId: string,
  role: string,
  identityId: string | null,
  binding: RuntimeBindingPosture,
): string {
  switch (posture) {
    case 'site_absent':
      return 'narada sites init --root ' + JSON.stringify(siteRoot);
    case 'initialized_unready':
      return 'narada sites doctor ' + JSON.stringify(siteId) + ' --root ' + JSON.stringify(siteRoot) + ' --format json';
    case 'ready_missing_role_binding':
      return 'narada operator-surface agent instantiate --cwd ' + JSON.stringify(authorityRoot)
        + ' --site ' + JSON.stringify(siteId)
        + ' --role ' + role
        + ' --identity ' + JSON.stringify(identityId ?? siteId + '.' + role)
        + ' --agent-kind codex_cli --by <principal>';
    case 'ready_missing_transport':
      return 'narada operator-surface bind-focused --identity ' + JSON.stringify(identityId ?? '<identity>')
        + ' --runtime-locus ' + JSON.stringify(binding.runtime_locus ?? '<runtime-locus>')
        + ' --handle <captured-hwnd-or-stable-handle>';
    case 'ready_pending_inbox':
      return 'narada inbox work-next --by ' + role;
    case 'fully_idle':
      return 'narada work-next --agent ' + role + ' --format json';
  }
}
function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readSiteConfig(siteRoot: string): Record<string, unknown> | null {
  const authorityRoot = siteAuthorityRootFromSiteRoot(siteRoot);
  return readJsonFile(join(siteRoot, 'config.json')) ?? readJsonFile(join(authorityRoot, 'config.json'));
}

function readSiteMaterialization(siteRoot: string): Record<string, unknown> | null {
  const authorityRoot = siteAuthorityRootFromSiteRoot(siteRoot);
  return readJsonFile(join(siteRoot, 'site-materialization.json')) ?? readJsonFile(join(authorityRoot, 'site-materialization.json'));
}

function objectField(source: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = source?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayField(source: Record<string, unknown> | null | undefined, key: string): unknown[] {
  const value = source?.[key];
  return Array.isArray(value) ? value : [];
}

function siteKind(config: Record<string, unknown> | null): string | null {
  const site = objectField(config, 'site');
  const kind = config?.site_kind ?? site?.site_kind;
  return typeof kind === 'string' && kind.trim() ? kind : null;
}

function configuredChoice(config: Record<string, unknown> | null, id: string): unknown | null {
  const governance = objectField(config, 'governance');
  const onboarding = objectField(config, 'onboarding') ?? objectField(governance, 'onboarding');
  const choices = objectField(onboarding, 'capability_choices') ?? objectField(config, 'capability_choices');
  return choices && Object.prototype.hasOwnProperty.call(choices, id) ? choices[id] ?? null : null;
}

function choiceStatus(value: unknown): SiteCapabilityChoice['status'] {
  if (value === null || value === undefined || value === '') return 'unresolved';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.status === 'deferred' || record.deferred === true) return 'deferred';
  }
  if (value === 'deferred' || value === 'none_for_now') return 'deferred';
  return 'answered';
}

function clientServiceCapabilityChoices(config: Record<string, unknown> | null): SiteCapabilityChoice[] {
  const cascade = onboardingCascadeForSiteKind(siteKind(config));
  if (!cascade) return [];
  return cascade.capability_questions.map((definition) => {
    const current = configuredChoice(config, definition.id);
    return {
      ...definition,
      number: definition.number,
      status: choiceStatus(current),
      current,
    };
  });
}

function businessCapabilityReadiness(
  config: Record<string, unknown> | null,
  structural: SiteReadinessPosture,
): SiteReadinessResult['readiness_strata']['business_capability'] {
  const choices = clientServiceCapabilityChoices(config);
  if (choices.length === 0) {
    return {
      status: 'not_applicable',
      unresolved_count: 0,
      note: 'Business-capability readiness choices are not required for this Site kind.',
    };
  }
  const unresolved = choices.filter((choice) => choice.status === 'unresolved');
  if (unresolved.length > 0) {
    return {
      status: 'choices_unresolved',
      unresolved_count: unresolved.length,
      note: `${structural} is structural readiness only; client-service inhabited readiness requires answering or deferring material capability choices.`,
    };
  }
  return {
    status: 'ready',
    unresolved_count: 0,
    note: 'Client-service material capability choices are answered or explicitly deferred.',
  };
}

function readinessPhase(config: Record<string, unknown> | null): SiteReadinessResult['onboarding'] {
  const governance = objectField(config, 'governance');
  const governancePhase = governance?.readiness_phase;
  if (typeof governancePhase === 'string' && governancePhase.trim()) {
    return { state: governancePhase, source: 'governance.readiness_phase' };
  }
  const rootPhase = config?.readiness_phase;
  if (typeof rootPhase === 'string' && rootPhase.trim()) {
    return { state: rootPhase, source: 'readiness_phase' };
  }
  return { state: 'not_yet_onboarded', source: 'default' };
}

function coordinates(
  config: Record<string, unknown> | null,
  roleIdentity: OperatorSurfaceIdentity | null,
  role: string,
  roleRequired: boolean,
  transportDeclared: boolean,
  binding: RuntimeBindingPosture,
  identityRegistryPath: string,
  runtimeBindingsPath: string,
): SiteReadinessResult['coordinates'] {
  const governance = objectField(config, 'governance');
  const locus = objectField(config, 'locus');
  return {
    governing_law_source: governance?.governing_law_source ?? null,
    authority_locus: governance?.authority_locus ?? locus ?? null,
    evidence_locus: governance?.mutation_evidence_locus ?? null,
    embodiments: arrayField(governance, 'embodiments').length > 0 ? arrayField(governance, 'embodiments') : arrayField(config, 'embodiments'),
    operator_surface_posture: {
      role,
      required: roleRequired,
      identity_id: roleIdentity?.identity_id ?? null,
      identity_admitted: Boolean(roleIdentity),
      submit_transport_declared: transportDeclared,
      runtime_handle_bound: binding.status === 'bound',
      bound_transport: binding.status === 'bound',
      binding_status: binding.status,
      runtime_locus: binding.runtime_locus,
      submit_strategy: roleIdentity?.submit_strategy ?? null,
      evidence_paths: {
        identity_registry: identityRegistryPath,
        runtime_bindings: runtimeBindingsPath,
      },
    },
  };
}

function materializedOperationBinding(materialization: Record<string, unknown> | null): Record<string, unknown> | null {
  return objectField(materialization, 'operation_binding');
}

function materializedRoleIdentity(
  materialization: Record<string, unknown> | null,
  role: string,
): OperatorSurfaceIdentity | null {
  const binding = materializedOperationBinding(materialization);
  const siteId = materialization?.site_id;
  const identity = binding?.agent_identity_default;
  const launcher = binding?.launcher;
  if (typeof identity !== 'string' || !identity.endsWith(`.${role}`)) return null;
  if (typeof siteId !== 'string' || !siteId.trim()) return null;
  const launcherDeclared = typeof launcher === 'string' && launcher.trim();
  return {
    identity_id: identity,
    site_id: siteId,
    role,
    agent_kind: 'agent-cli',
    label: identity,
    input_capabilities: launcherDeclared ? ['focus', 'type_text', 'submit'] : [],
    submit_strategy: launcherDeclared ? 'known_surface_submit' : undefined,
    admitted_by: 'site-materialization',
    admitted_at: '',
    updated_at: '',
    authority_limits: [
      'projection_from_site_materialization',
      'does_not_grant_additional_capability_beyond_launcher_policy',
    ],
  };
}

function materializedIdentityProjection(
  materialization: Record<string, unknown> | null,
  role: string,
): OperatorSurfaceIdentity | null {
  return materializedRoleIdentity(materialization, role);
}

function roleFromIdentityValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  const role = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.') + 1) : normalized;
  return role || null;
}

function explicitlyDeclaredRole(
  config: Record<string, unknown> | null,
  materialization: Record<string, unknown> | null,
): string | null {
  const site = objectField(config, 'site');
  const operationBinding = materializedOperationBinding(materialization);
  const candidates = [
    config?.default_agent_identity,
    site?.default_agent_identity,
    materialization?.agent_identity_default,
    operationBinding?.agent_identity_default,
  ];
  for (const candidate of candidates) {
    const role = roleFromIdentityValue(candidate);
    if (role) return role;
  }

  const identity = objectField(config, 'identity');
  for (const key of ['role_assignments', 'named_agents', 'role_compatibility_identities'] as const) {
    for (const entry of arrayField(identity, key)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const role = roleFromIdentityValue(record.role ?? record.role_id ?? record.agent_role);
      if (role) return role;
    }
  }
  return null;
}

export async function assessSiteReadiness(options: AssessSiteReadinessOptions): Promise<SiteReadinessResult> {
  const role = options.role?.trim() || 'architect';
  const siteRoot = resolve(options.site);
  const authorityRoot = siteAuthorityRootFromSiteRoot(siteRoot);
  const siteExists = existsSync(siteRoot);
  const aiExists = existsSync(join(siteRoot, '.ai')) || existsSync(join(authorityRoot, '.ai'));
  const config = siteExists ? readSiteConfig(siteRoot) : null;
  const configExists = config !== null;
  const materialization = siteExists ? readSiteMaterialization(siteRoot) : null;
  const pendingInbox = siteExists ? listPendingInbox(siteRoot) : [];
  const identityRead = siteExists ? await readIdentityRegistry(siteRoot) : {
    registry: { identities: [] },
    path: join(authorityRoot, 'operator-surfaces', 'identities.json'),
    source: 'missing' as const,
  };
  const runtimeRead = siteExists ? readRuntimeBindings(siteRoot) : {
    bindings: [],
    path: join(authorityRoot, 'operator-surfaces', 'runtime-bindings.json'),
  };
  const identities = identityRead.registry;
  const declaredRole = explicitlyDeclaredRole(config, materialization);
  const roleBindingRequired = options.roleRequired ?? (Boolean(options.role?.trim()) || declaredRole === role);
  const roleIdentity = roleBindingRequired
    ? identities.identities.find((identity) => identity.role === role) ?? null
    : null;
  const projectedIdentity = roleBindingRequired && !roleIdentity
    ? materializedIdentityProjection(materialization, role)
    : null;
  const transportDeclared = declaredTransport(roleIdentity);
  const binding = runtimeBindingPosture(roleIdentity?.identity_id ?? null, runtimeRead.bindings);
  const siteId = siteIdForReadiness(config, materialization);

  let posture: SiteReadinessPosture;
  if (!siteExists) {
    posture = 'site_absent';
  } else if (!configExists || !aiExists) {
    posture = 'initialized_unready';
  } else if (roleBindingRequired && !roleIdentity) {
    posture = 'ready_missing_role_binding';
  } else if (roleBindingRequired && (!transportDeclared || binding.status !== 'bound')) {
    posture = 'ready_missing_transport';
  } else if (pendingInbox.length > 0) {
    posture = 'ready_pending_inbox';
  } else {
    posture = 'fully_idle';
  }

  const nextCommand = nextCommandFor(posture, siteRoot, authorityRoot, siteId, role, roleIdentity?.identity_id ?? projectedIdentity?.identity_id ?? null, binding);
  const capabilityChoices = clientServiceCapabilityChoices(config);
  const capabilityReadiness = businessCapabilityReadiness(config, posture);
  const identityAssessable = Boolean(roleIdentity);
  const checks: SiteReadinessCheck[] = [
    {
      name: 'site_root_exists',
      status: siteExists ? 'pass' : 'fail',
      message: siteExists ? siteRoot : 'missing: ' + siteRoot,
      next_command: siteExists ? undefined : nextCommand,
    },
    {
      name: 'site_config_exists',
      status: configExists ? 'pass' : 'fail',
      message: join(siteRoot, 'config.json'),
      next_command: configExists ? undefined : nextCommand,
    },
    {
      name: 'site_ai_surface_exists',
      status: aiExists ? 'pass' : 'fail',
      message: join(authorityRoot, '.ai'),
      next_command: aiExists ? undefined : nextCommand,
    },
    {
      name: 'role_identity_exists',
      status: roleIdentity || !roleBindingRequired ? 'pass' : 'fail',
      message: roleIdentity?.identity_id ?? (roleBindingRequired ? 'missing admitted role identity for ' + role : 'no role binding declared; not required'),
      next_command: roleIdentity || !roleBindingRequired ? undefined : nextCommand,
    },
    {
      name: 'operator_surface_identity_admitted',
      status: identityAssessable || !roleBindingRequired ? 'pass' : 'warn',
      message: identityAssessable
        ? 'durable identity admitted in ' + identityRead.path
        : roleBindingRequired
          ? 'not admitted; site materialization is only a projection and does not grant identity authority'
          : 'no role binding declared; not required',
      next_command: identityAssessable || !roleBindingRequired ? undefined : nextCommand,
    },
    {
      name: 'operator_surface_transport_declared',
      status: transportDeclared || !roleBindingRequired ? 'pass' : identityAssessable ? 'fail' : 'warn',
      message: !identityAssessable
        ? (roleBindingRequired ? 'not assessable until a durable role identity is admitted' : 'no role binding declared; not required')
        : transportDeclared
          ? 'submit transport metadata declared on the durable identity'
          : 'no submit transport declared on the durable identity',
      next_command: transportDeclared || !roleBindingRequired ? undefined : nextCommand,
    },
    {
      name: 'operator_surface_runtime_handle_bound',
      status: binding.status === 'bound' || !roleBindingRequired ? 'pass' : identityAssessable ? 'fail' : 'warn',
      message: !identityAssessable
        ? (roleBindingRequired ? 'not assessable until a durable role identity is admitted' : 'no role binding declared; not required')
        : binding.status === 'bound'
          ? 'runtime handle binding is active and evidenced'
          : 'runtime handle binding is ' + binding.status,
      next_command: binding.status === 'bound' || !roleBindingRequired ? undefined : nextCommand,
    },
    {
      name: 'readiness_phase_declared',
      status: readinessPhase(config).source === 'default' ? 'warn' : 'pass',
      message: readinessPhase(config).state,
      next_command: readinessPhase(config).source === 'default' ? 'narada sites doctor <site> --format json' : undefined,
    },
    {
      name: 'client_service_capability_choices',
      status: capabilityReadiness.status === 'choices_unresolved' ? 'warn' : 'pass',
      message: capabilityReadiness.note,
      next_command: capabilityReadiness.status === 'choices_unresolved'
        ? 'Record or defer capability choices under config capability_choices, then rerun narada sites doctor ' + JSON.stringify(siteId) + ' --root ' + JSON.stringify(siteRoot) + ' --format json'
        : undefined,
    },
  ];

  return {
    posture,
    target_locus: {
      site: options.site,
      site_id: siteId,
      site_root: siteRoot,
      operation: options.operation?.trim() || null,
    },
    onboarding: readinessPhase(config),
    coordinates: coordinates(config, roleIdentity, role, roleBindingRequired, transportDeclared, binding, identityRead.path, runtimeRead.path),
    readiness_strata: {
      structural: posture,
      business_capability: capabilityReadiness,
    },
    capability_choices: {
      site_kind: siteKind(config),
      required_before_inhabited_readiness: siteKind(config) === 'client_service',
      choices: capabilityChoices,
    },
    checks,
    blockers: checks.filter((check) => check.status === 'fail'),
    warnings: checks.filter((check) => check.status === 'warn'),
    pending_inbox: pendingInbox,
    next_command: nextCommand,
    bounded_output: true,
  };
}
