import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessTestMain, type ProcessTestCommand } from './helpers/process-test-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const testFile = 'test/option-contract.test.ts';
const source = readFileSync(resolve(packageRoot, testFile), 'utf8');
const testNames = [...source.matchAll(/^test\('([^']+)'/gm)]
  .map((match) => match[1])
  .filter((name): name is string => name !== undefined);

if (testNames.length === 0) {
  throw new Error('No option-contract tests found to shard.');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shard<T>(values: readonly T[], shardCount: number): T[][] {
  return values.reduce<T[][]>((groups, value, index) => {
    groups[index % shardCount]?.push(value);
    return groups;
  }, Array.from({ length: shardCount }, () => [] as T[]));
}

const shardCount = Math.min(8, testNames.length);
const commands: ProcessTestCommand[] = shard(testNames, shardCount)
  .filter((names) => names.length > 0)
  .map((names, index) => ({
    label: `option-contract:${index + 1}`,
    args: [
      '--import',
      'tsx',
      '--test',
      '--test-name-pattern',
      `^(?:${names.map(escapeRegExp).join('|')})$`,
      testFile,
    ],
    cwd: packageRoot,
    timeoutMs: 45_000,
  }));

await runProcessTestMain(commands, { maxConcurrency: 2 });
