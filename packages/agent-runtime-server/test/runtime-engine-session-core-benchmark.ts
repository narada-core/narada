import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildCanonicalLocalTestSeed, CANONICAL_LOCAL_TEST_IDS, canonicalSha256 } from '@narada-core/invokable-intelligence-contract';
import { SqliteRegistryStore } from '@narada-core/invokable-intelligence-registry';

type Engine = 'node' | 'bun' | 'rust';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeEntrypoint = fileURLToPath(new URL('../dist/bin/narada-agent-runtime-server.js', import.meta.url));
const runtimeMemoryProbe = fileURLToPath(new URL('./fixtures/runtime-memory-probe.cjs', import.meta.url));
const nativeBinary = join(
  packageRoot,
  'native',
  'target',
  'release',
  process.platform === 'win32' ? 'narada-agent-runtime-server-rust.exe' : 'narada-agent-runtime-server-rust',
);
const bunCommand = process.env.NARADA_BUN_COMMAND ?? 'bun';
const iterations = boundedInteger(process.env.NARADA_RUNTIME_SESSION_BENCHMARK_ITERATIONS, 10, 1, 50);
const warmups = boundedInteger(process.env.NARADA_RUNTIME_SESSION_BENCHMARK_WARMUPS, 1, 0, 10);
const memoryIterations = boundedInteger(process.env.NARADA_RUNTIME_SESSION_BENCHMARK_MEMORY_ITERATIONS, iterations, 1, 50);
const workload = [
  { id: 'health-1', method: 'session.health', params: {} },
  { id: 'recovery-1', method: 'session.recovery', params: {} },
  { id: 'command-1', method: 'session.command.execute', params: { command: 'status' } },
  { id: 'cancel-1', method: 'session.cancel', params: {} },
  { id: 'legacy-1', method: 'session.resume', params: {} },
  { id: 'close-1', method: 'session.close', params: {} },
];

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

const memoryMetric = process.platform === 'win32' ? 'private_memory_bytes' : 'rss_bytes';

type ProcessMemorySample = {
  private_memory_bytes: number | null;
  working_set_bytes: number | null;
  virtual_memory_bytes: number | null;
};

type RuntimeMemorySample = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

type MemorySample = {
  process: ProcessMemorySample | null;
  runtime: RuntimeMemorySample | null;
};

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sampleProcessMemory(pid: number): ProcessMemorySample | null {
  const numericPid = Number.isInteger(pid) && pid > 0 ? String(pid) : null;
  if (!numericPid) return null;
  if (process.platform === 'win32') {
    const command = '$p=Get-Process -Id ' + numericPid + ' -ErrorAction SilentlyContinue; if ($p) { [Console]::Write(([PSCustomObject]@{ private_memory_bytes=$p.PrivateMemorySize64; working_set_bytes=$p.WorkingSet64; virtual_memory_bytes=$p.VirtualMemorySize64 } | ConvertTo-Json -Compress)) }';
    for (const shell of ['powershell.exe', 'pwsh.exe']) {
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
        windowsHide: true,
      });
      try {
        const value: any = JSON.parse(String(result.stdout ?? '').trim());
        const sample = {
          private_memory_bytes: finiteNumber(value?.private_memory_bytes),
          working_set_bytes: finiteNumber(value?.working_set_bytes),
          virtual_memory_bytes: finiteNumber(value?.virtual_memory_bytes),
        };
        if (sample.private_memory_bytes || sample.working_set_bytes || sample.virtual_memory_bytes) return sample;
      } catch {
        // Try the next available PowerShell host.
      }
    }
    return null;
  }
  const result = spawnSync('ps', ['-o', 'rss=,vsz=', '-p', numericPid], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
  });
  const [rssKilobytes, virtualKilobytes] = String(result.stdout ?? '').trim().split(/\s+/).map(Number);
  return {
    private_memory_bytes: null,
    working_set_bytes: finiteNumber(rssKilobytes) === null ? null : rssKilobytes * 1024,
    virtual_memory_bytes: finiteNumber(virtualKilobytes) === null ? null : virtualKilobytes * 1024,
  };
}

function readRuntimeMemory(path: string): RuntimeMemorySample | null {
  try {
    const value: any = JSON.parse(readFileSync(path, 'utf8'));
    const rss = finiteNumber(value?.rss);
    const heapTotal = finiteNumber(value?.heapTotal);
    const heapUsed = finiteNumber(value?.heapUsed);
    const external = finiteNumber(value?.external);
    const arrayBuffers = finiteNumber(value?.arrayBuffers);
    if (rss === null || heapTotal === null || heapUsed === null || external === null || arrayBuffers === null) return null;
    return { rss, heapTotal, heapUsed, external, arrayBuffers };
  } catch {
    return null;
  }
}

