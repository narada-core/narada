import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OverlayTone } from './index.js';

export type ToastAttention = 'foreground' | 'background';
export type ToastOriginKind = 'operator_notification' | 'surface_action' | 'runtime_event' | 'manual';
export type ToastItemPhase = 'queued' | 'visible' | 'paused' | 'dismissed' | 'expired' | 'actioned';
export type ToastAction =
  | { kind: 'open_url'; label: string; target: string; alt_text: string }
  | { kind: 'copy_text'; label: string; text: string; alt_text: string };

export interface ToastRequestInput {
  id?: unknown;
  origin?: unknown;
  attention?: unknown;
  tone?: unknown;
  title?: unknown;
  description?: unknown;
  action?: unknown;
  dedupe_key?: unknown;
  duration_ms?: unknown;
  created_at?: unknown;
}

export interface ToastRequest {
  schema: typeof TOAST_REQUEST_SCHEMA;
  id: string;
  origin: { kind: ToastOriginKind; ref: string | null };
  attention: ToastAttention;
  tone: OverlayTone;
  title: string;
  description: string | null;
  action: ToastAction | null;
  dedupe_key: string | null;
  duration_ms: number;
  created_at: string;
}

export interface ToastProjectedItem {
  id: string;
  phase: ToastItemPhase;
  attention: ToastAttention;
  tone: OverlayTone;
  title: string;
  dedupe_key: string | null;
  remaining_ms: number;
}

export interface ToastViewportState {
  schema: typeof TOAST_VIEWPORT_STATE_SCHEMA;
  lifecycle: 'starting' | 'running' | 'stopped' | 'failed';
  pid: number | null;
  visible: ToastProjectedItem[];
  queued: ToastProjectedItem[];
  dropped_total: number;
  last_outcome: Record<string, unknown> | null;
  last_error: string | null;
  updated_at: string;
}

export interface ToastViewportStatus {
  schema: typeof TOAST_VIEWPORT_RESULT_SCHEMA;
  state: 'running' | 'stopped';
  pid: number | null;
  state_root: string;
  viewport: ToastViewportState | null;
}

export interface ToastIngressReceipt {
  schema: typeof TOAST_INGRESS_RECEIPT_SCHEMA;
  status: 'ingress_accepted';
  request_id: string;
  viewport_pid: number;
  state_root: string;
  ingress_path: string;
  accepted_at: string;
}

export interface ToastViewportOptions {
  stateRoot?: string;
  env?: NodeJS.ProcessEnv;
  idleTimeoutSeconds?: number;
}

export interface ToastViewportPaths {
  stateRoot: string;
  inbox: string;
  pid: string;
  state: string;
  stdout: string;
  stderr: string;
}

export const TOAST_REQUEST_SCHEMA = 'narada.window_toast.request.v1';
export const TOAST_VIEWPORT_STATE_SCHEMA = 'narada.window_toast.viewport_state.v1';
export const TOAST_VIEWPORT_RESULT_SCHEMA = 'narada.window_toast.viewport_result.v1';
export const TOAST_INGRESS_RECEIPT_SCHEMA = 'narada.window_toast.ingress_receipt.v1';
export const DEFAULT_BACKGROUND_TOAST_DURATION_MS = 5_000;
export const DEFAULT_FOREGROUND_TOAST_DURATION_MS = 8_000;
export const DEFAULT_TOAST_IDLE_TIMEOUT_SECONDS = 300;

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const VALID_TONES = new Set<OverlayTone>(['default', 'muted', 'success', 'warning', 'danger', 'accent']);
const VALID_ATTENTION = new Set<ToastAttention>(['foreground', 'background']);
const VALID_ORIGINS = new Set<ToastOriginKind>(['operator_notification', 'surface_action', 'runtime_event', 'manual']);
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

