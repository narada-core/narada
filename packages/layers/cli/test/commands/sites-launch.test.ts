import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.unmock('node:fs');
vi.unmock('node:fs/promises');

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode } from '../../src/lib/exit-codes.js';
import type { CommandContext } from '../../src/lib/command-wrapper.js';
import { sitesLaunchCommand } from '../../src/commands/sites-launch.js';

const getManagedSite = vi.fn();
const getSchedulerSiteDaemonStatus = vi.fn();
const loadSiteMcpFabric = vi.fn();

vi.mock('@narada-core/windows-site', () => ({
  resolveRegistryDbPathByLocus: vi.fn(() => '/tmp/test-registry.db'),
  openRegistryDb: vi.fn(async () => ({})),
  SiteRegistry: vi.fn(() => ({
    getManagedSite,
    close: vi.fn(),
  })),
}));

vi.mock('../../src/lib/launcher-runtime-scheduler.js', () => ({
  getSchedulerSiteDaemonStatus: (...args: unknown[]) => getSchedulerSiteDaemonStatus(...args),
}));

vi.mock('@narada-core/mcp-fabric', () => ({
  loadSiteMcpFabric: (...args: unknown[]) => loadSiteMcpFabric(...args),
}));

function createMockContext(): CommandContext {
  return {
    configPath: '/test/config.json',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as unknown as CommandContext['logger'],
    verbose: false,
  };
}

interface LaunchResultShape {
  schema: string;
  status: string;
  dry_run: boolean;
  mutation_performed: boolean;
  site_id: string;
  site_root: string | null;
  checks: Array<{ id: string; status: string; summary: string; detail?: string; next_command?: string }>;
  actions: string[];
  console_url: string;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sites-launch-'));
  getManagedSite.mockReset();
  getSchedulerSiteDaemonStatus.mockReset();
  loadSiteMcpFabric.mockReset();
  getSchedulerSiteDaemonStatus.mockReturnValue({
    schema: 'narada.scheduler.site_daemon.status.v0',
    status: 'ok',
    mutation_performed: false,
    site_root: tmpRoot,
    task_name: 'Narada-Test-Daemon',
  });
  loadSiteMcpFabric.mockReturnValue({ servers: { 'test-server': {} }, registry_validation: { status: 'ok' } });
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('sitesLaunchCommand', () => {
  it('fails when the site is not in the registry', async () => {
    getManagedSite.mockReturnValue(null);
    const { exitCode, result } = await sitesLaunchCommand({ siteId: 'missing-site', format: 'json' }, createMockContext());
    const shaped = result as LaunchResultShape;
    expect(exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(shaped.schema).toBe('narada.sites.launch.result.v0');
    expect(shaped.status).toBe('failed');
    expect(shaped.checks[0]).toMatchObject({ id: 'site_resolution', status: 'fail' });
  });

  it('distinguishes a registry read error from a missing site', async () => {
    getManagedSite.mockImplementation(() => { throw new Error('db corrupt'); });
    const { exitCode, result } = await sitesLaunchCommand({ siteId: 'any-site', format: 'json' }, createMockContext());
    const shaped = result as LaunchResultShape;
    expect(exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(shaped.checks[0]).toMatchObject({ id: 'site_resolution', status: 'fail' });
    expect(shaped.checks[0]!.detail).toContain('db corrupt');
  });

  it('reports scheduler posture directly without a procedure declaration', async () => {
    getManagedSite.mockReturnValue({ siteId: 'test-site', siteRoot: tmpRoot });
    const { exitCode, result } = await sitesLaunchCommand({ siteId: 'test-site', format: 'json' }, createMockContext());
    const shaped = result as LaunchResultShape;
    expect(exitCode).toBe(ExitCode.SUCCESS);
    expect(shaped.status).toBe('ok');
    expect(shaped.mutation_performed).toBe(false);
    expect(shaped.checks.map((check) => check.id)).toEqual(['site_resolution', 'mcp_surface_materialization', 'scheduler_posture']);
    expect(shaped.checks.find((check) => check.id === 'scheduler_posture')).toMatchObject({ status: 'pass' });
    expect(getSchedulerSiteDaemonStatus).toHaveBeenCalledWith({ siteRoot: tmpRoot });
  });

  it('reports an actionable scheduler-install command when no task is present', async () => {
    getManagedSite.mockReturnValue({ siteId: 'test-site', siteRoot: tmpRoot });
    getSchedulerSiteDaemonStatus.mockReturnValue({ status: 'not_found', task_name: 'Narada-Test-Daemon' });
    const { exitCode, result } = await sitesLaunchCommand({ siteId: 'test-site', dryRun: true, format: 'json' }, createMockContext());
    const shaped = result as LaunchResultShape;
    expect(exitCode).toBe(ExitCode.SUCCESS);
    expect(shaped.status).toBe('dry_run');
    expect(shaped.mutation_performed).toBe(false);
    expect(shaped.checks.find((check) => check.id === 'scheduler_posture')).toMatchObject({ status: 'warn' });
    expect(shaped.checks.find((check) => check.id === 'scheduler_posture')?.next_command).toContain('scheduler site-daemon install');
  });
});
