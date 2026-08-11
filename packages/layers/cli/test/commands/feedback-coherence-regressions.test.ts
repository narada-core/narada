import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { operatorSurfaceIdentityAddCommand } from '../../src/commands/operator-surface.js';
import { selectLaunchRecords } from '../../src/commands/workspace-launch-registry.js';
import { sitesBootstrapProjectCommand, sitesDoctorCommand } from '../../src/commands/sites.js';
import type { CommandContext } from '../../src/lib/command-wrapper.js';
import { ExitCode } from '../../src/lib/exit-codes.js';

const roots: string[] = [];

function context(): CommandContext {
  return {
    configPath: '/test/config.json',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    } as unknown as CommandContext['logger'],
    verbose: false,
  };
}

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('feedback coherence regressions', () => {
  it('writes operator identities at the configured Site governance root when cwd is the workspace', async () => {
    const workspace = await root('narada-identity-authority-');
    const siteRoot = join(workspace, '.narada');
    await mkdir(siteRoot, { recursive: true });
    await writeFile(join(siteRoot, 'config.json'), JSON.stringify({
      site_id: 'cintamani',
      site_root: siteRoot,
      locus: { governance_root: siteRoot },
    }), 'utf8');

    const result = await operatorSurfaceIdentityAddCommand({
      cwd: workspace,
      identityName: 'cintamani.builder',
      site: 'cintamani',
      role: 'builder',
      agentKind: 'codex_cli',
      by: 'operator',
    }, context());

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(existsSync(join(siteRoot, 'operator-surfaces', 'identities.json'))).toBe(true);
    expect(existsSync(join(workspace, 'operator-surfaces', 'identities.json'))).toBe(false);
  });

  it('reports the role stage when a Site matches but its requested role does not', () => {
    const records = [{
      agent: 'cintamani.architect',
      title: 'Architect',
      role: 'architect',
      site: 'cintamani',
      narada_root: 'C:/Narada',
      site_root: 'C:/sites/cintamani',
      workspace_root: 'C:/sites/cintamani',
    }] as never[];

    expect(() => selectLaunchRecords(records, {
      site: ['cintamani'],
      role: ['builder'],
    })).toThrow(/no_agents_match_role_filter: builder \(site_match_count=1\)/);
  });

  it('bootstraps a truthful deferred role plane and project doctor admits it', async () => {
    const workspace = await root('narada-role-plane-');
    await mkdir(join(workspace, '.git'));

    const bootstrap = await sitesBootstrapProjectCommand({
      workspace,
      siteId: 'cintamani',
      execute: true,
      format: 'json',
    }, context());
    expect(bootstrap.exitCode).toBe(ExitCode.SUCCESS);

    const siteRoot = join(workspace, '.narada');
    const rolePlane = JSON.parse(await readFile(join(siteRoot, '.ai', 'agents', 'role-plane.json'), 'utf8')) as {
      roles_are_obligation_targets: boolean;
      roles: Array<{ role_id: string; declaration_status: string; next_action?: { command?: string } }>;
    };
    expect(rolePlane.roles_are_obligation_targets).toBe(true);
    for (const roleId of ['architect', 'builder']) {
      const role = rolePlane.roles.find((entry) => entry.role_id === roleId);
      expect(role).toMatchObject({ declaration_status: 'declared_pending_runtime_admission' });
      expect(role?.next_action?.command).toContain(`--role ${roleId}`);
    }

    const doctor = await sitesDoctorCommand('cintamani', {
      kind: 'project',
      root: workspace,
      format: 'json',
    }, context());
    const checks = (doctor.result as { checks: Array<{ name: string; status: string }> }).checks;
    expect(checks.find((check) => check.name === 'role_obligation_target_policy')?.status).toBe('pass');
    expect(checks.find((check) => check.name === 'role_runtime_architect')?.status).toBe('pass');
    expect(checks.find((check) => check.name === 'role_runtime_builder')?.status).toBe('pass');
  });
});