function packageAsset(name: string): string {
  const builtPath = resolve(PACKAGE_ROOT, name);
  return existsSync(builtPath) ? builtPath : resolve(PACKAGE_ROOT, '..', 'src', name);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, name: string, maximum: number, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`toast_${name}_required`);
    return null;
  }
  const text = String(value).trim();
  if (!text && required) throw new Error(`toast_${name}_required`);
  if (text.length > maximum) throw new Error(`toast_${name}_too_long`);
  return text || null;
}

function normalizeToastAction(value: unknown): ToastAction | null {
  if (value === undefined || value === null) return null;
  const action = asRecord(value, 'toast_action_must_be_object');
  const kind = String(action.kind ?? '');
  const label = boundedText(action.label, 'action_label', 80, true) as string;
  const altText = boundedText(action.alt_text, 'action_alt_text', 160, true) as string;
  if (kind === 'open_url') {
    const target = boundedText(action.target, 'action_target', 2_048, true) as string;
    let url: URL;
    try { url = new URL(target); } catch { throw new Error('toast_open_url_target_invalid'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('toast_open_url_target_scheme_invalid');
    return { kind, label, target: url.toString(), alt_text: altText };
  }
  if (kind === 'copy_text') {
    const text = boundedText(action.text, 'action_text', 4_000, true) as string;
    return { kind, label, text, alt_text: altText };
  }
  throw new Error('toast_action_kind_invalid');
}

export function createToastRequest(input: ToastRequestInput): ToastRequest {
  const id = boundedText(input.id ?? `toast_${randomUUID()}`, 'id', 96, true) as string;
  if (!VALID_ID.test(id)) throw new Error('toast_id_invalid');
  const originInput = input.origin === undefined ? {} : asRecord(input.origin, 'toast_origin_must_be_object');
  const originKind = String(originInput.kind ?? 'manual') as ToastOriginKind;
  if (!VALID_ORIGINS.has(originKind)) throw new Error('toast_origin_kind_invalid');
  const attention = String(input.attention ?? 'background') as ToastAttention;
  if (!VALID_ATTENTION.has(attention)) throw new Error('toast_attention_invalid');
  const tone = String(input.tone ?? 'default') as OverlayTone;
  if (!VALID_TONES.has(tone)) throw new Error('toast_tone_invalid');
  const duration = Number(input.duration_ms ?? (
    attention === 'foreground' ? DEFAULT_FOREGROUND_TOAST_DURATION_MS : DEFAULT_BACKGROUND_TOAST_DURATION_MS
  ));
  if (!Number.isInteger(duration) || duration < 1_000 || duration > 60_000) {
    throw new Error('toast_duration_ms_invalid');
  }
  const createdAt = boundedText(input.created_at ?? new Date().toISOString(), 'created_at', 64, true) as string;
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('toast_created_at_invalid');
  return {
    schema: TOAST_REQUEST_SCHEMA,
    id,
    origin: {
      kind: originKind,
      ref: boundedText(originInput.ref, 'origin_ref', 256),
    },
    attention,
    tone,
    title: boundedText(input.title, 'title', 160, true) as string,
    description: boundedText(input.description, 'description', 2_000),
    action: normalizeToastAction(input.action),
    dedupe_key: boundedText(input.dedupe_key, 'dedupe_key', 256),
    duration_ms: duration,
    created_at: new Date(createdAt).toISOString(),
  };
}

function normalizeEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) normalized[key.toUpperCase()] = value;
  }
  return normalized;
}

export function defaultToastViewportStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const normalized = normalizeEnvironment(env);
  const localAppData = normalized.LOCALAPPDATA || join(normalized.USERPROFILE || homedir(), 'AppData', 'Local');
  return join(localAppData, 'Narada', 'window-toast-viewport');
}

