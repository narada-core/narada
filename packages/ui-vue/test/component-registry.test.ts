import assert from 'node:assert/strict';
import { test } from 'node:test';
import { naradaUiComponentRegistry, NARADA_UI_COMPONENT_REGISTRY_VERSION } from '../src/component-registry';

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
