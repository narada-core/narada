import { existsSync } from 'node:fs';
import { DEFAULT_OPERATOR_ROUTER_PORT } from '@narada-core/operator-router';
import type { CommandContext } from '../lib/command-wrapper.js';
import { formattedResult, type CliFormat } from '../lib/cli-output.js';
import { ExitCode } from '../lib/exit-codes.js';
import { getSchedulerSiteDaemonStatus } from '../lib/launcher-runtime-scheduler.js';

export interface SitesLaunchOptions {
  siteId: string;
  dryRun?: boolean;
  format?: CliFormat;
  verbose?: boolean;
}

type LaunchCheckStatus = 'pass' | 'warn' | 'fail' | 'planned' | 'skipped';

interface SiteLaunchCheck {
  id: string;
  status: LaunchCheckStatus;
  summary: string;
  detail?: string;
  next_command?: string;
}

interface McpFabricValidation {
  status?: string;
  expected_count?: number;
  missing?: unknown[];
  unexpected?: unknown[];
  server_name_mismatches?: unknown[];
}

interface McpFabricModule {
  loadSiteMcpFabric: (
    siteRoot: string,
    options?: { required?: boolean; validateRegistry?: boolean | 'diagnostic' },
  ) => {
    servers?: Record<string, unknown>;
    registry_validation?: McpFabricValidation;
  };
}

/**
 * Report a Site's runtime posture: resolve the Site, report MCP surface
 * materialization drift, inspect scheduler posture, and report the console URL.
 * Scheduler activation and SOP execution are separate authorities; this
 * command is read-only even when --dry-run is omitted.
 *
 * All Site CLI calls use the async exec path so HTTP handlers (console launch
 * route) never block the event loop.
 *
 * Decision: .ai/decisions/20260718-2038-launcher-realignment-single-agent-and-site-level.md
 */
export async function sitesLaunchCommand(
  options: SitesLaunchOptions,
  _context: CommandContext,
): Promise<{ exitCode: ExitCode; result: unknown }> {
  const dryRun = options.dryRun === true;
  const checks: SiteLaunchCheck[] = [];
  const actions: string[] = [];
  const details: Record<string, unknown> = {};
  let mutationObserved = false;

  // 1. Resolve the Site record (id or alias) from the User Site registry.
  const resolution = await resolveSiteRecord(options.siteId);
  if (!resolution.record) {
    checks.push(resolution.error
      ? {
          id: 'site_resolution',
          status: 'fail',
          summary: 'Site registry could not be read',
          detail: resolution.error,
        }
      : {
          id: 'site_resolution',
          status: 'fail',
          summary: `Site not found in the User Site registry: ${options.siteId}`,
          next_command: 'narada sites list',
        });
    return finalize(options, checks, actions, details, null, null, mutationObserved);
  }
  const record = resolution.record;
  const siteRoot = record.siteRoot;
  checks.push({
    id: 'site_resolution',
    status: 'pass',
    summary: `Resolved ${record.siteId} -> ${siteRoot}`,
  });
  if (!existsSync(siteRoot)) {
    checks.push({
      id: 'site_root',
      status: 'fail',
      summary: `Site root does not exist: ${siteRoot}`,
      next_command: `narada sites registry show ${record.siteId}`,
    });
    return finalize(options, checks, actions, details, record, null, mutationObserved);
  }

  // 2. MCP surface materialization drift (read-only).
  const fabricCheck = await checkMcpFabricMaterialization(siteRoot);
  checks.push(fabricCheck.check);
  if (options.verbose && fabricCheck.validation) {
    details.mcp_fabric_validation = fabricCheck.validation;
  }

  // 3. Scheduler posture (read-only; activation remains scheduler-owned).
  const scheduler = getSchedulerSiteDaemonStatus({ siteRoot });
  if (options.verbose) details.scheduler = scheduler;
  const resolvedTaskName = scheduler.task_name ?? 'site daemon task';
  if (scheduler.status === 'ok') {
    checks.push({
      id: 'scheduler_posture',
      status: 'pass',
      summary: `Scheduled task present: ${resolvedTaskName}`,
    });
  } else if (scheduler.status === 'not_found') {
    checks.push({
      id: 'scheduler_posture',
      status: 'warn',
      summary: `Scheduled task not installed: ${resolvedTaskName}`,
      next_command: `narada scheduler site-daemon install --site-root "${siteRoot}" --task-name "${resolvedTaskName}" --execute`,
    });
  } else {
    checks.push({
      id: 'scheduler_posture',
      status: 'warn',
      summary: `Scheduler posture could not be verified (${scheduler.status})`,
      detail: scheduler.error,
    });
  }

  return finalize(options, checks, actions, details, record, mutationObserved);
}

