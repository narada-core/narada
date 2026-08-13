import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('node:fs');

const root = join(process.cwd(), '..', '..', '..');
const conceptPath = join(root, 'docs/concepts/orientation-manifest.md');
const carrierEntryContractPath = join(root, 'docs/concepts/startup-sequence-contract.md');
const sourceMapPath = join(root, 'docs/product/orientation-manifest-source-map.v0.md');
const fixturePath = join(
  root,
  'docs/product/fixtures/orientation-manifest/adversarial-cases.v0.json',
);

type AdversarialCase = {
  case_id: string;
  challenge: string;
  given: Record<string, unknown>;
  expected: {
    session_admission: string;
    session_activation: string;
    manifest_readiness: string;
    delivery: string;
    action_admission: string;
    reason_codes: string[];
    required_residuals: string[];
    source_mutation: boolean;
  };
};

function loadFixture(): {
  schema: string;
  status: string;
  concept_ref: string;
  source_map_ref: string;
  authority_decision: Record<string, unknown>;
  invariants: string[];
  cases: AdversarialCase[];
} {
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

function caseById(cases: AdversarialCase[], caseId: string): AdversarialCase {
  const value = cases.find((entry) => entry.case_id === caseId);
  if (!value) throw new Error(`orientation_manifest_fixture_missing:${caseId}`);
  return value;
}

describe('Orientation Manifest target-shape contract', () => {
  it('gives a normal occupant one receipt-bound orientation path', () => {
    const contract = readFileSync(carrierEntryContractPath, 'utf8');

    expect(contract).toContain('`agent_orientation_read({})`');
    expect(contract).toContain('opaque `continuation`');
    expect(contract).toMatch(/Required reads,\s+paging, completion evidence, and final acknowledgement remain server-owned\./);
    expect(contract).toContain('Normal discovery must not expose `startup_sequence`');
    expect(contract).toContain('refused before that point');
    expect(contract).toMatch(/successful performance of that\s+effect afterward/);
  });

  it('assigns embodiment admission to Carrier Session Authority without creating Agent Context authority', () => {
    const concept = readFileSync(conceptPath, 'utf8');
    const sourceMap = readFileSync(sourceMapPath, 'utf8');
    const doctrineIndex = readFileSync(join(root, 'AGENTS.md'), 'utf8');

    expect(concept).toContain('## Embodiment Admission Authority Decision');
    expect(concept).toMatch(/Carrier Session\s+Authority selected by the Site/);
    expect(concept).toContain('The authority key is the Site-scoped Carrier Session identity');
    expect(concept).toContain('Cardinality Is Policy');
    expect(concept).toContain('Agent Context facade | Temporary compatibility and diagnostic projection.');
    expect(sourceMap).toContain('Agent Context owns neither fact.');
    expect(sourceMap).toContain('Its one-active-NARS-session-per-principal rule remains');
    expect(sourceMap).toContain('(authority_scope, site_ref, carrier_session_id)');
    expect(doctrineIndex).toContain('docs/concepts/orientation-manifest.md');
  });

  it('maps current Agent Context fields to source owners and explicit migration dispositions', () => {
    const sourceMap = readFileSync(sourceMapPath, 'utf8');

    for (const compartment of [
      'Embodiment coordinates',
      'Office and durable identity',
      'Law and constraints',
      'Entry procedure',
      'Continuity',
      'Work orientation',
      'Capability projection',
      'Authority references',
      'Obligations',
      'Residuals',
      'Negative claims',
    ]) {
      expect(sourceMap).toContain(`| ${compartment} |`);
    }

    for (const currentBehavior of [
      '`agent_context_start_session`',
      '`agent_context_hydrate_current`',
      'latest checkpoint',
      'latest start event',
      '`startup_checkpoint`',
      '`intelligence_context_materialization`',
      'Codex `codex_session_admissions` table',
      'PC runtime `carrier_session.v0` record',
    ]) {
      expect(sourceMap).toContain(currentBehavior);
    }

    for (const disposition of [
      '`retain_reference`',
      '`reproject`',
      '`compatibility_trace`',
      '`move_to_owner`',
      '`residual`',
      '`remove`',
    ]) {
      expect(sourceMap).toContain(disposition);
    }
  });

  it('keeps a unique, machine-readable adversarial corpus with a uniform outcome shape', () => {
    const fixture = loadFixture();
    const ids = fixture.cases.map((entry) => entry.case_id);

    expect(fixture.schema).toBe('narada.orientation_manifest.adversarial_cases.v0');
    expect(fixture.status).toBe('precontract_falsification_fixture');
    expect(fixture.concept_ref).toBe('docs/concepts/orientation-manifest.md');
    expect(fixture.source_map_ref).toBe('docs/product/orientation-manifest-source-map.v0.md');
    expect(fixture.authority_decision).toMatchObject({
      owner: 'site_selected_carrier_session_authority',
      authority_key: 'authority_scope+site_ref+carrier_session_id',
      agent_cardinality: 'explicit_site_policy',
      orientation_compiler_authority: 'none',
      agent_context_authority: 'none',
    });
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(15);

    for (const entry of fixture.cases) {
      expect(entry.case_id).toMatch(/^[a-z0-9_]+$/);
      expect(entry.challenge.length).toBeGreaterThan(0);
      expect(entry.given).toBeTypeOf('object');
      expect(entry.expected).toEqual(expect.objectContaining({
        session_admission: expect.any(String),
        session_activation: expect.any(String),
        manifest_readiness: expect.any(String),
        delivery: expect.any(String),
        action_admission: expect.any(String),
        reason_codes: expect.any(Array),
        required_residuals: expect.any(Array),
        source_mutation: false,
      }));
    }
  });

  it('falsifies the known authority, continuity, freshness, and mutation collapses', () => {
    const { cases } = loadFixture();

    expect(caseById(cases, 'healthy_exact_binding').expected).toMatchObject({
      session_activation: 'active',
      manifest_readiness: 'ready',
      delivery: 'deliverable',
      action_admission: 'separate_required',
    });
    expect(caseById(cases, 'parallel_sessions_explicitly_allowed').expected.session_admission).toBe('admitted');
    expect(caseById(cases, 'singleton_policy_refuses_second_session').expected.session_admission).toBe('refused');
    expect(caseById(cases, 'ambient_latest_identity_fallback').expected.reason_codes).toContain(
      'ambient_identity_fallback_forbidden',
    );
    expect(caseById(cases, 'wrong_agent_handoff').expected.manifest_readiness).toBe('blocked');
    expect(caseById(cases, 'ambiguous_runtime_binding').expected).toMatchObject({
      session_activation: 'blocked',
      manifest_readiness: 'ready',
      delivery: 'withheld',
    });
    expect(caseById(cases, 'missing_required_law_projection').expected.manifest_readiness).toBe('blocked');
    expect(caseById(cases, 'conflicting_identity_revisions').expected.reason_codes).toContain(
      'source_revision_conflict',
    );
    expect(caseById(cases, 'stale_grant_projection').expected).toMatchObject({
      manifest_readiness: 'degraded',
      action_admission: 'refused',
    });
    expect(caseById(cases, 'grant_revoked_after_manifest_delivery').expected.action_admission).toBe('refused');
    expect(caseById(cases, 'resume_requires_exact_checkpoint').expected.reason_codes).toContain(
      'exact_continuity_reference_required',
    );
    expect(caseById(cases, 'optional_continuity_exceeds_packet_budget').expected).toMatchObject({
      manifest_readiness: 'degraded',
      delivery: 'deliverable',
    });
    expect(caseById(cases, 'assembly_attempts_checkpoint_write').expected.reason_codes).toContain(
      'assembly_source_mutation_forbidden',
    );
    expect(caseById(cases, 'manifest_reused_for_new_session').expected.reason_codes).toContain(
      'manifest_session_binding_mismatch',
    );
    expect(caseById(cases, 'stale_authority_epoch').expected.reason_codes).toContain(
      'authority_epoch_fenced',
    );
    expect(caseById(cases, 'runtime_binding_crosses_site_boundary').expected.session_activation).toBe('refused');
  });
});
