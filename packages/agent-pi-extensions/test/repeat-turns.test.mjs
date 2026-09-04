import assert from 'node:assert/strict';
import test from 'node:test';

import extension, { repeatStopReason } from '../extensions/repeat-turns.ts';

function createHarness() {
  const commands = new Map();
  const handlers = new Map();
  const sent = [];
  const entries = [];
  const notifications = [];
  const pi = {
    events: { on() {}, off() {}, emit() {} },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(type, data) { entries.push({ type, data }); },
    sendUserMessage(message) { sent.push(message); },
    registerCommand(name, options) { commands.set(name, options); },
  };
  extension(pi);
  const context = {
    mode: 'tui',
    cwd: 'C:/Users/andrey/src/narada',
    isIdle: () => true,
    abort() {},
    ui: {
      setStatus() {},
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  return { commands, handlers, sent, entries, notifications, context };
}

async function completeIteration(harness, text) {
  await harness.handlers.get('agent_start')({}, harness.context);
  await harness.handlers.get('message_end')({
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }, harness.context);
  await harness.handlers.get('agent_settled')({}, harness.context);
}

test('repeat stop marker accepts a final inline marker but rejects trailing text', () => {
  assert.equal(repeatStopReason('blocked [REPEAT_STOP]'), 'agent requested stop');
  assert.equal(repeatStopReason('blocked [REPEAT_STOP reason="no executable continuation"]'), 'no executable continuation');
  assert.equal(repeatStopReason('blocked [REPEAT_STOP]\npostscript'), null);
});

test('repeat stop marker prevents the next iteration', async () => {
  const harness = createHarness();
  await harness.commands.get('repeat').handler('3 test prompt', harness.context);
  assert.equal(harness.sent.length, 1);

  await completeIteration(harness, 'result [REPEAT_STOP]');

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.entries.at(-1).data.active, false);
  assert.match(harness.notifications.at(-1).message, /Repeat stopped: agent requested stop/);
});

test('agent_end fallback observes a stop marker before agent_settled', async () => {
  const harness = createHarness();
  await harness.commands.get('repeat').handler('3 test prompt', harness.context);
  await harness.handlers.get('agent_start')({}, harness.context);
  await harness.handlers.get('agent_end')({
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'result [REPEAT_STOP]' }] }],
  }, harness.context);
  await harness.handlers.get('agent_settled')({}, harness.context);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.entries.at(-1).data.active, false);
});

test('repeat-then-notify emits once after the complete repeat sequence', async () => {
  const harness = createHarness();
  assert.ok(harness.commands.has('repeat'));
  assert.ok(harness.commands.has('repeat-then-notify'));

  let bellCount = 0;
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (chunk === '\u0007') {
      bellCount += 1;
      return true;
    }
    return originalWrite.call(this, chunk, ...rest);
  };
  try {
    await harness.commands.get('repeat-then-notify').handler('2 test prompt', harness.context);
    assert.equal(harness.sent.length, 1);

    await completeIteration(harness, 'first result');
    assert.equal(harness.sent.length, 2);
    assert.equal(bellCount, 0);

    await completeIteration(harness, 'second result');
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(bellCount, process.platform === 'win32' ? 1 : 0);
  assert.match(harness.notifications.at(-1).message, /Repeat stopped: completed/);
  assert.equal(harness.entries.at(-1).data.active, false);
  assert.equal(harness.entries.at(-1).data.notifyOnFinish, false);
});

test('ordinary repeat does not arm the completion notification', async () => {
  const harness = createHarness();
  let bellCount = 0;
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (chunk === '\u0007') {
      bellCount += 1;
      return true;
    }
    return originalWrite.call(this, chunk, ...rest);
  };
  try {
    await harness.commands.get('repeat').handler('1 test prompt', harness.context);
    await completeIteration(harness, 'result');
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(bellCount, 0);
});
