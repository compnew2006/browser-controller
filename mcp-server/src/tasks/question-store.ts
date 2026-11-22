/**
 * The persisted pending questions (specs/011-professional-browsing-layer,
 * Design §5): one JSON file per asked-but-unanswered question under
 * `<tasksDir>/questions/<id>.json`.
 *
 * The task file itself cannot hold them — the Task 1 shape has no questions
 * field and the store rejects unknown fields — so they live alongside the
 * task files, on the store's own pattern: atomic replace (temp 0o600 →
 * fsync → rename), owner-only reads that refuse symbolic links, a size
 * bound, and quarantine-on-corrupt for listings. A question file is
 * deleted the moment its answer lands, so a file on disk always means a
 * task is still waiting; a daemon restart rehydrates the registry from
 * these files (`restorePendingQuestions` in `questions.ts`) instead of
 * wedging the task in `paused-question` with no way to answer it.
 */
import fsp from 'node:fs/promises';
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
import { defaultTasksDir, TaskStoreError } from './store.js';
import type { Question, QuestionContext, QuestionKind } from './questions.js';

/** A persisted question file is small — text, options and one step's params — so a file past this is corrupt, not a question. */
export const MAX_QUESTION_BYTES = 64 * 1024;

const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const QUESTION_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/u;
const QUESTION_KINDS: ReadonlySet<string> = new Set(['choice', 'confirm', 'text']);

function requireQuestionId(id: unknown): string {
  if (typeof id !== 'string' || !QUESTION_ID.test(id)) throw new TaskStoreError('a question id starts with a letter or digit and holds only letters, digits, "-" and "_"', 'invalid-argument');
  return id;
}

function questionFileName(id: string): string {
  return `${id}.json`;
}

/** The directory holding the pending-question files for one tasks directory. */
export function pendingQuestionsDir(tasksDir: string): string {
  return path.join(tasksDir, 'questions');
}

/** The question store's rule: a plain file of this user, with no access for others. */
function ownerPolicy(platform: NodeJS.Platform): OwnerModePolicy {
  return {
    fail: (message) => new TaskStoreError(message),
    notRegular: (kind) => `question ${kind} is not a regular ${kind}`,
    foreignOwner: (kind) => `question ${kind} is owned by another user`,
    openPermissions: (kind) => `question ${kind} permissions allow other users`,
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
    unavailable: 'question file is not available',
    tooLarge: 'question file is too large',
    unreadable: 'question file could not be read',
  };
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => (keys as readonly string[]).includes(key));
}

/** A file whose contents are not a question. */
function corrupt(message: string): TaskStoreError {
  return new TaskStoreError(message, 'corrupt');
}

function validateQuestionContext(raw: unknown): QuestionContext {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, ['stepIndex', 'tool', 'params']) ||
    typeof raw.stepIndex !== 'number' ||
    !Number.isSafeInteger(raw.stepIndex) ||
    raw.stepIndex < 0 ||
    typeof raw.tool !== 'string' ||
    raw.tool.length === 0 ||
    !isRecord(raw.params)
  ) {
    throw corrupt('a question context needs a step index, a tool name and params');
  }
  return { stepIndex: raw.stepIndex, tool: raw.tool, params: raw.params };
}

/** A parsed question, or an error when the record is not one. Unknown fields are rejected. */
export function validatePendingQuestion(raw: unknown): Question {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['id', 'taskId', 'text', 'options', 'kind', 'context'])) throw corrupt('a question needs id, taskId, text and kind');
  let id: string;
  try {
    id = requireQuestionId(raw.id);
  } catch (error) {
    if (error instanceof TaskStoreError) throw corrupt(error.message);
    throw error;
  }
  if (typeof raw.taskId !== 'string' || raw.taskId.length === 0) throw corrupt('a question needs a task id');
  if (typeof raw.text !== 'string' || raw.text.trim() === '') throw corrupt('a question needs text to ask');
  if (typeof raw.kind !== 'string' || !QUESTION_KINDS.has(raw.kind)) throw corrupt('a question needs a known kind');
  const question: Question = { id, taskId: raw.taskId, text: raw.text, kind: raw.kind as QuestionKind };
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options) || raw.options.some((option) => typeof option !== 'string' || option.trim() === '')) {
      throw corrupt('question options must be non-empty strings');
    }
    question.options = [...raw.options];
  }
  if (raw.context !== undefined) question.context = validateQuestionContext(raw.context);
  return question;
}

/** Persist a pending question, replacing its file atomically. */
export async function savePendingQuestion(question: Question, tasksDir: string = defaultTasksDir()): Promise<void> {
  const valid = validatePendingQuestion(question);
  const data = `${JSON.stringify(valid)}\n`;
  if (Buffer.byteLength(data) > MAX_QUESTION_BYTES) throw new TaskStoreError('a question file is limited to 64 KiB');
  await atomicWriteFile(pendingQuestionsDir(tasksDir), questionFileName(valid.id), data);
}

/** Load one pending question by id, or null when it was never persisted. A corrupt file throws instead of returning a partial question. */
export async function loadPendingQuestion(id: string, tasksDir: string = defaultTasksDir()): Promise<Question | null> {
  const validId = requireQuestionId(id);
  const file = path.join(pendingQuestionsDir(tasksDir), questionFileName(validId));
  let st;
  try {
    st = await fsp.lstat(file);
  } catch (error) {
    if (await isGoneAfterError(error, file)) return null;
    throw new TaskStoreError('question file could not be read');
  }
  if (st.size > MAX_QUESTION_BYTES) throw new TaskStoreError('question file is too large');
  const text = (await readSafeFile(file, MAX_QUESTION_BYTES, readPolicy(process.platform))).toString('utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt('question file is not valid JSON');
  }
  const question = validatePendingQuestion(raw);
  if (question.id !== validId) throw corrupt('question id does not match the file name');
  return question;
}

/** Forget a persisted question: its answer landed (or its task stopped waiting). A missing file is already forgotten. */
export async function deletePendingQuestion(id: string, tasksDir: string = defaultTasksDir()): Promise<void> {
  const validId = requireQuestionId(id);
  await fsp.rm(path.join(pendingQuestionsDir(tasksDir), questionFileName(validId)), { force: true });
}

/** Every persisted pending question. Corrupt files are quarantined and skipped; a file that cannot be read, or is too large, throws. A missing directory holds no questions. */
export async function listPendingQuestions(tasksDir: string = defaultTasksDir()): Promise<Question[]> {
  const dir = pendingQuestionsDir(tasksDir);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new TaskStoreError('question directory could not be read');
  }
  const questions: Question[] = [];
  for (const name of names.filter((entry) => QUESTION_FILE.test(entry)).sort()) {
    try {
      const question = await loadPendingQuestion(name.slice(0, -'.json'.length), tasksDir);
      if (question) questions.push(question);
    } catch (error) {
      if (error instanceof TaskStoreError && error.kind === 'corrupt') {
        await quarantineQuestionFile(dir, name);
        continue;
      }
      throw error;
    }
  }
  return questions;
}

/** Move a corrupt question file aside as `<name>.corrupt-<ms>`, so it is kept for inspection and never listed again. */
async function quarantineQuestionFile(dir: string, name: string): Promise<void> {
  try {
    await fsp.rename(path.join(dir, name), path.join(dir, quarantineName(name, Date.now())));
  } catch {
    // The listing still skips the file; the corrupt file stays where it is.
  }
}
