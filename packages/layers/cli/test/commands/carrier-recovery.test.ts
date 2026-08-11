import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('node:fs');
vi.unmock('node:fs/promises');
import { carrierRecoverCommand, carrierRecoveryRestartDecision } from '../../src/commands/carrier-restart.js';
import { discoverMcpRecoveryWorkspace } from '../../src/lib/mcp-carrier-recovery.js';
import { assertMcpCarrierSessionBinding, resolveMcpCarrierLifecycleAdapter } from '../../src/lib/mcp-carrier-lifecycle-adapter.js';
import type { CommandContext } from '../../src/lib/command-wrapper.js';
import { ExitCode } from '../../src/lib/exit-codes.js';
import { resolveNaradaSitePaths } from '@narada-core/site-paths';
import {
  authorityTransitionStatePathFromSessionPath,
  readAuthorityTransitionSourceState,
  writeNarsSessionStartedIndex,
} from '@narada-core/nars-session-core';

const roots: string[] = [];
async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const context = { verbose: false, logger: console } as unknown as CommandContext;

async function recoveryWorkspace(root: string, name: string): Promise<string> {
  const workspace = join(root, name);
  await mkdir(join(workspace, 'scripts'), { recursive: true });
  await mkdir(join(workspace, 'packages', 'mcp-registrar'), { recursive: true });
  await mkdir(join(workspace, '.ai', 'runtime'), { recursive: true });
  await writeFile(join(workspace, 'scripts', 'recover-carrier-materialization.mjs'), 'process.exit(0);\n');
  await writeFile(join(workspace, 'packages', 'mcp-registrar', 'package.json'), '{}\n');
  return workspace;
}

