# Native Rust NARS runtime benchmark

Date: 2026-08-08  
Checkout: `narada` main, native Rust release binary  
Samples: 30 measured runs, 3 warmups; 30 process-memory and runtime-heap samples

The control workload exercised one real session per run:

`session.health`, `session.recovery`, `session.command.execute`, `session.cancel`, unsupported `session.resume`, `session.close`.

## Real NARS session workload

| Engine | p50 | p95 | Mean | Private memory p50 | Private memory p95 |
|---|---:|---:|---:|---:|---:|
| Node | 626.808 ms | 666.099 ms | 628.358 ms | 116.3 MB | 117.2 MB |
| Bun | 524.995 ms | 657.573 ms | 535.273 ms | 582.9 MB | 625.8 MB |
| Native Rust | 138.567 ms | 146.173 ms | 139.597 ms | 1.2 MB | 1.2 MB |

Rust is 77.9% below Node p50 and 73.6% below Bun p50 for this workload. The private-memory sampler is Windows PrivateMemorySize64; values are process samples, not a claim about resident memory or total system footprint.

### Memory decomposition

| Engine | Working set p50 | Working set p95 | Runtime RSS p50 | Runtime heap used p50 | Runtime heap total p50 |
|---|---:|---:|---:|---:|---:|
| Node | 113.9 MB | 114.5 MB | 113.9 MB | 30.0 MB | 55.1 MB |
| Bun | 132.7 MB | 135.4 MB | 132.7 MB | 11.9 MB | 10.9 MB |
| Native Rust | 5.5 MB | 5.5 MB | — | — | — |

Working set is resident memory (WorkingSet64); runtime fields come from a benchmark-only preload calling process.memoryUsage(). Bun's private-memory gap is therefore mostly nonresident/private allocation accounting: roughly 583 MB private versus 133 MB resident. Heap values are runtime-specific (V8 versus JavaScriptCore compatibility reporting), so compare them directionally rather than as identical heap definitions.

## Process-boundary compatibility fixture

This separate benchmark launches the bounded runtime fixture. The Rust row deliberately uses the explicit legacy delegation path, so it measures compatibility-boundary overhead, not native NARS execution.

| Engine | p50 | p95 | Mean |
|---|---:|---:|---:|
| Node | 51.383 ms | 63.289 ms | 52.246 ms |
| Bun | 51.108 ms | 58.495 ms | 51.629 ms |
| Rust compatibility delegation | 65.025 ms | 73.607 ms | 65.516 ms |

Commands:

```powershell
$env:NARADA_RUNTIME_SESSION_BENCHMARK_ITERATIONS='30'
$env:NARADA_RUNTIME_SESSION_BENCHMARK_WARMUPS='3'
$env:NARADA_RUNTIME_SESSION_BENCHMARK_MEMORY_ITERATIONS='30'
pnpm --filter @narada-core/agent-runtime-server exec node --import tsx test/runtime-engine-session-core-benchmark.ts

$env:NARADA_RUNTIME_ENGINE_BENCHMARK_ITERATIONS='30'
$env:NARADA_RUNTIME_ENGINE_BENCHMARK_WARMUPS='3'
pnpm --filter @narada-core/agent-runtime-server exec node --import tsx test/runtime-engine-boundary-benchmark.ts
```