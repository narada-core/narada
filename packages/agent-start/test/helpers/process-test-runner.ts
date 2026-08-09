import type { ChildProcess } from 'node:child_process';
import { spawnTestChild } from '@narada-core/process-launch-posture';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 2;

export interface ProcessTestCommand {
  label: string;
  command?: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ProcessTestResult {
  label: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export type ProcessTestExecutor = (command: ProcessTestCommand) => Promise<ProcessTestResult>;

export interface ProcessTestLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface RunProcessTestsOptions {
  maxConcurrency?: number;
  execute?: ProcessTestExecutor;
  logger?: ProcessTestLogger | null;
}

export class ProcessTestRunError extends Error {
  readonly results: readonly ProcessTestResult[];
  readonly failures: readonly ProcessTestResult[];

  constructor(results: readonly ProcessTestResult[]) {
    const failures = results.filter((result) => result.timedOut || result.exitCode !== 0);
    super(`${failures.length} of ${results.length} process tests failed`);
    this.name = 'ProcessTestRunError';
    this.results = results;
    this.failures = failures;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function bufferedOutput(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

export function runProcessTest({
  label,
  command = process.execPath,
  args,
  cwd,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ProcessTestCommand): Promise<ProcessTestResult> {
  positiveInteger(timeoutMs, 'timeoutMs');

  return new Promise((resolve) => {
    const child: ChildProcess = spawnTestChild(command, [...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startedAt = performance.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const settle = (result: Omit<ProcessTestResult, 'label' | 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        label,
        durationMs: Math.round(performance.now() - startedAt),
        ...result,
      });
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('close', (exitCode, signal) => {
      settle({
        exitCode,
        signal,
        timedOut,
        stdout: bufferedOutput(stdoutChunks),
        stderr: bufferedOutput(stderrChunks),
      });
    });
    child.once('error', (error) => {
      settle({
        exitCode: 1,
        signal: null,
        timedOut,
        stdout: bufferedOutput(stdoutChunks),
        stderr: error.stack ?? String(error),
      });
    });
  });
}

const MAX_FAILURE_OUTPUT_CHARS = 8_000;

function boundedDiagnostic(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_FAILURE_OUTPUT_CHARS) return normalized;
  const omitted = normalized.length - MAX_FAILURE_OUTPUT_CHARS;
  return `[... ${omitted} earlier characters omitted ...]\n${normalized.slice(-MAX_FAILURE_OUTPUT_CHARS)}`;
}

function reportResults(results: readonly ProcessTestResult[], logger: ProcessTestLogger): void {
  for (const result of results) {
    const state = result.timedOut ? 'timeout' : result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`;
    logger.log(`${result.label}: ${state} (${result.durationMs}ms)`);
  }

  for (const failure of results.filter((result) => result.timedOut || result.exitCode !== 0)) {
    logger.error(`\n[${failure.label}] failed`);
    if (failure.stdout.trim()) logger.error(boundedDiagnostic(failure.stdout));
    if (failure.stderr.trim()) logger.error(boundedDiagnostic(failure.stderr));
  }
}
export async function runProcessTests(
  commands: readonly ProcessTestCommand[],
  options: RunProcessTestsOptions = {},
): Promise<readonly ProcessTestResult[]> {
  if (commands.length === 0) return [];

  const maxConcurrency = positiveInteger(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, 'maxConcurrency');
  const execute = options.execute ?? runProcessTest;
  const results = new Array<ProcessTestResult>(commands.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      if (index >= commands.length) return;
      nextIndex += 1;

      const command = commands[index];
      if (command === undefined) throw new Error(`missing process test command at index ${index}`);
      // runProcessTest creates its timeout here, after this command acquires a
      // worker slot. Queue wait therefore cannot consume a child's deadline.
      results[index] = await execute(command);
    }
  };

  const workerCount = Math.min(maxConcurrency, commands.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const logger = options.logger === undefined ? console : options.logger;
  if (logger !== null) reportResults(results, logger);

  if (results.some((result) => result.timedOut || result.exitCode !== 0)) {
    throw new ProcessTestRunError(results);
  }
  return results;
}

export async function runProcessTestMain(
  commands: readonly ProcessTestCommand[],
  options: RunProcessTestsOptions = {},
): Promise<void> {
  try {
    await runProcessTests(commands, options);
  } catch (error) {
    if (error instanceof ProcessTestRunError) {
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
