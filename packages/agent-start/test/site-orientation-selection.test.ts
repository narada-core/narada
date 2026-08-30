import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveSiteOrientationSelection } from '../src/launcher-cli-contract.js';

test('site orientation is disabled by default even for a materializing launch', () => {
  const args: any = parseArgs(['narada.architect', '--exec']);
  assert.deepEqual(resolveSiteOrientationSelection(args, true), {
    requested: false,
    required: false,
  });
});

test('site orientation requires the explicit flag and a materializing launch', () => {
  const args: any = parseArgs(['narada.architect', '--exec', '--site-orientation']);
  assert.deepEqual(resolveSiteOrientationSelection(args, true), {
    requested: true,
    required: true,
  });
  assert.deepEqual(resolveSiteOrientationSelection(args, false), {
    requested: true,
    required: false,
  });
});

test('orientation selectors cannot silently activate or imply orientation', () => {
  const args: any = parseArgs(['narada.architect', '--continuity-checkpoint-id', 'checkpoint:1']);
  assert.throws(
    () => resolveSiteOrientationSelection(args, true),
    /site_orientation_required_for_orientation_selection/,
  );
});
