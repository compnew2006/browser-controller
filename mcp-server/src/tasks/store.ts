/**
 * The task store: one atomically replaced JSON file per task under
 * `<stateDir>/tasks/<id>.json`, where `<stateDir>` is the project's current
 * state path (`BC_STATE_DIR`, or `~/.browser-controller` — the same
 * `STATE_DIR` `mcp-server/src/daemon-config.ts` defines).
 *
 * The mechanics come from `core/json-store.ts`: the file is written to a temp
 * file (0o600) in the same directory, fsynced, and renamed over the target,
 * and reads refuse symbolic links and files other users may reach. A task
 * file that fails validation fails closed: `loadTask` throws, `listTasks`
 * quarantines it (`<id>.json.corrupt-<ms>`) and skips it. A file that cannot
 * be read, or is too large, throws from both — `listTasks` never silently
 * drops a task the process cannot read. Only the store's own directory is
 * created (0o700); the caller passes an explicit directory in tests so
 * nothing touches the real state.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertOwnerOnly,
  atomicWriteFile,
  errorCode,
  isGoneAfterError,
  quarantineName,
  readSafeFile,
  type OwnerModePolicy,
  type SafeReadPolicy,
} from '../core/json-store.js';
import { isRecord } from '../core/guards.js';
import type { StepResult, Task, TaskState, TaskStep, VerifyRule } from './types.js';

/**
 * The task store's own error: an invalid id, a corrupt file, or an unreadable
 * directory. The kind is what `listTasks` decides on: only `corrupt` files are
 * skipped (and quarantined); `unavailable` and `invalid-argument` are rethrown,
 * so a listing never silently drops a task the process cannot read.
 */
export type TaskStoreErrorKind = 'corrupt' | 'unavailable' | 'invalid-argument';

export class TaskStoreError extends Error {
  readonly kind: TaskStoreErrorKind;
  constructor(message: string, kind: TaskStoreErrorKind = 'unavailable') {
    super(message);
    this.name = 'TaskStoreError';
    this.kind = kind;
  }
}

/** A file whose contents are not a task. */
function corrupt(message: string): TaskStoreError {
  return new TaskStoreError(message, 'corrupt');
}

/** A task file is small — a goal, constraints, steps and evidence — so a file past this is corrupt, not a task. */
export const MAX_TASK_BYTES = 256 * 1024;

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TASK_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/u;

const TASK_STATES: ReadonlySet<string> = new Set(['planned', 'running', 'paused-question', 'paused-login', 'done', 'failed']);
const STEP_STATUSES: ReadonlySet<string> = new Set(['ok', 'failed', 'verify-failed', 'unknown']);
const VERIFY_KINDS: ReadonlySet<string> = new Set(['url-contains', 'text-present', 'element-count', 'no-error-text']);

/** The project's current state path for tasks. The caller may pass an explicit directory instead. */
export function defaultTasksDir(): string {
  const stateDir = process.env.BC_STATE_DIR ?? path.join(os.homedir(), '.browser-controller');
  return path.join(stateDir, 'tasks');
}

function taskFileName(id: string): string {
  return `${id}.json`;
}

function requireTaskId(id: unknown): string {
  if (typeof id !== 'string' || !TASK_ID.test(id)) throw new TaskStoreError('a task id starts with a letter or digit and holds only letters, digits, "-" and "_"', 'invalid-argument');
  return id;
}

/** The task store's rule: a plain file of this user, with no access for others. */
function ownerPolicy(platform: NodeJS.Platform): OwnerModePolicy {
  return {
    fail: (message) => new TaskStoreError(message),
    notRegular: (kind) => `task ${kind} is not a regular ${kind}`,
    foreignOwner: (kind) => `task ${kind} is owned by another user`,
    openPermissions: (kind) => `task ${kind} permissions allow other users`,
    // win32 has no comparable mode bits, so the rule cannot be checked there.
    checkOwner: platform !== 'win32',
  };
}

function readPolicy(platform: NodeJS.Platform): SafeReadPolicy {
  const policy = ownerPolicy(platform);
  return {
    fail: (message) => new TaskStoreError(message),
    isOwnError: (error) => error instanceof TaskStoreError,
    check: (stat, kind) => assertOwnerOnly(stat, kind, policy),
    unavailable: 'task file is not available',
    tooLarge: 'task file is too large',
    unreadable: 'task file could not be read',
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => (keys as readonly string[]).includes(key));
}

function validateVerifyRule(raw: unknown): VerifyRule {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || !VERIFY_KINDS.has(raw.kind)) throw corrupt('a verify rule needs a known kind');
  switch (raw.kind) {
    case 'url-contains':
    case 'text-present':
    case 'no-error-text':
      if (!hasOnlyKeys(raw, ['kind', 'value']) || typeof raw.value !== 'string') throw corrupt('a verify rule needs a string value');
      return { kind: raw.kind, value: raw.value };
    case 'element-count':
      if (!hasOnlyKeys(raw, ['kind', 'selector', 'count']) || typeof raw.selector !== 'string' || typeof raw.count !== 'number' || !Number.isSafeInteger(raw.count) || raw.count < 0) {
        throw corrupt('an element-count rule needs a selector and a non-negative count');
      }
      return { kind: 'element-count', selector: raw.selector, count: raw.count };
    default:
      throw corrupt('a verify rule needs a known kind');
  }
}

