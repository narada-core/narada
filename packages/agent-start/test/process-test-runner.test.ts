import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProcessTestRunError,
  runProcessTests,
  type ProcessTestCommand,
  type ProcessTestResult,
} from './helpers/process-test-runner.js';

function command(label: string): ProcessTestCommand {
  return { label, args: [] };
}

function successfulResult(label: string): ProcessTestResult {
  return {
    label,
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    stdout: '',
    stderr: '',
  };
}

test('runProcessTests admits no more than the configured number of children', async () => {
  let active = 0;
  let maximumActive = 0;
  const started: string[] = [];
  const release: Array<() => void> = [];

  const execution = runProcessTests(
    ['one', 'two', 'three', 'four'].map(command),
    {
      maxConcurrency: 2,
      logger: null,
      execute: async ({ label }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started.push(label);
        await new Promise<void>((resolve) => release.push(resolve));
        active -= 1;
        return successfulResult(label);
      },
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['one', 'two']);

  release.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['one', 'two', 'three']);

  while (release.length > 0) release.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  while (release.length > 0) release.shift()?.();

  const results = await execution;
  assert.equal(maximumActive, 2);
  assert.deepEqual(results.map((result) => result.label), ['one', 'two', 'three', 'four']);
});

test('runProcessTests rejects with the complete governed failure record', async () => {
  const failed: ProcessTestResult = {
    ...successfulResult('failed'),
    exitCode: 7,
    stderr: 'fixture failure',
  };

  await assert.rejects(
    runProcessTests([command('passed'), command('failed')], {
      maxConcurrency: 1,
      logger: null,
      execute: async ({ label }) => label === 'failed' ? failed : successfulResult(label),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProcessTestRunError);
      assert.equal(error.results.length, 2);
      assert.deepEqual(error.failures, [failed]);
      return true;
    },
  );
});
