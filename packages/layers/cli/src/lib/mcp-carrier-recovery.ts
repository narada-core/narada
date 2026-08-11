import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileGoverned } from '@narada-core/process-launch-posture';
export type McpWorkspaceDiscovery = {
  root: string;
  source: 'cli_option' | 'environment' | 'carrier_generation' | 'source_root' | 'user_source_root' | 'source_sibling';
  carrier_ids?: Array<'codex-andrey' | 'kimi-andrey' | 'opencode-andrey'>;
};

export function isMcpRecoveryWorkspace(root: string): boolean {
  return existsSync(join(root, 'packages', 'shared', 'mcp-materializer-native', 'package.json'));
}

type NativeMaterializerRecovery = {
  executable: string;
  generationSidecar: string;
  installedIndex: string;
};

function resolveNativeMaterializerRecovery(
  workspaceRoot: string,
  options: McpCarrierGenerationDiscoveryOptions = {},
): NativeMaterializerRecovery {
  const carrierHome = resolve(options.homeDirectory ?? process.env.NARADA_CARRIER_HOME?.trim() ?? homedir());
  const installedIndex = resolve(options.installedCarrierIndexPath
    ?? process.env.NARADA_INSTALLED_CARRIER_INDEX_PATH?.trim()
    ?? join(carrierHome, '.narada', 'carriers', 'installed-carriers.json'));
  if (!existsSync(installedIndex)) throw new Error('mcp_installed_carrier_index_missing:' + installedIndex);
  const index = JSON.parse(readFileSync(installedIndex, 'utf8')) as { schema?: unknown; carriers?: unknown };
  if (index.schema !== 'narada.installed_carrier_index.v1' || !Array.isArray(index.carriers)) {
    throw new Error('mcp_installed_carrier_index_invalid:' + installedIndex);
  }
  for (const carrier of index.carriers) {
    if (!carrier || typeof carrier !== 'object') continue;
    const sidecar = (carrier as { generation_sidecar_path?: unknown }).generation_sidecar_path;
    if (typeof sidecar !== 'string' || !existsSync(sidecar)) continue;
    const generation = JSON.parse(readFileSync(sidecar, 'utf8')) as {
      schema?: unknown;
      artifact_manifest_path?: unknown;
      registrar_entrypoint?: unknown;
    };
    if (generation.schema !== 'narada.mcp_materialization_generation.v1'
      || typeof generation.artifact_manifest_path !== 'string'
      || typeof generation.registrar_entrypoint !== 'string') continue;
    const generationWorkspace = resolve(dirname(dirname(dirname(generation.artifact_manifest_path))));
    const sameWorkspace = process.platform === 'win32'
      ? generationWorkspace.toLowerCase() === resolve(workspaceRoot).toLowerCase()
      : generationWorkspace === resolve(workspaceRoot);
    if (!sameWorkspace) continue;
    const executable = resolve(generation.registrar_entrypoint);
    if (!existsSync(executable)) throw new Error('mcp_native_materializer_missing:' + executable);
    return { executable, generationSidecar: resolve(sidecar), installedIndex };
  }
  throw new Error('mcp_native_materializer_generation_not_found:' + installedIndex);
}

export interface McpCarrierGenerationDiscoveryOptions {
  homeDirectory?: string;
  codexHome?: string;
  installedCarrierIndexPath?: string;
}

function workspaceFromGenerationSidecar(sidecarPath: string): string | null {
  if (!existsSync(sidecarPath)) return null;
  try {
    const generation = JSON.parse(readFileSync(sidecarPath, 'utf8')) as { artifact_manifest_path?: unknown };
    if (typeof generation.artifact_manifest_path !== 'string' || !generation.artifact_manifest_path.trim()) return null;
    return resolve(dirname(dirname(dirname(generation.artifact_manifest_path))));
  } catch {
    return null;
  }
}

