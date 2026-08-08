import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const nativeBinary = join(
  packageRoot,
  '..',
  'native',
  'target',
  'release',
  process.platform === 'win32' ? 'narada-agent-runtime-server-rust.exe' : 'narada-agent-runtime-server-rust',
);

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('native_http_wait_timeout'));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('native Rust NARS serves health, WebSocket control, and artifact HTTP contracts', {
  skip: !existsSync(nativeBinary),
  timeout: 30_000,
}, async () => {
  const siteRoot = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'narada-native-http-'));
  const sourcePath = join(siteRoot, 'report.html');
  await writeFile(sourcePath, '<html><body>Native artifact</body></html>');
  const child = spawn(nativeBinary, ['--raw-jsonl', '--identity', 'http-agent', '--session', 'http-session'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      NARADA_SITE_ROOT: siteRoot,
      NARADA_MCP_SCOPE: 'none',
      NARADA_NATIVE_PROVIDER_MODE: 'echo',
      NARADA_RUNTIME_HEARTBEAT_INTERVAL_MS: '20',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  const records = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    const started = await waitFor(() => records.find((record) => record.event === 'session_started'));
    assert.equal(started.runtime_engine_kind, 'rust');
    assert.match(started.health_endpoint, /^http:\/\/127\.0\.0\.1:\d+\/health$/);
    assert.match(started.event_endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/events$/);
    const healthResponse = await fetch(started.health_endpoint);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.runtime_engine_kind, 'rust');
    assert.equal(health.heartbeat.freshness, 'fresh');
    const plainEventsUrl = new URL(started.event_endpoint);
    plainEventsUrl.protocol = 'http:';
    const plainEventsResponse = await fetch(plainEventsUrl);
    assert.equal(plainEventsResponse.status, 426);
    assert.equal((await plainEventsResponse.json()).error, 'upgrade_required');
    const artifactBase = new URL('/sessions/http-session/artifacts', started.health_endpoint);
    const registerResponse = await fetch(artifactBase, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_path: sourcePath, kind: 'html', title: 'Native report' }),
    });
    assert.equal(registerResponse.status, 201);
    const artifactId = (await registerResponse.json()).artifact.artifact_id;
    const contentUrl = new URL(artifactBase.pathname + '/' + artifactId + '/content', artifactBase);
    const contentResponse = await fetch(contentUrl);
    assert.equal(contentResponse.status, 200);
    assert.match(await contentResponse.text(), /Native artifact/);
    const socket = new WebSocket(started.event_endpoint);
    const socketEvents = [];
    socket.addEventListener('message', (message) => {
      try { const event = JSON.parse(String(message.data)); socketEvents.push(event); } catch {}
    });
    await waitFor(() => socketEvents.find((event) => event.event === 'websocket_connected'));
    socket.send(JSON.stringify({ id: 'http-health', method: 'session.health', params: {} }));
    await waitFor(() => socketEvents.find((event) => event.event === 'session_health' && event.request_id === 'http-health'));
    socket.send(JSON.stringify({ id: 'http-close', method: 'session.close', params: {} }));
    await waitFor(() => socketEvents.find((event) => event.event === 'session_closed'), 8000);
    socket.close();

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('native_http_exit_timeout:' + stderr.slice(-300)));
      }, 8000);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
    assert.equal(exitCode, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(siteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
