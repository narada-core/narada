import {
  requestCarrierRestart,
  showCarrierRestartOutcome,
  type CarrierRestartSupervisorDependencies,
} from '@narada-core/site-common-tools/operator-surface/carrier-restart-supervisor';
import type { CommandContext } from '../lib/command-wrapper.js';
import { formattedResult, type CliFormat } from '../lib/cli-output.js';
import { ExitCode } from '../lib/exit-codes.js';
import { acknowledgeMcpCarrierRestart, recoverMcpCarrierMaterialization } from '../lib/mcp-carrier-recovery.js';
import { assertMcpCarrierSessionBinding, resolveMcpCarrierLifecycleAdapter } from '../lib/mcp-carrier-lifecycle-adapter.js';

export interface CarrierRestartAcknowledgementOptions {
  mcpWorkspaceRoot?: string;
  carrierId?: string;
  expectedPressureRef?: string;
  format?: CliFormat;
}

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
  lifecycleAdapter?: string;
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
    restartSupervisor?: CarrierRestartSupervisorDependencies;
    verifyBinding?: typeof assertMcpCarrierSessionBinding;
    acknowledgeRestart?: typeof acknowledgeMcpCarrierRestart;
  } = {},
): Promise<{ exitCode: ExitCode; result: unknown }> {
  const recover = dependencies.recover ?? recoverMcpCarrierMaterialization;
  const carrierId = requireOption(options.carrierId, '--carrier-id');
  const lifecycleAdapter = resolveMcpCarrierLifecycleAdapter(options.lifecycleAdapter, carrierId);
  const carrierSessionId = requireOption(options.carrierSessionId, '--carrier-session-id');
  const sessionBinding = (dependencies.verifyBinding ?? assertMcpCarrierSessionBinding)(options.siteRoot ?? process.cwd(), carrierSessionId, carrierId);
  const restartCarrier = (restartOptions: CarrierRestartOptions) => dependencies.restart
    ? dependencies.restart(restartOptions, context)
    : carrierRestartCommand(restartOptions, context, { supervisor: dependencies.restartSupervisor });
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
      lifecycle_adapter: lifecycleAdapter,
      recovery,
      restart: null,
    };
    return { exitCode: ExitCode.INVALID_CONFIG, result: formattedResult(result, 'MCP recovery workspace unavailable.', options.format ?? 'auto') };
  }
  if (options.dryRun === true) {
    const restart = await restartCarrier({ ...options, dryRun: true });
    const result = {
      schema: 'narada.carrier.recover_and_relaunch.v1',
      status: 'planned',
      mutation_performed: false,
      carrier_id: carrierId,
      lifecycle_adapter: lifecycleAdapter,
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
      lifecycle_adapter: lifecycleAdapter,
      recovery,
      restart_decision: decision,
      restart: null,
    };
    return { exitCode: ExitCode.SUCCESS, result: formattedResult(result, 'Carrier materialization recovered; selected carrier restart not required.', options.format ?? 'auto') };
  }
  const carrierPressure = recovery.restart_pressure && typeof recovery.restart_pressure === 'object'
    ? (recovery.restart_pressure as Record<string, unknown>)[carrierId]
    : null;
  const pressureRef = carrierPressure && typeof carrierPressure === 'object' && typeof (carrierPressure as Record<string, unknown>).evidence_ref === 'string'
    ? String((carrierPressure as Record<string, unknown>).evidence_ref).trim()
    : '';
  if (!pressureRef) {
    const result = {
      schema: 'narada.carrier.recover_and_relaunch.v1',
      status: 'restart_pressure_evidence_missing',
      mutation_performed: recovery.status === 'recovered',
      carrier_id: carrierId,
      lifecycle_adapter: lifecycleAdapter,
      session_binding: sessionBinding,
      recovery,
      restart_decision: { ...decision, outstanding_carrier_ids: decision.affected_carrier_ids },
      restart_acknowledgement: null,
      restart: null,
    };
    return { exitCode: ExitCode.INVALID_CONFIG, result: formattedResult(result, 'Carrier materialization recovered, but restart was refused because exact pressure evidence is missing.', options.format ?? 'auto') };
  }
  const restart = await restartCarrier(options);
  const restartDecision = restart.exitCode === ExitCode.SUCCESS
    ? decision
    : { ...decision, outstanding_carrier_ids: decision.affected_carrier_ids };
  let restartAcknowledgement: Record<string, unknown> | null = null;
  if (restart.exitCode === ExitCode.SUCCESS) {
    try {
      restartAcknowledgement = await (dependencies.acknowledgeRestart ?? acknowledgeMcpCarrierRestart)(options.mcpWorkspaceRoot, carrierId, pressureRef);
    } catch (error) {
      const retry = {
        action: 'carrier acknowledge-restart',
        carrier_id: carrierId,
        expected_pressure_ref: pressureRef,
        mcp_workspace_root: options.mcpWorkspaceRoot ?? null,
      };
      const result = {
        schema: 'narada.carrier.recover_and_relaunch.v1',
        status: 'restart_completed_acknowledgement_pending',
        mutation_performed: true,
        carrier_id: carrierId,
        lifecycle_adapter: lifecycleAdapter,
        session_binding: sessionBinding,
        recovery,
        restart_decision: { ...decision, outstanding_carrier_ids: decision.affected_carrier_ids },
        restart_acknowledgement: {
          status: 'pending',
          pressure_ref: pressureRef,
          error: error instanceof Error ? error.message : String(error),
          retry,
        },
        restart: restart.result,
      };
      return { exitCode: ExitCode.INVALID_CONFIG, result: formattedResult(result, 'Carrier restarted successfully; durable pressure acknowledgement remains pending and can be retried without another restart.', options.format ?? 'auto') };
    }
  }
  const result = {
    schema: 'narada.carrier.recover_and_relaunch.v1',
    status: restart.exitCode === ExitCode.SUCCESS ? 'completed' : 'restart_failed',
    mutation_performed: recovery.status === 'recovered' || restart.exitCode === ExitCode.SUCCESS,
    carrier_id: carrierId,
    lifecycle_adapter: lifecycleAdapter,
    session_binding: sessionBinding,
    recovery,
    restart_decision: restartDecision,
    restart_acknowledgement: restartAcknowledgement,
    restart: restart.result,
  };
  return {
    exitCode: restart.exitCode,
    result: formattedResult(result, restart.exitCode === ExitCode.SUCCESS
      ? 'Carrier materialization recovered and governed successor activated.'
      : 'Carrier materialization recovered but governed relaunch failed.', options.format ?? 'auto'),
  };
}
export async function carrierRestartAcknowledgementCommand(
  options: CarrierRestartAcknowledgementOptions,
  _context: CommandContext,
  dependencies: { acknowledgeRestart?: typeof acknowledgeMcpCarrierRestart } = {},
): Promise<{ exitCode: ExitCode; result: unknown }> {
  const carrierId = requireOption(options.carrierId, '--carrier-id');
  const expectedPressureRef = requireOption(options.expectedPressureRef, '--expected-pressure-ref');
  const acknowledgement = await (dependencies.acknowledgeRestart ?? acknowledgeMcpCarrierRestart)(
    options.mcpWorkspaceRoot,
    carrierId,
    expectedPressureRef,
  );
  const result = {
    schema: 'narada.carrier.restart_acknowledgement_reconcile.v1',
    status: 'reconciled',
    mutation_performed: true,
    carrier_id: carrierId,
    expected_pressure_ref: expectedPressureRef,
    acknowledgement,
  };
  return { exitCode: ExitCode.SUCCESS, result: formattedResult(result, 'Carrier restart pressure acknowledgement reconciled.', options.format ?? 'auto') };
}

export async function carrierRestartCommand(
  options: CarrierRestartOptions,
  _context: CommandContext,
  dependencies: { supervisor?: CarrierRestartSupervisorDependencies } = {},
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
    ...dependencies.supervisor,
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