export function toastViewportPaths(stateRoot = defaultToastViewportStateRoot()): ToastViewportPaths {
  const root = resolve(stateRoot);
  return {
    stateRoot: root,
    inbox: join(root, 'inbox'),
    pid: join(root, 'viewport.pid'),
    state: join(root, 'viewport.state.json'),
    stdout: join(root, 'viewport.stdout.log'),
    stderr: join(root, 'viewport.stderr.log'),
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as T; }
  catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
}

function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readRunningPid(paths: ToastViewportPaths): Promise<number | null> {
  try {
    const pid = Number((await readFile(paths.pid, 'utf8')).trim());
    if (!processIsRunning(pid)) return null;
    const state = await readJson<ToastViewportState>(paths.state);
    const heartbeatAge = state ? Date.now() - Date.parse(state.updated_at) : Number.POSITIVE_INFINITY;
    return state?.lifecycle === 'running' && state.pid === pid && heartbeatAge >= 0 && heartbeatAge < 2_000 ? pid : null;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function runPowerShell(script: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`toast_script_failed:${code}`)));
  });
}

export const toastViewportHostScriptPath = (): string => packageAsset('window-toast-viewport.ps1');

export async function inspectToastViewport(options: ToastViewportOptions = {}): Promise<ToastViewportStatus> {
  const paths = toastViewportPaths(options.stateRoot ?? defaultToastViewportStateRoot(options.env));
  const pid = await readRunningPid(paths);
  return {
    schema: TOAST_VIEWPORT_RESULT_SCHEMA,
    state: pid === null ? 'stopped' : 'running',
    pid,
    state_root: paths.stateRoot,
    viewport: await readJson<ToastViewportState>(paths.state),
  };
}

async function ensureToastViewport(options: ToastViewportOptions): Promise<number> {
  const paths = toastViewportPaths(options.stateRoot ?? defaultToastViewportStateRoot(options.env));
  const running = await readRunningPid(paths);
  if (running !== null) return running;
  await mkdir(paths.inbox, { recursive: true });
  await runPowerShell(packageAsset('Start-WindowToastViewport.ps1'), [
    '-StateRoot', paths.stateRoot,
    '-IdleTimeoutSeconds', String(options.idleTimeoutSeconds ?? DEFAULT_TOAST_IDLE_TIMEOUT_SECONDS),
  ]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pid = await readRunningPid(paths);
    if (pid !== null) return pid;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const stderr = await readFile(paths.stderr, 'utf8').catch(() => '');
  throw new Error(`toast_viewport_start_timeout${stderr ? `:${stderr.trim()}` : ''}`);
}

export async function enqueueToast(
  input: ToastRequestInput | ToastRequest,
  options: ToastViewportOptions = {},
): Promise<ToastIngressReceipt> {
  if (process.platform !== 'win32') throw new Error('toast_viewport_windows_only');
  const request = createToastRequest(input);
  const paths = toastViewportPaths(options.stateRoot ?? defaultToastViewportStateRoot(options.env));
  const pid = await ensureToastViewport(options);
  await mkdir(paths.inbox, { recursive: true });
  const finalPath = join(paths.inbox, `${Date.now()}-${request.id}.json`);
  const temporaryPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(request)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, finalPath);
  return {
    schema: TOAST_INGRESS_RECEIPT_SCHEMA,
    status: 'ingress_accepted',
    request_id: request.id,
    viewport_pid: pid,
    state_root: paths.stateRoot,
    ingress_path: finalPath,
    accepted_at: new Date().toISOString(),
  };
}

export async function stopToastViewport(options: ToastViewportOptions = {}): Promise<ToastViewportStatus> {
  if (process.platform !== 'win32') throw new Error('toast_viewport_windows_only');
  const paths = toastViewportPaths(options.stateRoot ?? defaultToastViewportStateRoot(options.env));
  await runPowerShell(packageAsset('Stop-WindowToastViewport.ps1'), ['-StateRoot', paths.stateRoot]);
  await unlink(paths.pid).catch((error) => { if (errorCode(error) !== 'ENOENT') throw error; });
  return inspectToastViewport(options);
}
