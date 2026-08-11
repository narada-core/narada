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
  return existsSync(join(root, 'scripts', 'recover-carrier-materialization.mjs'))
    && existsSync(join(root, 'packages', 'mcp-registrar', 'package.json'));
}

export interface McpCarrierGenerationDiscoveryOptions {
  homeDirectory?: string;
  codexHome?: string;
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
  const candidates = [
    {
      carrier_id: 'codex-andrey' as const,
      sidecar_path: join(codexHome, 'config.toml.narada-generation.json'),
    },
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
export function resolveMcpRecoveryRuntimeExecutable(): string {
  const candidates = [
    process.env.NARADA_NODE_EXECUTABLE?.trim(),
    process.execPath,
    process.platform === 'win32' && process.env.FNM_DIR?.trim()
      ? join(process.env.FNM_DIR, 'node-versions', 'v' + process.versions.node, 'installation', 'node.exe')
      : undefined,
    process.platform === 'win32' && process.env.APPDATA?.trim()
      ? join(process.env.APPDATA, 'fnm', 'node-versions', 'v' + process.versions.node, 'installation', 'node.exe')
      : undefined,
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? 'node';
}
export async function recoverMcpCarrierMaterialization(
  configuredRoot: string | undefined,
  projectSiteRoot: string | undefined,
  execute: boolean,
): Promise<Record<string, unknown>> {
  const discovery = discoverMcpRecoveryWorkspace(configuredRoot);
  if (!discovery) return { status: 'not_available', mutation_performed: false, workspace_discovery: { status: 'not_found' } };
  const mcpWorkspaceRoot = discovery.root;
  const recoveryEntrypoint = join(mcpWorkspaceRoot, 'scripts', 'recover-carrier-materialization.mjs');
  if (!existsSync(recoveryEntrypoint)) {
    throw new Error('mcp_recovery_entrypoint_missing:' + recoveryEntrypoint);
  }
  if (!execute) {
    return { status: 'planned', mutation_performed: false, mcp_workspace_root: mcpWorkspaceRoot, recovery_entrypoint: recoveryEntrypoint, workspace_discovery: { status: 'found', source: discovery.source } };
  }
  try {
    const runtimeExecutable = resolveMcpRecoveryRuntimeExecutable();
    const { stdout } = await execFileGoverned(runtimeExecutable, [recoveryEntrypoint], {
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
    if (result.schema !== 'narada.carrier_materialization_recovery.v1'
      || (result.status !== 'current' && result.status !== 'recovered')) {
      throw new Error('mcp_recovery_invalid_result:' + String(stdout).slice(-2000));
    }
    return { ...result, workspace_discovery: { status: 'found', source: discovery.source } };
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr.slice(-4000)
      : '';
    throw new Error('mcp_recovery_failed:' + (error instanceof Error ? error.message : String(error)) + ':' + stderr);
  }
}