function finalize(
  options: SitesLaunchOptions,
  checks: SiteLaunchCheck[],
  actions: string[],
  details: Record<string, unknown>,
  record: { siteId: string; siteRoot: string } | null,
  mutationObserved: boolean,
): { exitCode: ExitCode; result: unknown } {
  const dryRun = options.dryRun === true;
  const failed = checks.some((check) => check.status === 'fail');
  const warned = checks.some((check) => check.status === 'warn');
  const status = failed ? 'failed' : dryRun ? 'dry_run' : warned ? 'degraded' : 'ok';
  const consolePort = process.env.NARADA_OPERATOR_ROUTER_PORT ?? String(DEFAULT_OPERATOR_ROUTER_PORT);
  // Configured URL only; reachability is not probed by this command.
  const consoleUrl = `http://127.0.0.1:${consolePort}/console/registry`;
  const result: Record<string, unknown> = {
    schema: 'narada.sites.launch.result.v0',
    status,
    dry_run: dryRun,
    mutation_performed: !dryRun && (mutationObserved || (!failed && actions.length > 0)),
    site_id: record?.siteId ?? options.siteId,
    site_root: record?.siteRoot ?? null,
    checks,
    actions,
    console_url: consoleUrl,
  };
  if (options.verbose && Object.keys(details).length > 0) {
    result.details = details;
  }
  const humanLines = [
    `sites launch ${String(result.site_id)}: ${status}`,
    ...checks.map((check) => {
      const suffix = check.next_command ? ` (next: ${check.next_command})` : '';
      return `  [${check.status}] ${check.summary}${suffix}`;
    }),
    `console: ${consoleUrl} (configured; reachability not probed)`,
  ];
  return {
    exitCode: failed ? ExitCode.GENERAL_ERROR : ExitCode.SUCCESS,
    result: formattedResult(result, humanLines, options.format ?? 'auto'),
  };
}

async function resolveSiteRecord(
  reference: string,
): Promise<{ record: { siteId: string; siteRoot: string } | null; error?: string }> {
  try {
    const { resolveRegistryDbPathByLocus, openRegistryDb, SiteRegistry } = await import('@narada-core/windows-site');
    const dbPath = resolveRegistryDbPathByLocus({ authorityLocus: 'user' });
    const db = await openRegistryDb(dbPath);
    const registry = new SiteRegistry(db);
    try {
      const record = registry.getManagedSite(reference) ?? null;
      if (!record) return { record: null };
      return { record: { siteId: record.siteId, siteRoot: record.siteRoot } };
    } finally {
      registry.close();
    }
  } catch (error) {
    return { record: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkMcpFabricMaterialization(
  siteRoot: string,
): Promise<{ check: SiteLaunchCheck; validation?: McpFabricValidation }> {
  try {
    // Variable specifier keeps the untyped .ts workspace module out of tsc resolution.
    const mcpFabricSpecifier = '@narada-core/mcp-fabric';
    const { loadSiteMcpFabric } = (await import(mcpFabricSpecifier)) as McpFabricModule;
    const fabric = loadSiteMcpFabric(siteRoot, { validateRegistry: 'diagnostic' });
    const validation = fabric.registry_validation;
    const serverCount = Object.keys(fabric.servers ?? {}).length;
    if (!validation || validation.status === 'missing') {
      return {
        check: {
          id: 'mcp_surface_materialization',
          status: 'warn',
          summary: `No bound-surface registry materialization to verify (${serverCount} fabric server(s))`,
        },
        validation,
      };
    }
    if (validation.status === 'ok') {
      return {
        check: {
          id: 'mcp_surface_materialization',
          status: 'pass',
          summary: `MCP surface materialization current (${serverCount} server(s), registry ok)`,
        },
        validation,
      };
    }
    return {
      check: {
        id: 'mcp_surface_materialization',
        status: 'warn',
        summary: `MCP surface materialization drift: ${validation.missing?.length ?? 0} missing, ${validation.unexpected?.length ?? 0} unexpected, ${validation.server_name_mismatches?.length ?? 0} name mismatch(es)`,
        next_command: 'narada mcp fabric doctor',
      },
      validation,
    };
  } catch (error) {
    return {
      check: {
        id: 'mcp_surface_materialization',
        status: 'warn',
        summary: 'MCP surface materialization check could not run',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
