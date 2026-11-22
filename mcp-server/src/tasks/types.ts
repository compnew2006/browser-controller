/**
 * The task engine's core types (specs/011-professional-browsing-layer, FR-001).
 *
 * One task is a goal plus constraints plus ordered steps plus evidence. A step
 * runs one MCP tool and carries the rules that verify it; the engine advances
 * only after a step's verification succeeds or its failure is recorded with
 * evidence. A pause keeps the progress: the task resumes from the same step,
 * never from the start.
 */

import type { EvidenceReport } from './evidence.js';

/**
 * The lifecycle of a task. `paused-question` waits for the user's answer,
 * `paused-login` waits for the user to complete login by takeover; both
 * resume from the step they stopped at.
 */
export type TaskState = 'planned' | 'running' | 'paused-question' | 'paused-login' | 'done' | 'failed';

/** One rule that verifies a step, applied to the page snapshot and text after the step. */
export type VerifyRule =
  | { kind: 'url-contains'; value: string }
  | { kind: 'text-present'; value: string }
  | { kind: 'element-count'; selector: string; count: number }
  | { kind: 'no-error-text'; value: string };

/**
 * The recorded outcome of one executed step. `unknown` is the outcome of a
 * step that executed but was never verified — the session expired, or the
 * call vanished with no reply — so a resume must reconcile it (re-read the
 * page and confirm whether its effect happened) before re-running it,
 * never blindly (Design §6 / Review Focus 5).
 */
export type StepStatus = 'ok' | 'failed' | 'verify-failed' | 'unknown';

export interface StepResult {
  status: StepStatus;
  /** What happened: the failure reason, or a short note on success. */
  detail?: string;
}

/** One step of a task: an MCP tool and its arguments, its verification rules, and its recorded result. */
export interface TaskStep {
  tool: string;
  params: Record<string, unknown>;
  verify: VerifyRule[];
  result?: StepResult;
}

/**
 * A task: a goal, the constraints it runs under, its ordered steps, its state, and its evidence.
 *
 * Two optional fields, both set by the composition layer (Task 8), never by the planner:
 * - `report` is the evidence report (`evidence.ts`) for the task's latest
 *   settled state — terminal (`done` / `failed`) or paused (`paused-question`
 *   / `paused-login`). It is `{ text, json }`: the same five sections as
 *   compact Arabic text and as structured JSON, built by
 *   `buildEvidenceReport` and persisted on the record by `saveTaskWithReport`
 *   (`reporting.ts`), so the popup Evidence panel (Task 9) reads it from
 *   the record instead of rebuilding it. A task that never settled has no
 *   report; a report from an earlier state is replaced, never merged, when
 *   the task settles again. The store validates the JSON shape on load, so a
 *   hand-edited report file fails closed like any other corrupt field.
 * - `sessionId` is the MCP session that started the task (the daemon's
 *   per-client session id), recorded by `browser_task_start` from the tool
 *   host. The daemon-side answer continuation (`wiring.ts`) resumes the task
 *   as that session, so steps act on tabs the session owns instead of being
 *   refused TAB_LOCKED; a task with no session resumes with no session and
 *   can only act on unowned tabs. The store accepts it as an opaque string
 *   and never invents one.
 *
 * The `EvidenceReport` import is type-only (erased at runtime): `evidence.ts`
 * defines the report shape and imports this file, so a value import here
 * would be a cycle, but a type import is not.
 */
export interface Task {
  id: string;
  goal: string;
  constraints: string[];
  steps: TaskStep[];
  state: TaskState;
  evidence: string[];
  report?: { text: string; json: EvidenceReport };
  sessionId?: string;
}