function present(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function mbStats(values: number[]) {
  if (values.length === 0) return { samples: 0, p50_mb: null, p95_mb: null, mean_mb: null };
  return {
    samples: values.length,
    p50_mb: Number((percentile(values, 0.5) / (1024 * 1024)).toFixed(1)),
    p95_mb: Number((percentile(values, 0.95) / (1024 * 1024)).toFixed(1)),
    mean_mb: Number((values.reduce((sum, value) => sum + value, 0) / values.length / (1024 * 1024)).toFixed(1)),
  };
}

function memorySummary(samples: MemorySample[]) {
  const privateMemory = mbStats(present(samples.map((sample) => sample.process?.private_memory_bytes ?? null)));
  const workingSet = mbStats(present(samples.map((sample) => sample.process?.working_set_bytes ?? null)));
  const virtualMemory = mbStats(present(samples.map((sample) => sample.process?.virtual_memory_bytes ?? null)));
  const runtimeRss = mbStats(present(samples.map((sample) => sample.runtime?.rss ?? null)));
  const runtimeHeapTotal = mbStats(present(samples.map((sample) => sample.runtime?.heapTotal ?? null)));
  const runtimeHeapUsed = mbStats(present(samples.map((sample) => sample.runtime?.heapUsed ?? null)));
  const runtimeExternal = mbStats(present(samples.map((sample) => sample.runtime?.external ?? null)));
  const runtimeArrayBuffers = mbStats(present(samples.map((sample) => sample.runtime?.arrayBuffers ?? null)));
  return {
    memory_metric: memoryMetric,
    memory_samples: privateMemory.samples,
    memory_p50_mb: privateMemory.p50_mb,
    memory_p95_mb: privateMemory.p95_mb,
    memory_mean_mb: privateMemory.mean_mb,
    process_memory: {
      private_memory_bytes: privateMemory,
      working_set_bytes: workingSet,
      virtual_memory_bytes: virtualMemory,
    },
    runtime_memory: {
      metric: 'process.memoryUsage',
      rss_bytes: runtimeRss,
      heap_total_bytes: runtimeHeapTotal,
      heap_used_bytes: runtimeHeapUsed,
      external_bytes: runtimeExternal,
      array_buffers_bytes: runtimeArrayBuffers,
    },
  };
}
async function seedIntelligenceRegistry(siteRoot: string): Promise<string> {
  const dbPath = join(siteRoot, '.ai', 'intelligence-registry.db');
  await mkdir(join(siteRoot, '.ai'), { recursive: true });
  const store: any = await SqliteRegistryStore.open(dbPath);
  try {
    const now = new Date().toISOString();
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const seed: any = JSON.parse(JSON.stringify(buildCanonicalLocalTestSeed({
      adapterProtocol: { family: 'codex-subscription', operation: 'responses', version: '1' },
      credentialStore: 'none',
      credentialReference: 'codex-subscription-session',
      invocationModelKey: 'gpt-5.5',
      now,
      validUntil,
    })));
    const replacements = new Map([
      ['model-provider:kimi', 'model-provider:openai'],
      ['model:kimi-k2-thinking', 'model:openai-gpt-5.5'],
      ['model-offering:kimi-via-local-api', 'model-offering:gpt-5.5-via-codex-subscription'],
      ['route:kimi-local-api', 'route:gpt-5.5-codex-subscription'],
      ['adapter:openai-compatible-http', 'adapter:codex-subscription'],
      ['inference-endpoint:remote-default', 'inference-endpoint:codex-subscription'],
      ['inference-provider:remote-api', 'inference-provider:codex-subscription'],
      ['local-api', 'codex-subscription'],
      ['Kimi K2 Thinking', 'GPT-5.5'],
      ['model-owner:kimi', 'model-owner:openai'],
    ]);
    for (const record of seed.records) {
      let serialized = JSON.stringify(record.document);
      for (const [from, to] of replacements) serialized = serialized.replaceAll(from, to);
      record.document = JSON.parse(serialized);
      record.record_id = record.document.id;
      if (record.document.schema === 'narada.invokable-intelligence.adapter.v1') {
        record.document.protocol = { family: 'codex-subscription', operation: 'responses', version: '1' };
      }
      if (record.document.schema === 'narada.invokable-intelligence.inference-endpoint.v1') {
        record.document.address = { kind: 'runtime-service', service: 'codex-subscription' };
      }
      if (record.document.schema === 'narada.invokable-intelligence.model-offering.v1') {
        record.document.invocation_model_key = 'gpt-5.5';
      }
      if (record.document.schema === 'narada.invokable-intelligence.invocation-route-candidate.v1') {
        record.document.topology.nodes = record.document.topology.nodes.map((node: any) => ({ ...node, required_feasibility: [] }));
        record.document.topology.edges = record.document.topology.edges.map((edge: any) => ({ ...edge, required_feasibility: [] }));
      }
      if (record.document.schema === 'narada.invokable-intelligence.access-grant.v1') {
        record.document.scope.purposes = [...new Set([...record.document.scope.purposes, 'agent-session'])];
      }
      if (record.document.schema === 'narada.invokable-intelligence.data-governance-requirement.v1') {
        record.document.purposes = [...new Set([...record.document.purposes, 'agent-session'])];
      }
      if (record.document.schema === 'narada.invokable-intelligence.authority-statement.v1') {
        record.authority = {
          ...record.authority,
          locus: record.document.origin.locus,
          site_id: record.document.origin.site_id,
          authority_ref: record.document.origin.authority_ref,
        };
      }
      record.source.digest = canonicalSha256(record.document);
    }
    await store.loadCatalogSeed(seed);
  } finally {
    await store.close();
  }
  return dbPath;
}

function environmentFor(siteRoot: string, registryDbPath: string, engine: Engine, memoryReportPath?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NARADA_SITE_ROOT: siteRoot,
    NARADA_INTELLIGENCE_REGISTRY_DB: registryDbPath,
    NARADA_INTELLIGENCE_TARGET_SITE: CANONICAL_LOCAL_TEST_IDS.targetSite,
    NARADA_INTELLIGENCE_USER_SITE: CANONICAL_LOCAL_TEST_IDS.userSite,
    NARADA_INTELLIGENCE_HOST_SITE: CANONICAL_LOCAL_TEST_IDS.hostSite,
    NARADA_INTELLIGENCE_PRINCIPAL_ID: CANONICAL_LOCAL_TEST_IDS.principal,
    NARADA_INTELLIGENCE_PRINCIPAL_BINDING: JSON.stringify({
      schema: 'narada.intelligence.principal_binding.v1',
      actor: { principal_id: CANONICAL_LOCAL_TEST_IDS.principal, auth_type: 'user-site-session' },
      memberships: [{ registry: 'site-roster', site_id: CANONICAL_LOCAL_TEST_IDS.targetSite, role: 'resident', evidence_ref: 'evidence:runtime-engine-session-core-benchmark' }],
      evidence_refs: ['evidence:runtime-engine-session-core-benchmark'],
    }),
    NARADA_AUTHORITY_REF: 'task:runtime-engine-session-core-benchmark',
    NARADA_MCP_SCOPE: 'none',
    NARADA_AGENT_RUNTIME_HEALTH_ENABLED: '0',
    NARADA_AGENT_RUNTIME_EVENTS_ENABLED: '0',
    NARADA_RUNTIME_ENGINE: engine,
  };
  if (memoryReportPath) environment.NARADA_RUNTIME_BENCHMARK_MEMORY_REPORT = memoryReportPath;
  else delete environment.NARADA_RUNTIME_BENCHMARK_MEMORY_REPORT;
  delete environment.NARADA_RUNTIME_DELEGATE;
  if (engine === 'rust') {
    environment.NARADA_RUNTIME_SERVER_SCRIPT = runtimeEntrypoint;
    environment.NARADA_RUNTIME_NODE_COMMAND = process.execPath;
    environment.NARADA_NATIVE_PROVIDER_MODE = 'blocked';
  } else {
    delete environment.NARADA_RUNTIME_SERVER_SCRIPT;
  }
  return environment;
}

