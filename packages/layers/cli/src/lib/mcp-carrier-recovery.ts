import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileGoverned } from '@narada-core/process-launch-posture';
export type McpWorkspaceDiscovery = {
  root: string;
  source: 'cli_option' | 'environment' | 'carrier_generation' | 'source_root' | 'user_source_root' | 'source_sibling';
};

export function isMcpRecoveryWorkspace(root: string): boolean {
  return existsSync(join(root, 'scripts', 'recover-carrier-materialization.mjs'))
    && existsSync(join(root, 'packages', 'mcp-registrar', 'package.json'));
}

function carrierGenerationWorkspace(): string | null {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const sidecarPath = join(codexHome, 'config.toml.narada-generation.json');
  if (!existsSync(sidecarPath)) return null;
  try {
    const generation = JSON.parse(readFileSync(sidecarPath, 'utf8')) as { artifact_manifest_path?: unknown };
    if (typeof generation.artifact_manifest_path !== 'string' || !generation.artifact_manifest_path.trim()) return null;
    return resolve(dirname(dirname(dirname(generation.artifact_manifest_path))));
  } catch {
    return null;
  }
}

export function discoverMcpRecoveryWorkspace(configuredRoot: string | undefined): McpWorkspaceDiscovery | null {
  const declared = [
    { value: configuredRoot, source: 'cli_option' as const },
    { value: process.env.NARADA_MCP_WORKSPACE_ROOT, source: 'environment' as const },
  ];
  for (const candidate of declared) {
    if (candidate.value?.trim()) return { root: resolve(candidate.value), source: candidate.source };
  }
  if (process.env.NARADA_MCP_AUTO_DISCOVERY === '0') return null;
  const generatedWorkspace = carrierGenerationWorkspace();
  const inferred = [
    ...(process.env.NARADA_SRC_ROOT?.trim()
      ? [{ root: resolve(process.env.NARADA_SRC_ROOT, 'mcp-surfaces'), source: 'source_root' as const }]
      : []),
    ...(generatedWorkspace
      ? [{ root: generatedWorkspace, source: 'carrier_generation' as const }]
      : []),
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
    const { stdout } = await execFileGoverned(process.execPath, [recoveryEntrypoint], {
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
