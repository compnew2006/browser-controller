/**
 * The type guards the memory modules share.
 *
 * These were once copied into each module that needed them, so the same check
 * could drift from one to the next and a file could accept a shape another
 * file rejects. One definition is the whole point: a guard that answers one
 * way answers one way everywhere.
 *
 * This module imports nothing, so it can be used from any memory module
 * without creating a cycle.
 */

/**
 * Is the value a plain object?
 *
 * Arrays are not records here: a JSON array is not a keyed object, so code
 * that reads `value.field` must not accept one.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