function runtimeArgs(engine: Engine, includeMemoryProbe = false): string[] {
  const preload = includeMemoryProbe && engine === 'node'
    ? ['--require', runtimeMemoryProbe]
    : includeMemoryProbe && engine === 'bun'
      ? ['--preload', runtimeMemoryProbe]
      : [];
  return [
    ...preload,
    ...(engine === 'rust' ? [] : [runtimeEntrypoint]),
    '--raw-jsonl',
    '--no-health',
    '--no-events',
    '--identity',
    'narada.test',
  ];
}

async function runOnce(engine: Engine): Promise<number> {
  const siteRoot = await mkdtemp(join(tmpdir(), `narada-session-benchmark-${engine}-`));
  try {
    const registryDbPath = await seedIntelligenceRegistry(siteRoot);
    const command = engine === 'node' ? process.execPath : engine === 'bun' ? bunCommand : nativeBinary;
    const args = [...runtimeArgs(engine), '--session', 'session-benchmark-' + engine];
    return await new Promise<number>((resolve, reject) => {
      const startedAt = performance.now();
      const child = spawn(command, args, {
        cwd: packageRoot,
        env: environmentFor(siteRoot, registryDbPath, engine),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      let stdoutBytes = 0;
      child.stdout.on('data', (chunk) => {
        stdoutBytes += Buffer.byteLength(String(chunk));
        if (stdoutBytes > 512 * 1024) child.kill();
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.stdin.end(workload.map((request) => JSON.stringify(request)).join('\n') + '\n');
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`session_benchmark_timeout:${engine}:${stderr.slice(-600)}`));
      }, 20_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`session_benchmark_exit:${engine}:${code}:${stderr.slice(-600)}`));
        else resolve(performance.now() - startedAt);
      });
    });
  } finally {
    await rm(siteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// Memory runs hold the same session open after the final pre-close control and sample before close.
// Keeping this pass separate prevents the OS sampler from inflating latency measurements.
async function runMemoryOnce(engine: Engine): Promise<MemorySample | null> {
  const siteRoot = await mkdtemp(join(tmpdir(), 'narada-session-benchmark-memory-' + engine + '-'));
  try {
    const registryDbPath = await seedIntelligenceRegistry(siteRoot);
    const command = engine === 'node' ? process.execPath : engine === 'bun' ? bunCommand : nativeBinary;
    const reportPath = join(siteRoot, 'runtime-memory.json');
    const args = [...runtimeArgs(engine, true), '--session', 'session-benchmark-memory-' + engine];
    return await new Promise<MemorySample | null>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: packageRoot,
        env: environmentFor(siteRoot, registryDbPath, engine, reportPath),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      let stdoutBytes = 0;
      let stdoutBuffer = '';
      let memorySample: MemorySample | null = null;
      let sampled = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('session_memory_benchmark_timeout:' + engine + ':' + stderr.slice(-600)));
      }, 20_000);
      const fallbackTimer = setTimeout(() => sampleAndClose(), 2_000);
      const closeRequest = workload[workload.length - 1];
      const sampleAndClose = () => {
        if (sampled) return;
        sampled = true;
        memorySample = { process: sampleProcessMemory(child.pid ?? -1), runtime: readRuntimeMemory(reportPath) };
        if (!child.stdin.destroyed) {
          child.stdin.write(JSON.stringify(closeRequest) + '\n');
          child.stdin.end();
        }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        stdoutBytes += Buffer.byteLength(text);
        if (stdoutBytes > 512 * 1024) {
          child.kill();
          return;
        }
        stdoutBuffer += text;
        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line) {
            try {
              const record = JSON.parse(line);
              if (
                record?.request_id === 'legacy-1'
                && (record?.event === 'session_control_rejected' || record?.event === 'session_control_response')
              ) sampleAndClose();
            } catch {
              // Ignore non-JSON diagnostics; the bounded fallback still closes the child.
            }
          }
          newlineIndex = stdoutBuffer.indexOf('\n');
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.stdin.write(workload.slice(0, -1).map((request) => JSON.stringify(request)).join('\n') + '\n');
      child.once('error', (error) => {
        clearTimeout(timer);
        clearTimeout(fallbackTimer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        clearTimeout(fallbackTimer);
        if (code !== 0) reject(new Error('session_memory_benchmark_exit:' + engine + ':' + code + ':' + stderr.slice(-600)));
        else resolve(memorySample);
      });
    });
  } finally {
    await rm(siteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function measure(engine: Engine) {
  if (engine === 'bun' && spawnSync(bunCommand, ['--version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    return { engine, status: 'unavailable', samples: 0, p50_ms: null, p95_ms: null, mean_ms: null };
  }
  if (engine === 'rust' && !existsSync(nativeBinary)) {
    return { engine, status: 'unavailable', samples: 0, p50_ms: null, p95_ms: null, mean_ms: null };
  }
  for (let index = 0; index < warmups; index += 1) await runOnce(engine);
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) samples.push(await runOnce(engine));
  return {
    engine,
    status: 'measured',
    samples: samples.length,
    p50_ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95_ms: Number(percentile(samples, 0.95).toFixed(3)),
    mean_ms: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3)),
  };
}

async function measureMemory(engine: Engine) {
  for (let index = 0; index < warmups; index += 1) await runMemoryOnce(engine);
  const samples: MemorySample[] = [];
  for (let index = 0; index < memoryIterations; index += 1) {
    const sample = await runMemoryOnce(engine);
    if (sample !== null) samples.push(sample);
  }
  return memorySummary(samples);
}

const results = [];
for (const engine of ['node', 'bun', 'rust'] as Engine[]) {
  const latency = await measure(engine);
  results.push({ ...latency, ...(latency.status === 'measured' ? await measureMemory(engine) : memorySummary([])) });
}
process.stdout.write(`${JSON.stringify({
  schema: 'narada.nars.session_core_benchmark.v1',
  workload_profile: 'common-control-only-no-provider-or-mcp',
  generated_at: new Date().toISOString(),
  iterations,
  warmups,
  memory_iterations: memoryIterations,
  workload: workload.map(({ method }) => method),
  results,
}, null, 2)}\n`);
