/**
 * The type guards the server shares, in the neutral layer.
 *
 * These were once copied into each module that needed them, so the same check
 * could drift from one to the next and a file could accept a shape another
 * file rejects. One definition is the whole point: a guard that answers one
 * way answers one way everywhere.
 *
 * They used to live under memory/, which made the vault layer depend on the
 * memory layer for a check that has nothing to do with either. They live here
 * now so both layers can use them without either one depending on the other.
 *
 * This module imports nothing, so it can be used from any module
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