export function carrierGenerationWorkspaces(
  options: McpCarrierGenerationDiscoveryOptions = {},
): McpWorkspaceDiscovery[] {
  const home = resolve(options.homeDirectory ?? process.env.NARADA_CARRIER_HOME?.trim() ?? homedir());
  const codexHome = options.codexHome?.trim()
    || (options.homeDirectory ? join(home, '.codex') : process.env.CODEX_HOME?.trim())
    || join(home, '.codex');
  const indexPath = resolve(options.installedCarrierIndexPath
    ?? process.env.NARADA_INSTALLED_CARRIER_INDEX_PATH?.trim()
    ?? join(home, '.narada', 'carriers', 'installed-carriers.json'));
  const indexedCandidates: Array<{ carrier_id: 'codex-andrey' | 'kimi-andrey' | 'opencode-andrey'; sidecar_path: string }> = [];
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { schema?: unknown; carriers?: unknown };
      if (index.schema !== 'narada.installed_carrier_index.v1' || !Array.isArray(index.carriers)) throw new Error('invalid_schema');
      for (const entry of index.carriers) {
        if (!entry || typeof entry !== 'object') continue;
        const carrierId = (entry as { carrier_id?: unknown }).carrier_id;
        const sidecarPath = (entry as { generation_sidecar_path?: unknown }).generation_sidecar_path;
        if ((carrierId === 'codex-andrey' || carrierId === 'kimi-andrey' || carrierId === 'opencode-andrey')
          && typeof sidecarPath === 'string' && sidecarPath.trim()) {
          indexedCandidates.push({ carrier_id: carrierId, sidecar_path: resolve(sidecarPath) });
        }
      }
    } catch (error) {
      throw new Error('mcp_installed_carrier_index_invalid:' + indexPath + ':' + (error instanceof Error ? error.message : String(error)));
    }
  }
  const candidates = [
    ...indexedCandidates,
    { carrier_id: 'codex-andrey' as const, sidecar_path: join(codexHome, 'config.toml.narada-generation.json') },
    { carrier_id: 'kimi-andrey' as const, sidecar_path: join(home, '.kimi-code', 'mcp.json.narada-generation.json') },
    { carrier_id: 'opencode-andrey' as const, sidecar_path: join(home, '.config', 'opencode', 'opencode.jsonc.narada-generation.json') },
  ];
  return candidates.flatMap((candidate) => {
    const root = workspaceFromGenerationSidecar(candidate.sidecar_path);
    return root ? [{ root, source: 'carrier_generation' as const, carrier_ids: [candidate.carrier_id] }] : [];
  });
}

