import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { carrierRecoverCommand, carrierRecoveryRestartDecision } from '../../src/commands/carrier-restart.js';
import type { CommandContext } from '../../src/lib/command-wrapper.js';
import { ExitCode } from '../../src/lib/exit-codes.js';

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
      siteRoot: 'C:/site',
      format: 'json',
    }, context, {
      recover: async () => ({
        schema: 'narada.carrier_materialization_recovery.v1',
        status: 'recovered',
        restart_required: true,
        restart_carrier_ids: ['codex-andrey', 'kimi-andrey'],
      }),
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
  it('plans recovery and governed successor activation as one operation', async () => {
    const root = await temporaryRoot('narada-carrier-recover-');
    const mcp = join(root, 'mcp-surfaces');
    await mkdir(join(mcp, 'scripts'), { recursive: true });
    await writeFile(join(mcp, 'scripts', 'recover-carrier-materialization.mjs'), 'process.exit(0);\n');
    const response = await carrierRecoverCommand({
      mcpWorkspaceRoot: mcp,
      carrierId: 'codex-andrey',
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
    }, context);
    expect(response.exitCode).toBe(ExitCode.SUCCESS);
    const result = response.result as { status: string; recovery: { status: string }; restart: { status: string } };
    expect(result.status).toBe('planned');
    expect(result.recovery.status).toBe('planned');
    expect(result.restart.status).toBe('planned');
  });
});