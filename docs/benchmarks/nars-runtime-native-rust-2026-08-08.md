# Native Rust NARS runtime benchmark

Date: 2026-08-08  
Checkout: `narada` main, native Rust release binary  
Samples: 30 measured runs, 3 warmups; 30 private-memory samples

The control workload exercised one real session per run:

`session.health`, `session.recovery`, `session.command.execute`, `session.cancel`, unsupported `session.resume`, `session.close`.

## Real NARS session workload

| Engine | p50 | p95 | Mean | Private memory p50 | Private memory p95 |
|---|---:|---:|---:|---:|---:|
| Node | 631.875 ms | 663.990 ms | 637.360 ms | 116.4 MB | 117.0 MB |
| Bun | 483.358 ms | 506.887 ms | 484.318 ms | 588.5 MB | 652.0 MB |
| Native Rust | 138.069 ms | 145.300 ms | 138.906 ms | 1.2 MB | 1.2 MB |

Rust is 78.1% below Node p50 and 71.4% below Bun p50 for this workload. The memory sampler is Windows `PrivateMemorySize64`; values are process samples, not a claim about total system footprint.

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