describe('cross-carrier generation discovery', () => {
  it('discovers the Kimi generation sidecar', async () => {
    const root = await temporaryRoot('narada-kimi-sidecar-');
    const workspace = await recoveryWorkspace(root, 'kimi-mcp-surfaces');
    const sidecar = join(root, '.kimi-code', 'mcp.json.narada-generation.json');
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(sidecar, JSON.stringify({ artifact_manifest_path: join(workspace, '.ai', 'runtime', 'workspace-artifact-manifest.json') }));
    expect(discoverMcpRecoveryWorkspace(undefined, { homeDirectory: root })).toEqual({
      root: workspace,
      source: 'carrier_generation',
      carrier_ids: ['kimi-andrey'],
    });
  });

  it('discovers the OpenCode generation sidecar', async () => {
    const root = await temporaryRoot('narada-opencode-sidecar-');
    const workspace = await recoveryWorkspace(root, 'opencode-mcp-surfaces');
    const sidecarRoot = join(root, '.config', 'opencode');
    await mkdir(sidecarRoot, { recursive: true });
    await writeFile(join(sidecarRoot, 'opencode.jsonc.narada-generation.json'), JSON.stringify({
      artifact_manifest_path: join(workspace, '.ai', 'runtime', 'workspace-artifact-manifest.json'),
    }));
    expect(discoverMcpRecoveryWorkspace(undefined, { homeDirectory: root })).toEqual({
      root: workspace,
      source: 'carrier_generation',
      carrier_ids: ['opencode-andrey'],
    });
  });

  it('discovers custom carrier paths through the canonical installed-carrier index', async () => {
    const root = await temporaryRoot('narada-installed-carrier-index-');
    const workspace = await recoveryWorkspace(root, 'custom-mcp-surfaces');
    const sidecar = join(root, 'custom', 'codex.generation.json');
    const indexPath = join(root, 'installed-carriers.json');
    await mkdir(join(root, 'custom'), { recursive: true });
    await writeFile(sidecar, JSON.stringify({ artifact_manifest_path: join(workspace, '.ai', 'runtime', 'workspace-artifact-manifest.json') }));
    await writeFile(indexPath, JSON.stringify({
      schema: 'narada.installed_carrier_index.v1',
      carriers: [{ carrier_id: 'codex-andrey', generation_sidecar_path: sidecar }],
    }));
    expect(discoverMcpRecoveryWorkspace(undefined, { homeDirectory: root, installedCarrierIndexPath: indexPath })).toEqual({
      root: workspace,
      source: 'carrier_generation',
      carrier_ids: ['codex-andrey'],
    });
  });
  it('refuses conflicting workspaces recorded by different carrier generations', async () => {
    const root = await temporaryRoot('narada-carrier-sidecar-conflict-');
    const kimiWorkspace = await recoveryWorkspace(root, 'kimi-workspace');
    const opencodeWorkspace = await recoveryWorkspace(root, 'opencode-workspace');
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await mkdir(join(root, '.config', 'opencode'), { recursive: true });
    await writeFile(join(root, '.kimi-code', 'mcp.json.narada-generation.json'), JSON.stringify({
      artifact_manifest_path: join(kimiWorkspace, '.ai', 'runtime', 'workspace-artifact-manifest.json'),
    }));
    await writeFile(join(root, '.config', 'opencode', 'opencode.jsonc.narada-generation.json'), JSON.stringify({
      artifact_manifest_path: join(opencodeWorkspace, '.ai', 'runtime', 'workspace-artifact-manifest.json'),
    }));
    expect(() => discoverMcpRecoveryWorkspace(undefined, { homeDirectory: root }))
      .toThrow(/mcp_carrier_generation_workspace_conflict/);
  });
});
describe('MCP carrier lifecycle adapter', () => {
  it('rejects a NARS session bound to a different materialized carrier', async () => {
    const root = await temporaryRoot('narada-carrier-binding-');
    const sessionId = 'bound-session';
    const paths = resolveNaradaSitePaths({ siteRoot: root, sessionId });
    await mkdir(paths.narsSessionDir!, { recursive: true });
    writeNarsSessionStartedIndex({
      sessionStartedEvent: { event: 'session_started', session_id: sessionId, site_root: root, materialized_carrier_id: 'kimi-andrey' },
      sessionPath: paths.narsSessionPath,
      siteRoot: root,
      now: new Date('2026-08-11T12:00:00.000Z'),
    });
    expect(() => assertMcpCarrierSessionBinding(root, sessionId, 'codex-andrey'))
      .toThrow(/mcp_carrier_session_binding_mismatch/);
  });
  it('requires explicit adapter selection and exposes NARS handoff semantics', () => {
    expect(() => resolveMcpCarrierLifecycleAdapter(undefined, 'codex-andrey'))
      .toThrow(/mcp_carrier_lifecycle_adapter_required/);
    expect(() => resolveMcpCarrierLifecycleAdapter('process-kill', 'codex-andrey'))
      .toThrow(/mcp_carrier_lifecycle_adapter_unknown/);
    expect(resolveMcpCarrierLifecycleAdapter('nars-successor-v1', 'kimi-andrey')).toMatchObject({
      adapter_id: 'nars-successor-v1',
      activation_authority: 'nars_session_authority_handoff',
      activation_mechanism: 'pc_owned_successor_drain_supervisor',
      requires_managed_nars_session: true,
      postcondition: 'successor_ready_source_retired',
    });
  });
});
describe('carrier recover and relaunch', () => {
  it('selects only the affected managed carrier and preserves outstanding restart pressure', () => {
    expect(carrierRecoveryRestartDecision({
      restart_required: true,
      restart_carrier_ids: ['codex-andrey', 'kimi-andrey'],
    }, 'codex-andrey')).toEqual({
      restart_required: true,
      selected_carrier_affected: true,
      affected_carrier_ids: ['codex-andrey', 'kimi-andrey'],
      outstanding_carrier_ids: ['kimi-andrey'],
    });
  });

  it('executes recovery then governed restart for an affected managed carrier', async () => {
    let restarted = false;
    const response = await carrierRecoverCommand({
      carrierId: 'codex-andrey',
      lifecycleAdapter: 'nars-successor-v1',
      siteRoot: 'C:/site',
      carrierSessionId: 'source-1',
      format: 'json',
    }, context, {
      recover: async () => ({
        schema: 'narada.carrier_materialization_recovery.v1',
        status: 'recovered',
        restart_required: true,
        restart_carrier_ids: ['codex-andrey', 'kimi-andrey'],
      }),
      verifyBinding: () => ({ session_id: 'source-1', materialized_carrier_id: 'codex-andrey' }),
      acknowledgeRestart: async () => ({ schema: 'narada.carrier_restart_acknowledgement.v1', status: 'acknowledged' }),
      restart: async () => {
        restarted = true;
        return { exitCode: ExitCode.SUCCESS, result: { status: 'completed', target_session_id: 'successor-1' } };
      },
    });
    expect(restarted).toBe(true);
    expect(response.exitCode).toBe(ExitCode.SUCCESS);
    const result = response.result as { status: string; restart_decision: { outstanding_carrier_ids: string[] } };
    expect(result.status).toBe('completed');
    expect(result.restart_decision.outstanding_carrier_ids).toEqual(['kimi-andrey']);
  });
  it('preserves selected-carrier restart pressure when successor activation fails', async () => {
    const response = await carrierRecoverCommand({
      carrierId: 'codex-andrey',
      lifecycleAdapter: 'nars-successor-v1',
      siteRoot: 'C:/site',
      carrierSessionId: 'source-1',
      format: 'json',
    }, context, {
      recover: async () => ({
        schema: 'narada.carrier_materialization_recovery.v1',
        status: 'recovered',
        restart_required: true,
        restart_carrier_ids: ['codex-andrey', 'kimi-andrey'],
      }),
      verifyBinding: () => ({ session_id: 'source-1', materialized_carrier_id: 'codex-andrey' }),
      restart: async () => ({ exitCode: ExitCode.INVALID_CONFIG, result: { status: 'failed' } }),
    });
    expect(response.exitCode).toBe(ExitCode.INVALID_CONFIG);
    const result = response.result as { restart_decision: { outstanding_carrier_ids: string[] } };
    expect(result.restart_decision.outstanding_carrier_ids).toEqual(['codex-andrey', 'kimi-andrey']);
  });
  it('performs recovery then real governed successor activation without replacing either operation', async () => {
    const root = await temporaryRoot('narada-carrier-recover-e2e-');
    const mcp = await recoveryWorkspace(root, 'mcp-surfaces');
    const recoveryMarker = join(mcp, 'recovery-performed.json');
    await writeFile(join(mcp, 'scripts', 'recover-carrier-materialization.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "if (process.argv.includes('--ack-carrier')) { process.stdout.write(JSON.stringify({ schema: 'narada.carrier_restart_acknowledgement.v1', status: 'acknowledged' })); process.exit(0); }",
      `writeFileSync(${JSON.stringify(recoveryMarker)}, JSON.stringify({ status: 'recovered' }));`,
      "process.stdout.write(JSON.stringify({ schema: 'narada.carrier_materialization_recovery.v1', status: 'recovered', restart_required: true, restart_carrier_ids: ['codex-andrey'] }));",
    ].join('\n'));

    const sourceSessionId = 'carrier_recovery_source';
    const sourcePaths = resolveNaradaSitePaths({ siteRoot: root, sessionId: sourceSessionId });
    await mkdir(sourcePaths.narsSessionDir!, { recursive: true });
    await writeFile(sourcePaths.narsControlPath!, '', 'utf8');
    const startedAt = '2026-08-11T12:00:00.000Z';
    const startedEvent = {
      event: 'session_started',
      sequence: 1,
      session_id: sourceSessionId,
      runtime_session_id: sourceSessionId,
      carrier_session_id: sourceSessionId,
      agent_id: 'test-site.resident',
      site_id: 'test-site',
      site_root: root,
      runtime: 'narada-agent-runtime-server',
      operator_surface_kind: 'codex',
      materialized_carrier_id: 'codex-andrey',
      started_at: startedAt,
      health_endpoint: null,
    };
    await appendFile(sourcePaths.narsEventsPath!, JSON.stringify(startedEvent) + '\n', 'utf8');
    writeNarsSessionStartedIndex({ sessionStartedEvent: startedEvent, sessionPath: sourcePaths.narsSessionPath, siteRoot: root, now: new Date(startedAt) });

    let sourceCloseRecorded = false;
    const response = await carrierRecoverCommand({
      mcpWorkspaceRoot: mcp,
      carrierId: 'codex-andrey',
      lifecycleAdapter: 'nars-successor-v1',
      siteRoot: root,
      pcSiteRoot: root,
      siteId: 'test-site',
      carrierSessionId: sourceSessionId,
      operationId: 'recover-e2e-1',
      requestedBy: 'operator',
      expectedStateJson: JSON.stringify({ manifest_digest: null, observation_digest: 'c'.repeat(64), descriptor_digest: null }),
      reason: 'performative recovery and successor proof',
      timeoutMs: 10_000,
      mutatingAuthorized: 'carrier.restart',
      format: 'json',
    }, context, {
      restartSupervisor: {
        launch: async (spec) => {
          const target = resolveNaradaSitePaths({ siteRoot: root, sessionId: spec.sessionId });
          await mkdir(target.narsSessionDir!, { recursive: true });
          await appendFile(target.narsEventsPath!, JSON.stringify({
            event: 'session_started',
            sequence: 1,
            session_id: spec.sessionId,
            health_endpoint: `http://carrier.test/${spec.sessionId}/health`,
          }) + '\n', 'utf8');
          await writeFile(target.narsHeartbeatPath!, JSON.stringify({ last_written_at: new Date().toISOString() }), 'utf8');
          return { ok: true, exit_code: 0, signal: null, stdout: '', stderr: '' };
        },
        healthCheck: async (endpoint) => ({
          ready: true,
          status: 'healthy',
          lifecycle_state: 'ready',
          mcp_operational_state: 'healthy',
          endpoint,
          body: { status: 'healthy', lifecycle_state: 'ready', mcp_operational_state: 'healthy' },
        }),
        sleep: async () => {
          if (!sourceCloseRecorded) {
            sourceCloseRecorded = true;
            await appendFile(sourcePaths.narsEventsPath!, JSON.stringify({ event: 'session_closed', sequence: 2 }) + '\n', 'utf8');
          }
        },
      },
    });

    expect(JSON.parse(await readFile(recoveryMarker, 'utf8')).status).toBe('recovered');
    expect(response.exitCode).toBe(ExitCode.SUCCESS);
    const result = response.result as {
      status: string;
      lifecycle_adapter: { adapter_id: string };
      restart: { status: string; source_retired: boolean };
    };
    expect(result.status).toBe('completed');
    expect(result.lifecycle_adapter.adapter_id).toBe('nars-successor-v1');
    expect(result.restart.status).toBe('completed');
    expect(result.restart.source_retired).toBe(true);
    const statePath = authorityTransitionStatePathFromSessionPath(sourcePaths.narsSessionPath!);
    expect(readAuthorityTransitionSourceState(statePath).source_write_admission).toBe('retired');
    expect(await readFile(sourcePaths.narsControlPath!, 'utf8')).toContain('session.close');
  });
  it.skipIf(process.env.NARADA_CARRIER_RECOVERY_PROCESS_E2E !== '1')('uses a real disposable target process and real HTTP health boundary', async () => {
    const root = await temporaryRoot('narada-carrier-process-e2e-');
    const mcp = await recoveryWorkspace(root, 'mcp-surfaces');
    await writeFile(join(mcp, 'scripts', 'recover-carrier-materialization.mjs'), [
      "if (process.argv.includes('--ack-carrier')) { process.stdout.write(JSON.stringify({ schema: 'narada.carrier_restart_acknowledgement.v1', status: 'acknowledged' })); process.exit(0); }",
      "process.stdout.write(JSON.stringify({ schema: 'narada.carrier_materialization_recovery.v1', status: 'recovered', restart_required: true, restart_carrier_ids: ['codex-andrey'] }));",
    ].join('\n'));
    const sourceSessionId = 'carrier_process_source';
    const sourcePaths = resolveNaradaSitePaths({ siteRoot: root, sessionId: sourceSessionId });
    await mkdir(sourcePaths.narsSessionDir!, { recursive: true });
    await writeFile(sourcePaths.narsControlPath!, '', 'utf8');
    const sourceEvent = { event: 'session_started', session_id: sourceSessionId, carrier_session_id: sourceSessionId, agent_id: 'test-site.resident', site_id: 'test-site', site_root: root, runtime: 'narada-agent-runtime-server', operator_surface_kind: 'agent-web-ui', materialized_carrier_id: 'codex-andrey' };
    await appendFile(sourcePaths.narsEventsPath!, JSON.stringify(sourceEvent) + '\n', 'utf8');
    writeNarsSessionStartedIndex({ sessionStartedEvent: sourceEvent, sessionPath: sourcePaths.narsSessionPath, siteRoot: root });
    const fixturePath = join(root, 'disposable-carrier.mjs');
    await writeFile(fixturePath, [
      "import http from 'node:http'; import { appendFileSync, writeFileSync } from 'node:fs';",
      "const [eventsPath, heartbeatPath, sessionId] = process.argv.slice(2);",
      "const server = http.createServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'healthy', lifecycle_state: 'ready', mcp_operational_state: 'healthy' })); });",
      "server.listen(0, '127.0.0.1', () => { const port = server.address().port; appendFileSync(eventsPath, JSON.stringify({ event: 'session_started', session_id: sessionId, health_endpoint: 'http://127.0.0.1:' + port + '/health' }) + '\\n'); writeFileSync(heartbeatPath, JSON.stringify({ last_written_at: new Date().toISOString() })); });",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join('\n'));
    let target: ReturnType<typeof spawn> | null = null;
    let sourceClosed = false;
    try {
      const response = await carrierRecoverCommand({
        mcpWorkspaceRoot: mcp, carrierId: 'codex-andrey', lifecycleAdapter: 'nars-successor-v1',
        siteRoot: root, pcSiteRoot: root, siteId: 'test-site', carrierSessionId: sourceSessionId,
        operationId: 'process-e2e', requestedBy: 'operator',
        expectedStateJson: JSON.stringify({ manifest_digest: null, observation_digest: 'd'.repeat(64), descriptor_digest: null }),
        reason: 'real disposable process proof', timeoutMs: 15_000, mutatingAuthorized: 'carrier.restart', format: 'json',
      }, context, {
        restartSupervisor: {
          launch: async (spec) => {
            const paths = resolveNaradaSitePaths({ siteRoot: root, sessionId: spec.sessionId });
            await mkdir(paths.narsSessionDir!, { recursive: true });
            target = spawn(process.execPath, [fixturePath, paths.narsEventsPath!, paths.narsHeartbeatPath!, spec.sessionId], { stdio: 'ignore', windowsHide: true });
            return { ok: true, exit_code: 0, signal: null, stdout: '', stderr: '' };
          },
          sleep: async () => {
            if (!sourceClosed) {
              sourceClosed = true;
              await appendFile(sourcePaths.narsEventsPath!, JSON.stringify({ event: 'session_closed' }) + '\n', 'utf8');
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          },
        },
      });
      expect(response.exitCode, JSON.stringify(response.result)).toBe(ExitCode.SUCCESS);
      expect((response.result as any).restart_acknowledgement.status).toBe('acknowledged');
      expect(target?.exitCode).toBeNull();
    } finally {
      target?.kill();
    }
  }, 30_000);
  it('plans recovery and governed successor activation as one operation', async () => {
    const root = await temporaryRoot('narada-carrier-recover-');
    const mcp = join(root, 'mcp-surfaces');
    await mkdir(join(mcp, 'scripts'), { recursive: true });
    await writeFile(join(mcp, 'scripts', 'recover-carrier-materialization.mjs'), 'process.exit(0);\n');
    const response = await carrierRecoverCommand({
      mcpWorkspaceRoot: mcp,
      carrierId: 'codex-andrey',
      lifecycleAdapter: 'nars-successor-v1',
      siteRoot: root,
      pcSiteRoot: root,
      siteId: 'test-site',
      carrierSessionId: 'carrier-source',
      operationId: 'recover-plan-1',
      requestedBy: 'operator',
      expectedStateJson: JSON.stringify({ manifest_digest: null, observation_digest: 'a'.repeat(64), descriptor_digest: null }),
      reason: 'test coherent recovery plan',
      dryRun: true,
      format: 'json',
    }, context, { verifyBinding: () => ({ session_id: 'carrier-source', materialized_carrier_id: 'codex-andrey' }) });
    expect(response.exitCode).toBe(ExitCode.SUCCESS);
    const result = response.result as { status: string; recovery: { status: string }; restart: { status: string } };
    expect(result.status).toBe('planned');
    expect(result.recovery.status).toBe('planned');
    expect(result.restart.status).toBe('planned');
  });
});
