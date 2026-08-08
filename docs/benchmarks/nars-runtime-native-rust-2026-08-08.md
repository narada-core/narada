# Native Rust NARS runtime benchmark

Date: 2026-08-08  
Checkout: `narada` main, native Rust release binary  
Samples: 30 measured runs, 3 warmups; 30 private-memory samples

The control workload exercised one real session per run:

`session.health`, `session.recovery`, `session.command.execute`, `session.cancel`, unsupported `session.resume`, `session.close`.

## Real NARS session workload

| Engine | p50 | p95 | Mean | Private memory p50 | Private memory p95 |
|---|---:|---:|---:|---:|---:|
| Node | 620.476 ms | 640.005 ms | 623.362 ms | 116.2 MB | 116.9 MB |
| Bun | 486.814 ms | 500.375 ms | 486.963 ms | 602.2 MB | 647.7 MB |
| Native Rust | 138.997 ms | 154.443 ms | 143.104 ms | 1.2 MB | 1.2 MB |

Rust is 77.6% below Node p50 and 71.5% below Bun p50 for this workload. The memory sampler is Windows `PrivateMemorySize64`; values are process samples, not a claim about total system footprint.

## Process-boundary compatibility fixture

This separate benchmark launches the bounded runtime fixture. The Rust row deliberately uses the explicit legacy delegation path, so it measures compatibility-boundary overhead, not native NARS execution.

| Engine | p50 | p95 | Mean |
|---|---:|---:|---:|
| Node | 47.976 ms | 54.066 ms | 49.145 ms |
| Bun | 48.714 ms | 56.105 ms | 49.445 ms |
| Rust compatibility delegation | 57.976 ms | 65.389 ms | 58.583 ms |

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