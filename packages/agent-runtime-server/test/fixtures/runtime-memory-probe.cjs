'use strict';

const fs = require('node:fs');

const reportPath = process.env.NARADA_RUNTIME_BENCHMARK_MEMORY_REPORT;
if (reportPath) {
  const writeReport = () => {
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        ...process.memoryUsage(),
        sampled_at: new Date().toISOString(),
      }));
    } catch {
      // The benchmark treats a missing probe report as unavailable.
    }
  };
  writeReport();
  const timer = setInterval(writeReport, 25);
  timer.unref?.();
  process.once('exit', writeReport);
}