function validateStepResult(raw: unknown): StepResult {
  if (!isRecord(raw) || typeof raw.status !== 'string' || !STEP_STATUSES.has(raw.status) || !hasOnlyKeys(raw, ['status', 'detail'])) {
    throw corrupt('a step result needs a known status');
  }
  if (raw.detail !== undefined && typeof raw.detail !== 'string') throw corrupt('a step result detail must be a string');
  return raw.detail === undefined ? { status: raw.status as StepResult['status'] } : { status: raw.status as StepResult['status'], detail: raw.detail };
}

function validateStep(raw: unknown): TaskStep {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['tool', 'params', 'verify', 'result'])) throw corrupt('a task step needs tool, params and verify');
  if (typeof raw.tool !== 'string' || raw.tool.length === 0) throw corrupt('a task step needs a tool name');
  if (!isRecord(raw.params)) throw corrupt('task step params must be an object');
  if (!Array.isArray(raw.verify)) throw corrupt('task step verify must be a list of rules');
  const step: TaskStep = { tool: raw.tool, params: raw.params, verify: raw.verify.map(validateVerifyRule) };
  if (raw.result !== undefined) step.result = validateStepResult(raw.result);
  return step;
}

/** A parsed task, or an error when the record is not a task. Unknown fields are rejected, so a file written by a newer shape never loads as an old one. */
export function validateTask(raw: unknown): Task {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['id', 'goal', 'constraints', 'steps', 'state', 'evidence'])) throw corrupt('a task needs id, goal, constraints, steps, state and evidence');
  // A stored id that fails validation is file-content corruption, not a
  // caller error: `requireTaskId` throws 'invalid-argument' for a
  // caller-supplied id, so only this call site translates it to 'corrupt'.
  // `loadTask`/`saveTask` still call `requireTaskId` directly on the id the
  // caller passes, and that failure stays 'invalid-argument'.
  let id: string;
  try {
    id = requireTaskId(raw.id);
  } catch (error) {
    if (error instanceof TaskStoreError) throw corrupt(error.message);
    throw error;
  }
  if (typeof raw.goal !== 'string' || raw.goal.length === 0) throw corrupt('a task needs a goal');
  if (!isStringArray(raw.constraints)) throw corrupt('task constraints must be a list of strings');
  if (!Array.isArray(raw.steps)) throw corrupt('task steps must be a list');
  if (typeof raw.state !== 'string' || !TASK_STATES.has(raw.state)) throw corrupt('a task needs a known state');
  if (!isStringArray(raw.evidence)) throw corrupt('task evidence must be a list of strings');
  return {
    id,
    goal: raw.goal,
    constraints: [...raw.constraints],
    steps: raw.steps.map(validateStep),
    state: raw.state as TaskState,
    evidence: [...raw.evidence],
  };
}

/** Save a task, replacing its file atomically. Saving the same id again replaces the previous record. */
export async function saveTask(task: Task, tasksDir: string = defaultTasksDir()): Promise<void> {
  const valid = validateTask(task);
  const data = `${JSON.stringify(valid)}\n`;
  if (Buffer.byteLength(data) > MAX_TASK_BYTES) throw new TaskStoreError('a task file is limited to 256 KiB');
  await atomicWriteFile(tasksDir, taskFileName(valid.id), data);
}

/** Load one task by id, or null when it was never saved. A corrupt file throws instead of returning a partial task. */
export async function loadTask(id: string, tasksDir: string = defaultTasksDir()): Promise<Task | null> {
  const validId = requireTaskId(id);
  const file = path.join(tasksDir, taskFileName(validId));
  let st;
  try {
    st = await fsp.lstat(file);
  } catch (error) {
    if (await isGoneAfterError(error, file)) return null;
    throw new TaskStoreError('task file could not be read');
  }
  if (st.size > MAX_TASK_BYTES) throw new TaskStoreError('task file is too large');
  const text = (await readSafeFile(file, MAX_TASK_BYTES, readPolicy(process.platform))).toString('utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt('task file is not valid JSON');
  }
  const task = validateTask(raw);
  if (task.id !== validId) throw corrupt('task id does not match the file name');
  return task;
}

/** Every saved task, by id. Corrupt files are quarantined and skipped; a file that cannot be read, or is too large, throws — the same convention as the map store's `listMaps`, which skips only `MEMORY_CORRUPT`. A directory that cannot be read throws. */
export async function listTasks(tasksDir: string = defaultTasksDir()): Promise<Task[]> {
  let names: string[];
  try {
    names = await fsp.readdir(tasksDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new TaskStoreError('task directory could not be read');
  }
  const tasks: Task[] = [];
  for (const name of names.filter((entry) => TASK_FILE.test(entry)).sort()) {
    try {
      const task = await loadTask(name.slice(0, -'.json'.length), tasksDir);
      if (task) tasks.push(task);
    } catch (error) {
      if (error instanceof TaskStoreError && error.kind === 'corrupt') {
        await quarantineTaskFile(tasksDir, name);
        continue;
      }
      throw error;
    }
  }
  return tasks;
}

/** Move a corrupt task file aside as `<name>.corrupt-<ms>`, so it is kept for inspection and never listed again. */
async function quarantineTaskFile(tasksDir: string, name: string): Promise<void> {
  try {
    await fsp.rename(path.join(tasksDir, name), path.join(tasksDir, quarantineName(name, Date.now())));
  } catch {
    // The listing still skips the file; the corrupt file stays where it is.
  }
}