export function discoverMcpRecoveryWorkspace(
  configuredRoot: string | undefined,
  discoveryOptions: McpCarrierGenerationDiscoveryOptions = {},
): McpWorkspaceDiscovery | null {
  const declared = [
    { value: configuredRoot, source: 'cli_option' as const },
    { value: process.env.NARADA_MCP_WORKSPACE_ROOT, source: 'environment' as const },
  ];
  for (const candidate of declared) {
    if (candidate.value?.trim()) return { root: resolve(candidate.value), source: candidate.source };
  }
  if (process.env.NARADA_MCP_AUTO_DISCOVERY === '0') return null;
  const sourceRootWorkspace = process.env.NARADA_SRC_ROOT?.trim()
    ? resolve(process.env.NARADA_SRC_ROOT, 'mcp-surfaces')
    : null;
  if (sourceRootWorkspace && isMcpRecoveryWorkspace(sourceRootWorkspace)) {
    return { root: sourceRootWorkspace, source: 'source_root' };
  }
  const generatedWorkspaces = carrierGenerationWorkspaces(discoveryOptions);
  const generatedByRoot = new Map<string, McpWorkspaceDiscovery>();
  for (const generated of generatedWorkspaces) {
    const key = process.platform === 'win32' ? generated.root.toLowerCase() : generated.root;
    const existing = generatedByRoot.get(key);
    if (existing) existing.carrier_ids = [...(existing.carrier_ids ?? []), ...(generated.carrier_ids ?? [])];
    else generatedByRoot.set(key, { ...generated });
  }
  if (generatedByRoot.size > 1) {
    throw new Error('mcp_carrier_generation_workspace_conflict:' + JSON.stringify([...generatedByRoot.values()]));
  }
  const generatedWorkspace = [...generatedByRoot.values()][0];
  const inferred = [
    ...(generatedWorkspace ? [generatedWorkspace] : []),
    { root: resolve(homedir(), 'src', 'mcp-surfaces'), source: 'user_source_root' as const },
    {
      root: resolve(fileURLToPath(new URL('../../../../../../mcp-surfaces', import.meta.url))),
      source: 'source_sibling' as const,
    },
  ];
  const seen = new Set<string>();
  for (const candidate of inferred) {
    const key = process.platform === 'win32' ? candidate.root.toLowerCase() : candidate.root;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isMcpRecoveryWorkspace(candidate.root)) return candidate;
  }
  return null;
}
export async function acknowledgeMcpCarrierRestart(
  configuredRoot: string | undefined,
  carrierId: string,
  expectedPressureRef?: string,
): Promise<Record<string, unknown>> {
  const discovery = discoverMcpRecoveryWorkspace(configuredRoot);
  if (!discovery) throw new Error('mcp_recovery_workspace_not_found_for_restart_ack');
  if (!expectedPressureRef?.trim()) throw new Error('mcp_restart_ack_expected_pressure_ref_required');
  const native = resolveNativeMaterializerRecovery(discovery.root);
  const args = [
    'acknowledge-restart',
    '--installed-index', native.installedIndex,
    '--carrier-id', carrierId,
    '--expected-evidence-ref', expectedPressureRef,
  ];
  const { stdout } = await execFileGoverned(native.executable, args, {
    cwd: discovery.root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, NARADA_MCP_WORKSPACE_ROOT: discovery.root },
  });
  const result = JSON.parse(String(stdout)) as Record<string, unknown>;
  if (result.schema !== 'narada.carrier_restart_acknowledgement.v1') {
    throw new Error('mcp_restart_ack_invalid_result:' + String(stdout).slice(-2000));
  }
  return result;
}
export async function recoverMcpCarrierMaterialization(
  configuredRoot: string | undefined,
  projectSiteRoot: string | undefined,
  execute: boolean,
): Promise<Record<string, unknown>> {
  const discovery = discoverMcpRecoveryWorkspace(configuredRoot);
  if (!discovery) return { status: 'not_available', mutation_performed: false, workspace_discovery: { status: 'not_found' } };
  const mcpWorkspaceRoot = discovery.root;
  const native = resolveNativeMaterializerRecovery(mcpWorkspaceRoot);
  if (!execute) {
    return {
      status: 'planned',
      mutation_performed: false,
      mcp_workspace_root: mcpWorkspaceRoot,
      recovery_entrypoint: native.executable,
      recovery_args: ['recover-generation', '--generation', native.generationSidecar],
      workspace_discovery: { status: 'found', source: discovery.source },
    };
  }
  try {
    try {
      const { stdout } = await execFileGoverned(native.executable, ['verify-all', '--installed-index', native.installedIndex], {
        cwd: mcpWorkspaceRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
        env: process.env,
      });
      const verification = JSON.parse(String(stdout)) as Record<string, unknown>;
      if (verification.schema === 'narada.mcp_materializer.verification.v1' && verification.status === 'current') {
        return {
          schema: 'narada.carrier_materialization_recovery.v1',
          status: 'current',
          mutation_performed: false,
          restart_required: false,
          restart_carrier_ids: [],
          native_verification: verification,
          workspace_discovery: { status: 'found', source: discovery.source },
        };
      }
    } catch {
      // Verification failure is the reason to invoke the native recovery authority.
    }
    const { stdout } = await execFileGoverned(native.executable, ['recover-generation', '--generation', native.generationSidecar], {
      cwd: mcpWorkspaceRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 600_000,
      env: {
        ...process.env,
        NARADA_MCP_WORKSPACE_ROOT: mcpWorkspaceRoot,
        ...(projectSiteRoot ? { NARADA_PROJECT_SITE_ROOT: projectSiteRoot } : {}),
      },
    });
    const result = JSON.parse(String(stdout)) as Record<string, unknown>;
    if (result.schema !== 'narada.mcp_materializer.recovery_evidence.v1' || result.status !== 'recovered') {
      throw new Error('mcp_recovery_invalid_result:' + String(stdout).slice(-2000));
    }
    const verification = result.verification as { verified_carrier_ids?: unknown } | undefined;
    const carrierIds = Array.isArray(verification?.verified_carrier_ids)
      ? verification.verified_carrier_ids.map(String)
      : [];
    return {
      schema: 'narada.carrier_materialization_recovery.v1',
      status: 'recovered',
      mutation_performed: true,
      carrier_materialization_required: true,
      all_carrier_materialization_performed: true,
      restart_required: true,
      restart_carrier_ids: carrierIds,
      restart_pressure: result.restart_pressure,
      restart_pressure_path: result.restart_pressure_path,
      native_recovery_evidence: result,
      workspace_discovery: { status: 'found', source: discovery.source },
    };
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr.slice(-4000)
      : '';
    throw new Error('mcp_recovery_failed:' + (error instanceof Error ? error.message : String(error)) + ':' + stderr);
  }
}
