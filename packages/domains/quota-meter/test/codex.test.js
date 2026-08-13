import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveCodexCommand } from '../src/codex.js';

test('configured Codex command takes precedence', () => {
  assert.equal(
    resolveCodexCommand({ CODEX_COMMAND: '  C:\\tools\\codex.cmd  ' }, 'win32', 'C:\\node\\node.exe'),
    'C:\\tools\\codex.cmd',
  );
});

test('Windows prefers the native per-user Codex installation', () => {
  const localAppData = path.join('C:\\Users\\user', 'AppData', 'Local');
  const nativeCommand = path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  const siblingCommand = path.join('C:\\fnm', 'codex.cmd');

  assert.equal(
    resolveCodexCommand(
      { LOCALAPPDATA: localAppData },
      'win32',
      path.join('C:\\fnm', 'node.exe'),
      (candidate) => candidate === nativeCommand || candidate === siblingCommand,
    ),
    nativeCommand,
  );
});

test('Windows falls back to codex.cmd beside Node when native Codex is absent', () => {
  const executablePath = path.join('C:\\Users\\user', 'fnm', 'node.exe');
  const expected = path.join(path.dirname(executablePath), 'codex.cmd');
  assert.equal(
    resolveCodexCommand(
      { LOCALAPPDATA: path.join('C:\\Users\\user', 'AppData', 'Local') },
      'win32',
      executablePath,
      (candidate) => candidate === expected,
    ),
    expected,
  );
});

test('non-Windows keeps the PATH-resolved Codex command', () => {
  assert.equal(resolveCodexCommand({}, 'linux', '/usr/bin/node', () => true), 'codex');
});
