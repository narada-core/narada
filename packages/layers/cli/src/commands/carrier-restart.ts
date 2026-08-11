import { requestCarrierRestart, showCarrierRestartOutcome } from '@narada-core/site-common-tools/operator-surface/carrier-restart-supervisor';
import type { CommandContext } from '../lib/command-wrapper.js';
import { formattedResult, type CliFormat } from '../lib/cli-output.js';
import { ExitCode } from '../lib/exit-codes.js';
import { recoverMcpCarrierMaterialization } from '../lib/mcp-carrier-recovery.js';

export interface CarrierRestartOptions {
  siteRoot?: string;
  pcSiteRoot?: string;
  siteId?: string;
  carrierSessionId?: string;
  operationId?: string;
  requestedBy?: string;
  expectedStateJson?: string;
  reason?: string;
  timeoutMs?: number;
  dryRun?: boolean;
  mutatingAuthorized?: string;
  mcpWorkspaceRoot?: string;
  carrierId?: string;
  format?: CliFormat;
}

export function carrierRecoveryRestartDecision(
  recovery: Record<string, unknown>,
  carrierId: string,
): {
  restart_required: boolean;
  selected_carrier_affected: boolean;
  affected_carrier_ids: string[];
  outstanding_carrier_ids: string[];
} {
  const affectedCarrierIds = Array.isArray(recovery.restart_carrier_ids)
    ? recovery.restart_carrier_ids.map(String)
    : [];
  const restartRequired = recovery.restart_required === true;
  const selectedCarrierAffected = restartRequired && affectedCarrierIds.includes(carrierId);
  return {
    restart_required: restartRequired,
    selected_carrier_affected: selectedCarrierAffected,
    affected_carrier_ids: affectedCarrierIds,
    outstanding_carrier_ids: affectedCarrierIds.filter((id) => id !== carrierId),
  };
}
export async function carrierRecoverCommand(
  options: CarrierRestartOptions,
  context: CommandContext,
  dependencies: {
    recover?: typeof recoverMcpCarrierMaterialization;
    restart?: typeof carrierRestartCommand;
  } = {},
): Promise<{ exitCode: ExitCode; result: unknown }> {
  const recover = dependencies.recover ?? recoverMcpCarrierMaterialization;
  const restartCarrier = dependencies.restart ?? carrierRestartCommand;
  const carrierId = requireOption(options.carrierId, '--carrier-id');
  const recovery = await recover(
    options.mcpWorkspaceRoot,
    options.siteRoot,
    options.dryRun !== true,
  );
  if (recovery.status === 'not_available') {
    const result = {
      schema: 'narada.carrier.recover_and_relaunch.v1',
      status: 'recovery_unavailable',
      mutation_performed: false,
      carrier_id: carrierId,
      recovery,
      restart: null,
    };
    return { exitCode: ExitCode.INVALID_CONFIG, result: formattedResult(result, 'MCP recovery workspace unavailable.', options.format ?? 'auto') };
  }
  if (options.dryRun === true) {
    const restart = await restartCarrier({ ...options, dryRun: true }, context);
    const result = {
      schema: 'narada.carrier.recover_and_relaunch.v1',
      status: 'planned',
      mutation_performed: false,
      carrier_id: carrierId,
      recovery,
      restart: restart.result,
    };
    return { exitCode: restart.exitCode, result: formattedResult(result, 'Carrier recovery and governed relaunch planned.', options.format ?? 'auto') };
  }
  const decision = carrierRecoveryRestartDecision(recovery, carrierId);
  if (!decision.selected_carrier_affected) {
    const result = {
      schema: 'narada.carrier.recover_and_relaunch.v1',
      status: decision.restart_required ? 'recovered_restart_not_selected' : 'current',
      mutation_performed: recovery.status === 'recovered',
      carrier_id: carrierId,
      recovery,
      restart_decision: decision,
      restart: null,
    };
    return { exitCode: ExitCode.SUCCESS, result: formattedResult(result, 'Carrier materialization recovered; selected carrier restart not required.', options.format ?? 'auto') };
  }
  const restart = await restartCarrier(options, context);
  const result = {
    schema: 'narada.carrier.recover_and_relaunch.v1',
    status: restart.exitCode === ExitCode.SUCCESS ? 'completed' : 'restart_failed',
    mutation_performed: recovery.status === 'recovered' || restart.exitCode === ExitCode.SUCCESS,
    carrier_id: carrierId,
    recovery,
    restart_decision: decision,
    restart: restart.result,
  };
  return {
    exitCode: restart.exitCode,
    result: formattedResult(result, restart.exitCode === ExitCode.SUCCESS
      ? 'Carrier materialization recovered and governed successor activated.'
      : 'Carrier materialization recovered but governed relaunch failed.', options.format ?? 'auto'),
  };
}
export async function carrierRestartCommand(
  options: CarrierRestartOptions,
  _context: CommandContext,
): Promise<{ exitCode: ExitCode; result: unknown }> {
  const expectedState = parseExpectedState(options.expectedStateJson);
  const outcome = await requestCarrierRestart({
    operation_id: requireOption(options.operationId, '--operation-id'),
    requested_by: requireOption(options.requestedBy, '--requested-by'),
    site_id: requireOption(options.siteId, '--site-id'),
    carrier_session_id: requireOption(options.carrierSessionId, '--carrier-session-id'),
    expected_state: expectedState,
    reason: requireOption(options.reason, '--reason'),
    timeout_ms: options.timeoutMs,
    dry_run: options.dryRun === true,
    mutating_authorized: options.mutatingAuthorized,
  }, {
    siteRoot: options.siteRoot ?? process.cwd(),
    pcSiteRoot: options.pcSiteRoot ?? process.env.NARADA_PC_SITE_ROOT ?? 'C:/ProgramData/Narada/sites/pc/desktop-sunroom-2',
  });
  const success = outcome.status === 'completed' || outcome.status === 'planned';
  return {
    exitCode: success ? ExitCode.SUCCESS : ExitCode.INVALID_CONFIG,
    result: formattedResult(outcome, formatCarrierRestart(outcome), options.format ?? 'auto'),
  };
}

