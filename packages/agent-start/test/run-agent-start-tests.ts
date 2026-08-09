import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessTestMain, type ProcessTestCommand } from './helpers/process-test-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');

const commands: ProcessTestCommand[] = [
  {
    label: 'bounded-process-test-runner',
    args: ['--import', 'tsx', '--test', 'test/process-test-runner.test.ts'],
    cwd: packageRoot,
  },
  {
    label: 'result-contract-generated-artifacts',
    args: ['--import', 'tsx', 'scripts/generate-result-schema.ts', '--check'],
    cwd: packageRoot,
    timeoutMs: 30_000,
  },
  {
    label: 'result-contract-generator-line-endings',
    args: ['--import', 'tsx', '--test', 'test/generate-result-schema.test.ts'],
    cwd: packageRoot,
    timeoutMs: 30_000,
  },
  {
    label: 'agent-start-tsx-transform-syntax',
    args: ['--import', 'tsx', '--check', 'src/narada-agent-start.ts'],
    cwd: packageRoot,
    timeoutMs: 30_000,
  },
  {
    label: 'verify-launcher-bin-syntax',
    args: ['--import', 'tsx', '--check', 'bin/verify-registered-site-launchers.ts'],
    cwd: packageRoot,
    timeoutMs: 30_000,
  },
  {
    label: 'agent-start-dry-run-smoke',
    args: ['--import', 'tsx', '--test', 'test/agent-start-dry-run-smoke.test.ts'],
    cwd: packageRoot,
    timeoutMs: 30_000,
  },
  {
    label: 'provider-module-contract',
    args: ['--import', 'tsx', '--test', 'test/provider-module-contract.test.ts'],
    cwd: packageRoot,
    timeoutMs: 30_000,
  },
  {
    label: 'carrier-process-launch-contract',
    args: ['--import', 'tsx', '--test', 'test/carrier-process-launch.test.ts'],
    cwd: packageRoot,
    timeoutMs: 30_000,
  },
  {
    label: 'orientation-admission-contract',
    args: ['--import', 'tsx', '--test', 'test/orientation-admission.test.ts'],
    cwd: packageRoot,
    timeoutMs: 30_000,
  },
  {
    label: 'launch-result-contract',
    args: ['--import', 'tsx', '--test', 'test/launch-result-contract.test.ts'],
    cwd: packageRoot,
    timeoutMs: 30_000,
  },
  {
    label: 'launcher-registry-contract-shards',
    args: ['--import', 'tsx', 'test/run-launcher-registry-contract-shards.ts'],
    cwd: packageRoot,
    // This parent command contains its own bounded two-worker scheduler.
    timeoutMs: 120_000,
  },
  {
    label: 'option-contract-shards',
    args: ['--import', 'tsx', 'test/run-option-contract-shards.ts'],
    cwd: packageRoot,
    // This parent command contains its own bounded two-worker scheduler.
    timeoutMs: 120_000,
  },
];

await runProcessTestMain(commands, { maxConcurrency: 2 });
