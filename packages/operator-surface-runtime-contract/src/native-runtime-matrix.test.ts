import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntimeImplementationMatrixContract } from './operator-surface-runtime-contract.js';
import { runtimeProfileImplementationMatrix } from './runtime-profile-selection.js';
import { resolveRuntimeMaterializationPlan } from './runtime-materialization-plan.js';

const NATIVE_SURFACES = [
  'structured-command-mcp',
  'git-mcp',
  'site-inbox-mcp',
  'mailbox-mcp',
  'graph-mail-mcp',
  'calendar-mcp',
  'site-loop-mcp',
  'site-lifecycle-mcp',
  'site-registry-mcp',
  'worker-delegation-mcp',
  'delegated-task-mcp',
  'sop-mcp',
  'scheduler-mcp',
  'surface-feedback-mcp',
  'launcher-mcp',
  'speech-mcp',
  'operator-routing-mcp',
  'artifacts-mcp',
  'nars-session-mcp',
  'quota-meter-mcp',
  'operator-console-overlay-mcp',
  'browser-control-mcp',
  'cloudflare-carrier-mcp',
  'site-coherence-mcp',
  'catalog-observation-mcp',
  'runtime-introspection-mcp',
  'project-state-mcp',
] as const;

test('native profile admits the complete requested Rust MCP surface batch', () => {
  const entries = runtimeProfileImplementationMatrix('native');
  for (const componentKind of NATIVE_SURFACES) {
    const entry = entries.find((candidate: any) => candidate.component_kind === componentKind);
    assert.equal(entry?.runtime_engine_kind, 'rust', componentKind);
    assert.equal(entry?.implementation_status, 'admitted', componentKind);
  }
});

test('all admitted profiles preserve explicit Bun and Node alternatives for the Rust default batch', () => {
  for (const profile of ['native', 'bun', 'node-compat'] as const) {
    const plan = resolveRuntimeMaterializationPlan(profile);
    for (const componentKind of NATIVE_SURFACES) {
      assert.equal(plan.entries.find((entry: any) => entry.component_kind === componentKind)?.runtime_engine_kind, profile === 'native' ? 'rust' : profile === 'bun' ? 'bun' : 'node');
    }
  }
});

test('native profile keeps only non-requested Rust rows on Bun until parity is proven', () => {
  const matrix = loadRuntimeImplementationMatrixContract();
  const nativeEntries = runtimeProfileImplementationMatrix('native');
  for (const row of matrix.rows ?? []) {
    const rustStatus = row.implementations?.rust?.status;
    if (rustStatus === 'admitted') continue;
    const nativeEntry = nativeEntries.find((entry: any) => entry.component_kind === row.component_kind);
    assert.equal(nativeEntry?.runtime_engine_kind, 'bun', `${row.component_kind}:native default`);
    assert.equal(nativeEntry?.implementation_status, 'admitted', `${row.component_kind}:Bun fallback`);
  }
});
