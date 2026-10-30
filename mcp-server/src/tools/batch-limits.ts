/**
 * Limits for browser_batch. A leaf module with no imports, so the batch tool
 * can use it without an import cycle through the tool registry (index.ts
 * imports the batch tool).
 */

/**
 * One batch step is one daemon call, and the daemon allows 120 calls per 60 s
 * per session (BC_RATE_LIMIT_PER_MIN). 50 steps fit in one window with room to
 * spare for the agent's other calls.
 */
export const BATCH_MAX_STEPS = 50;

/**
 * Time budget for one batch. No step is started after it, so a batch normally
 * returns well inside a 60 s MCP client timeout. A step already running when the
 * budget runs out still finishes (its own timeout bounds it).
 */
export const BATCH_BUDGET_MS = 50_000;

/** Longest a `ms` wait step may sleep inside the batch. Use separate waits for longer pauses. */
export const BATCH_MAX_DELAY_MS = 10_000;

/**
 * Cap on the text the whole batch may answer with. Every step's result is
 * returned, so a batch of large reads can grow the answer; past this cap the
 * later steps are cut and the cut is said out loud, so the agent knows to read
 * that step again. One browser_snapshot is 8 000 characters by default, so this
 * holds about fifteen of them.
 */
export const BATCH_MAX_OUTPUT_CHARS = 120_000;

/** Tools that must not run inside a batch: recursion, and an owner prompt that belongs to a single call. */
export const NOT_BATCHABLE = new Set(['browser_batch', 'browser_safety', 'browser_memory_policy']);

/**
 * Tools that must never receive the batch's default tabId: their tabId names
 * the tab to act on (close/focus), not the page a batch works on.
 */
export const NO_DEFAULT_TAB = new Set(['browser_tabs']);

/** Tools that take a tabId or an origin: a step that names an origin gets no default tabId. */
export const TAB_OR_ORIGIN = new Set(['browser_site_map']);
