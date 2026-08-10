import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntimeImplementationMatrixContract } from './operator-surface-runtime-contract.js';
import { runtimeProfileImplementationMatrix } from './runtime-profile-selection.js';
import { resolveRuntimeMaterializationPlan } from './runtime-materialization-plan.js';

const NATIVE_SURFACES = ['site-lifecycle-mcp', 'site-registry-mcp', 'project-state-mcp', 'runtime-introspection-mcp', 'site-coherence-mcp', 'launcher-mcp', 'calendar-mcp'] as const;

test('native profile admits the Rust native surface batch', () => {
  const entries = runtimeProfileImplementationMatrix('native');
  for (const componentKind of NATIVE_SURFACES) {
    const entry = entries.find((candidate: any) => candidate.component_kind === componentKind);
    assert.equal(entry?.runtime_engine_kind, 'rust', componentKind);
    assert.equal(entry?.implementation_status, 'admitted', componentKind);
  }
});

test('all admitted profiles preserve explicit alternatives for the Rust native surface batch', () => {
  for (const profile of ['native', 'bun', 'node-compat'] as const) {
    const plan = resolveRuntimeMaterializationPlan(profile);
    for (const componentKind of NATIVE_SURFACES) {
      assert.equal(plan.entries.find((entry: any) => entry.component_kind === componentKind)?.runtime_engine_kind, profile === 'native' ? 'rust' : profile === 'bun' ? 'bun' : 'node');
    }
  }
});

test('native profile keeps non-admitted Rust rows on Bun until parity is proven', () => {
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
