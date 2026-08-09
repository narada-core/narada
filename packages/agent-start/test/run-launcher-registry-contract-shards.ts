import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessTestMain, type ProcessTestCommand } from './helpers/process-test-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const testFile = 'test/launcher-registry-contract.test.ts';
const source = readFileSync(resolve(packageRoot, testFile), 'utf8');
const testNames = [...source.matchAll(/^test\('([^']+)'/gm)]
  .map((match) => match[1])
  .filter((name): name is string => name !== undefined);

if (testNames.length === 0) {
  throw new Error('No launcher-registry tests found to shard.');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const commands: ProcessTestCommand[] = testNames.map((name, index) => ({
  label: `launcher-registry:${index + 1}`,
  args: [
    '--import',
    'tsx',
    '--test',
    '--test-name-pattern',
    `^${escapeRegExp(name)}$`,
    testFile,
  ],
  cwd: packageRoot,
  timeoutMs: 45_000,
}));

await runProcessTestMain(commands, { maxConcurrency: 2 });
