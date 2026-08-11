import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { naradaUiComponentRegistry, NARADA_UI_COMPONENT_REGISTRY_VERSION } from '../src/component-registry';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('component registry is unique, classified, and names every supported public component', () => {
  assert.equal(NARADA_UI_COMPONENT_REGISTRY_VERSION, 1);
  const ids = naradaUiComponentRegistry.map((family) => family.id);
  assert.equal(new Set(ids).size, ids.length);
  const exports = naradaUiComponentRegistry.flatMap((family) => family.exports);
  assert.equal(new Set(exports).size, exports.length);
  assert.ok(exports.includes('Button'));
  assert.ok(exports.includes('Select'));
  for (const family of naradaUiComponentRegistry) {
    assert.ok(family.accessibility.length > 0);
    assert.equal(family.styles, '@narada-core/ui-vue/components.css');
  }
});

test('lightweight primitives have explicit consumer subpath exports', async () => {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));

  assert.equal(manifest.exports['./button'], './src/components/button/index.ts');
  assert.equal(manifest.exports['./select'], './src/components/select/index.ts');
});
