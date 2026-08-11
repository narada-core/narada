import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('node:fs');
vi.unmock('node:fs/promises');
import {
  sitesBootstrapProjectCommand,
  sitesDoctorCommand,
} from '../../src/commands/sites.js';
import { ExitCode } from '../../src/lib/exit-codes.js';
import type { CommandContext } from '../../src/lib/command-wrapper.js';

function createMockContext(): CommandContext {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  };
  return {
    configPath: '/test/config.json',
    logger: logger as unknown as CommandContext['logger'],
    verbose: false,
  };
}

const tempDirs: string[] = [];

async function tempWorkspace(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  await mkdir(join(dir, '.git'));
  return dir;
}

const originalAutoDiscovery = process.env.NARADA_MCP_AUTO_DISCOVERY;
const originalSourceRoot = process.env.NARADA_SRC_ROOT;
const originalCodexHome = process.env.CODEX_HOME;
const originalCarrierHome = process.env.NARADA_CARRIER_HOME;

beforeEach(() => {
  process.env.NARADA_MCP_AUTO_DISCOVERY = '0';
  delete process.env.NARADA_SRC_ROOT;
  delete process.env.CODEX_HOME;
  delete process.env.NARADA_CARRIER_HOME;
});
afterEach(async () => {
  if (originalAutoDiscovery === undefined) delete process.env.NARADA_MCP_AUTO_DISCOVERY;
  else process.env.NARADA_MCP_AUTO_DISCOVERY = originalAutoDiscovery;
  if (originalSourceRoot === undefined) delete process.env.NARADA_SRC_ROOT;
  else process.env.NARADA_SRC_ROOT = originalSourceRoot;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalCarrierHome === undefined) delete process.env.NARADA_CARRIER_HOME;
  else process.env.NARADA_CARRIER_HOME = originalCarrierHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('sitesBootstrapProjectCommand', () => {
  it('dry-runs a contained project Site without writing', async () => {
    const workspace = await tempWorkspace('narada-project-dry-');
    const result = await sitesBootstrapProjectCommand({
      workspace,
      siteId: 'smart-scheduling',
      format: 'json',
    }, createMockContext());

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    const data = result.result as {
      status: string;
      mutation_performed: boolean;
      site_kind?: string;
      site_root: string;
      sync_posture: string;
      config: { site_kind: string; sync: { posture: string } };
    };
    expect(data.status).toBe('dry_run');
    expect(data.mutation_performed).toBe(false);
    expect(data.site_root).toBe(join(workspace, '.narada'));
    expect(data.sync_posture).toBe('git_backed_project_repo');
    expect(data.config.site_kind).toBe('project');
    expect(data.config.sync.posture).toBe('git_backed_project_repo');
    expect(existsSync(join(workspace, '.narada'))).toBe(false);
  });

  it('executes project Site bootstrap and passes project doctor', async () => {
    const workspace = await tempWorkspace('narada-project-exec-');
    const result = await sitesBootstrapProjectCommand({
      workspace,
      siteId: 'smart-scheduling',
      execute: true,
      format: 'json',
    }, createMockContext());

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(existsSync(join(workspace, '.narada', 'config.json'))).toBe(true);
    expect(existsSync(join(workspace, '.ai', 'task-lifecycle.db'))).toBe(true);
    expect(await readFile(join(workspace, '.narada', 'task-lifecycle.toml'), 'utf8')).toContain('roles_are_obligation_targets = true');
    const agents = await readFile(join(workspace, '.narada', 'AGENTS.md'), 'utf8');
    expect(agents).toContain('You are `architect`.');
    expect(agents).toContain('You are `builder`.');
    expect(agents).toContain('The Site value-producing inhabitant role is `resident`');
    expect(agents).toContain('## Site Participant Roles');
    expect(agents).toContain('`resident` lives in or uses the Site to produce the Site');
    expect(agents).toContain('## Architect Thread Bootstrap');
    expect(agents).toContain('## Builder Thread Bootstrap');
    expect(agents).toContain('The human is `Operator`.');
    expect(agents).toContain('This Site is governed by Narada law.');
    expect(agents).toContain('project-local governance');
    expect(agents).toContain('Treat this file as the Site-local execution contract for fresh Architect, Builder, and Observer threads.');
    expect(agents).toContain('Project code and artifacts outside `site_root` are not Narada knowledge');
    expect(agents).not.toContain('## Inspector Thread Bootstrap');
    expect(agents).not.toContain('## Superintendent Thread Bootstrap');
    const config = JSON.parse(await readFile(join(workspace, '.narada', 'config.json'), 'utf8')) as {
      governance: {
        governing_law_source: { source_site_id: string; mode: string };
        authority_locus: { locus_kind: string; mutation_policy: string };
        mutation_evidence_locus: { kind: string; path: string };
        federation_policy: { posture: string; admission: string };
        doctrine_imports: unknown[];
        site_participant_roles: Array<{ role_id: string; role_class: string; runtime_kind?: string; authority_posture: string }>;
        agent_role_contracts: Record<string, unknown> & { admitted_roles: string[]; architect: { role_id: string }; builder: { role_id: string } };
        operator_surfaces: unknown[];
        session_bindings: unknown[];
      };
    };
    expect(config.governance.governing_law_source.source_site_id).toBe('narada-proper');
    expect(config.governance.governing_law_source.mode).toBe('inherited');
    expect(config.governance.authority_locus.locus_kind).toBe('project');
    expect(config.governance.authority_locus.mutation_policy).toBe('direct_only_at_locus');
    expect(config.governance.mutation_evidence_locus.kind).toBe('git');
    expect(config.governance.mutation_evidence_locus.path).toBe(join(workspace, '.narada'));
    expect(config.governance.doctrine_imports).toEqual([]);
    expect(config.governance.federation_policy.posture).toBe('receive_only');
    expect(config.governance.federation_policy.admission).toBe('local_admission_required');
    expect(config.governance.site_participant_roles.map((role) => role.role_id)).toEqual(['resident', 'architect', 'builder']);
    expect(config.governance.site_participant_roles.find((role) => role.role_id === 'resident')).toMatchObject({
      role_class: 'resident',
      runtime_kind: 'human',
      authority_posture: 'value_use',
    });
    expect(config.governance.agent_role_contracts.admitted_roles).toEqual(['architect', 'builder', 'observer']);
    expect(config.governance.agent_role_contracts.architect.role_id).toBe('architect');
    expect(config.governance.agent_role_contracts.builder.role_id).toBe('builder');
    expect(config.governance.agent_role_contracts).not.toHaveProperty('inspector');
    expect(config.governance.agent_role_contracts).not.toHaveProperty('superintendent');
    expect(config.governance.operator_surfaces).toEqual([]);
    expect(config.governance.session_bindings).toEqual([]);

    const doctor = await sitesDoctorCommand('smart-scheduling', {
      kind: 'project',
      root: workspace,
      format: 'json',
    }, createMockContext());
    expect(doctor.exitCode).toBe(ExitCode.SUCCESS);
    const data = doctor.result as {
      status: string;
      checks: Array<{ name: string; status: string }>;
      readiness: {
        onboarding: { state: string; source: string };
        coordinates: {
          governing_law_source: { source_site_id: string };
          authority_locus: { locus_kind: string };
          evidence_locus: { kind: string };
        };
        blockers: Array<{ name: string }>;
        warnings: Array<{ name: string }>;
      };
    };
    expect(data.status).toBe('passed');
    expect(data.checks.find((check) => check.name === 'site_kind')?.status).toBe('pass');
    expect(data.checks.find((check) => check.name === 'project_sync_posture')?.status).toBe('pass');
    expect(data.readiness.onboarding).toMatchObject({ state: 'bootstrap', source: 'governance.readiness_phase' });
    expect(data.readiness.coordinates.governing_law_source.source_site_id).toBe('narada-proper');
    expect(data.readiness.coordinates.authority_locus.locus_kind).toBe('project');
    expect(data.readiness.coordinates.evidence_locus.kind).toBe('git');
    expect(data.readiness.coordinates.operator_surface_posture.required).toBe(true);
    expect(data.readiness.blockers.find((check) => check.name === 'role_identity_exists')).toMatchObject({ status: 'fail' });
    expect(data.readiness.warnings.map((check) => check.name)).toEqual([
      'operator_surface_identity_admitted',
      'operator_surface_transport_declared',
      'operator_surface_runtime_handle_bound',
    ]);
  });

  it('recovers configured MCP carrier materialization before the first Site write', async () => {
    const workspace = await tempWorkspace('narada-project-recovery-');
    const mcpWorkspace = await tempWorkspace('narada-mcp-recovery-');
    await mkdir(join(mcpWorkspace, 'scripts'), { recursive: true });
    await writeFile(join(mcpWorkspace, 'scripts', 'recover-carrier-materialization.mjs'), [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "if (existsSync(process.env.NARADA_PROJECT_SITE_ROOT)) throw new Error('site_was_written_before_recovery');",
      "writeFileSync(new URL('./recovery-ran', import.meta.url), 'yes');",
      "process.stdout.write(JSON.stringify({ schema: 'narada.carrier_materialization_recovery.v1', status: 'recovered', all_carrier_materialization_performed: true }));",
    ].join('\n'));

    const result = await sitesBootstrapProjectCommand({
      workspace,
      siteId: 'recovered-project',
      mcpWorkspaceRoot: mcpWorkspace,
      execute: true,
      format: 'json',
    }, createMockContext());

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(existsSync(join(mcpWorkspace, 'scripts', 'recovery-ran'))).toBe(true);
    expect(existsSync(join(workspace, '.narada', 'config.json'))).toBe(true);
    expect((result.result as { mcp_materialization_recovery: { status: string } }).mcp_materialization_recovery.status).toBe('recovered');
  });

  it('discovers the standard mcp-surfaces checkout from NARADA_SRC_ROOT', async () => {
    const workspace = await tempWorkspace('narada-project-auto-recovery-');
    const sourceRoot = await tempWorkspace('narada-source-root-');
    const mcpWorkspace = join(sourceRoot, 'mcp-surfaces');
    await mkdir(join(mcpWorkspace, 'scripts'), { recursive: true });
    await mkdir(join(mcpWorkspace, 'packages', 'mcp-registrar'), { recursive: true });
    await writeFile(join(mcpWorkspace, 'packages', 'mcp-registrar', 'package.json'), '{"name":"@narada-core/mcp-registrar"}\n');
    await writeFile(
      join(mcpWorkspace, 'scripts', 'recover-carrier-materialization.mjs'),
      "process.stdout.write(JSON.stringify({ schema: 'narada.carrier_materialization_recovery.v1', status: 'current', restart_required: false }));\n",
    );
    process.env.NARADA_MCP_AUTO_DISCOVERY = '1';
    process.env.NARADA_SRC_ROOT = sourceRoot;

    const result = await sitesBootstrapProjectCommand({
      workspace,
      siteId: 'auto-recovered-project',
      execute: true,
      format: 'json',
    }, createMockContext());
    const recovery = (result.result as {
      mcp_materialization_recovery: { status: string; workspace_discovery: { source: string } };
    }).mcp_materialization_recovery;
    expect(recovery.status).toBe('current');
    expect(recovery.workspace_discovery.source).toBe('source_root');
  });

  it('discovers the exact workspace recorded by an installed carrier before filesystem conventions', async () => {
    const workspace = await tempWorkspace('narada-project-carrier-recovery-');
    const codexHome = await tempWorkspace('narada-codex-home-');
    const mcpWorkspace = await tempWorkspace('narada-materialized-mcp-');
    await mkdir(join(mcpWorkspace, 'scripts'), { recursive: true });
    await mkdir(join(mcpWorkspace, 'packages', 'mcp-registrar'), { recursive: true });
    await mkdir(join(mcpWorkspace, '.ai', 'runtime'), { recursive: true });
    await writeFile(join(mcpWorkspace, 'packages', 'mcp-registrar', 'package.json'), '{"name":"@narada-core/mcp-registrar"}\n');
    await writeFile(
      join(mcpWorkspace, 'scripts', 'recover-carrier-materialization.mjs'),
      "process.stdout.write(JSON.stringify({ schema: 'narada.carrier_materialization_recovery.v1', status: 'current', restart_required: false }));\n",
    );
    await writeFile(join(codexHome, 'config.toml.narada-generation.json'), JSON.stringify({
      artifact_manifest_path: join(mcpWorkspace, '.ai', 'runtime', 'workspace-artifact-manifest.json'),
    }));
    process.env.NARADA_MCP_AUTO_DISCOVERY = '1';
    process.env.CODEX_HOME = codexHome;
    process.env.NARADA_CARRIER_HOME = codexHome;

    const result = await sitesBootstrapProjectCommand({
      workspace,
      siteId: 'carrier-recovered-project',
      execute: true,
      format: 'json',
    }, createMockContext());
    const recovery = (result.result as {
      mcp_materialization_recovery: { status: string; workspace_discovery: { source: string } };
    }).mcp_materialization_recovery;
    expect(recovery.status).toBe('current');
    expect(recovery.workspace_discovery.source).toBe('carrier_generation');
  });
  it('leaves no partial Site when configured MCP recovery fails', async () => {
    const workspace = await tempWorkspace('narada-project-recovery-fail-');
    const mcpWorkspace = await tempWorkspace('narada-mcp-recovery-fail-');
    await mkdir(join(mcpWorkspace, 'scripts'), { recursive: true });
    await writeFile(
      join(mcpWorkspace, 'scripts', 'recover-carrier-materialization.mjs'),
      "process.stderr.write('purposeful recovery failure'); process.exit(9);\n",
    );

    await expect(sitesBootstrapProjectCommand({
      workspace,
      siteId: 'unwritten-project',
      mcpWorkspaceRoot: mcpWorkspace,
      execute: true,
      format: 'json',
    }, createMockContext())).rejects.toThrow('mcp_recovery_failed');
    expect(existsSync(join(workspace, '.narada'))).toBe(false);
  });
  it('refuses non-project sync posture', async () => {
    const workspace = await tempWorkspace('narada-project-bad-');
    const result = await sitesBootstrapProjectCommand({
      workspace,
      siteId: 'smart-scheduling',
      sync: 'local_non_git',
      format: 'json',
    }, createMockContext());

    expect(result.exitCode).toBe(ExitCode.INVALID_CONFIG);
    expect((result.result as { error: string }).error).toContain('Unsupported project sync posture');
  });
});
