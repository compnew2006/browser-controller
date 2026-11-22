/**
 * The task layer's public surface (specs/011-professional-browsing-layer).
 *
 * The registry imports the tools directly (`./tools.js`), not through
 * this barrel, so registering a tool never pulls the whole layer in.
 */
export * from './types.js';
export * from './store.js';
export * from './planner.js';
export * from './runner.js';
export * from './mutations.js';
export * from './session.js';
export * from './verify.js';
export * from './evidence.js';
export * from './questions.js';
export * from './question-store.js';
export * from './recovery.js';
export * from './reporting.js';
export * from './cancel-guard.js';
export * from './wiring.js';
export * from './task-question-route.js';
export * from './tools.js';

/**
 * Both `runner.js` and `mutations.js` export `ALLOW_MUTATIONS`,
 * `isMutatingTool` and `taskAllowsMutations`, so the star-exports above
 * drop all three as ambiguous — this explicit export is the one that
 * wins, and the barrel keeps the classification it used to re-export
 * from the runner.
 */
export { ALLOW_MUTATIONS, isMutatingTool, taskAllowsMutations } from './mutations.js';