export async function carrierRestartOutcomeCommand(
  operationId: string,
  options: Pick<CarrierRestartOptions, 'pcSiteRoot' | 'format'>,
  _context: CommandContext,
): Promise<{ exitCode: ExitCode; result: unknown }> {
  const outcome = showCarrierRestartOutcome(
    options.pcSiteRoot ?? process.env.NARADA_PC_SITE_ROOT ?? 'C:/ProgramData/Narada/sites/pc/desktop-sunroom-2',
    requireOption(operationId, '<operation-id>'),
  );
  return {
    exitCode: outcome.status === 'completed' ? ExitCode.SUCCESS : ExitCode.INVALID_CONFIG,
    result: formattedResult(outcome, formatCarrierRestart(outcome), options.format ?? 'auto'),
  };
}

function parseExpectedState(value: string | undefined): Record<string, unknown> {
  if (!value) throw new Error('--expected-state-json is required; pass the bounded observation evidence used for the request.');
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--expected-state-json must contain a JSON object.');
  return parsed as Record<string, unknown>;
}

function requireOption(value: string | undefined, option: string): string {
  if (!value || value.trim().length === 0) throw new Error(`${option} is required`);
  return value.trim();
}

function formatCarrierRestart(outcome: Record<string, unknown>): string {
  return [
    `Carrier restart: ${outcome.status ?? 'unknown'}`,
    `  operation: ${outcome.operation_id ?? 'unknown'}`,
    `  source: ${outcome.source_session_id ?? 'unknown'}`,
    `  target: ${outcome.target_session_id ?? 'none'}`,
    `  transition: ${outcome.transition_state ?? 'unknown'}`,
    ...(outcome.error_code ? [`  error: ${outcome.error_code}`] : []),
  ].join('\n');
}
