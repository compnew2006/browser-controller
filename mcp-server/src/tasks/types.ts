/**
 * The task engine's core types (specs/011-professional-browsing-layer, FR-001).
 *
 * One task is a goal plus constraints plus ordered steps plus evidence. A step
 * runs one MCP tool and carries the rules that verify it; the engine advances
 * only after a step's verification succeeds or its failure is recorded with
 * evidence. A pause keeps the progress: the task resumes from the same step,
 * never from the start.
 */

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

/** The recorded outcome of one executed step. */
export type StepStatus = 'ok' | 'failed' | 'verify-failed';

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

/** A task: a goal, the constraints it runs under, its ordered steps, its state, and its evidence. */
export interface Task {
  id: string;
  goal: string;
  constraints: string[];
  steps: TaskStep[];
  state: TaskState;
  evidence: string[];
}
