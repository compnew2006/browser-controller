/**
 * Tool-argument validation: the payload size ceilings and zod issue formatting
 * that turn a bad call into one `INVALID_ARGUMENT: …` line for the agent.
 *
 * Lives apart from register-tools.ts (which owns the MCP server wiring) so a
 * tool implementation can validate a sub-call without importing the bootstrap.
 */
import { z } from 'zod';
import { unknownParameterHint } from './types.js';
import type { ToolDefinition } from './types.js';

const MAX_TOOL_ARGUMENT_BYTES = 1_000_000;
const MAX_TOOL_STRING_CHARS = 200_000;
const MAX_TOOL_ARRAY_ITEMS = 1_000;

function checkPayloadLimits(value: unknown, ctx: z.RefinementCtx, path: Array<string | number> = []): void {
  if (typeof value === 'string') {
    if (value.length > MAX_TOOL_STRING_CHARS) {
      ctx.addIssue({
        code: 'too_big',
        maximum: MAX_TOOL_STRING_CHARS,
        origin: 'string',
        inclusive: true,
        path,
        message: `String exceeds ${MAX_TOOL_STRING_CHARS} characters`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_TOOL_ARRAY_ITEMS) {
      ctx.addIssue({
        code: 'too_big',
        maximum: MAX_TOOL_ARRAY_ITEMS,
        origin: 'array',
        inclusive: true,
        path,
        message: `Array exceeds ${MAX_TOOL_ARRAY_ITEMS} items`,
      });
    }
    value.forEach((item, index) => checkPayloadLimits(item, ctx, [...path, index]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      checkPayloadLimits(child, ctx, [...path, key]);
    }
  }
}

const payloadLimitsSchema = z.unknown().superRefine((value, ctx) => {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Arguments must be JSON-serializable' });
    return;
  }
  if (bytes > MAX_TOOL_ARGUMENT_BYTES) {
    ctx.addIssue({
      code: 'too_big',
      maximum: MAX_TOOL_ARGUMENT_BYTES,
      origin: 'string',
      inclusive: true,
      message: `Arguments exceed ${MAX_TOOL_ARGUMENT_BYTES} bytes`,
    });
  }
  checkPayloadLimits(value, ctx);
});

type ZodIssue = z.ZodError['issues'][number];

/** What a missing required parameter needs beyond "is required" (one small map for the whole server). */
const REQUIRED_HINTS: Record<string, string> = {
  tabId: 'Call browser_tabs {action:"list"} first.',
};

const pathText = (path: PropertyKey[]): string => path.reduce<string>(
  (text, part, i) => (typeof part === 'number' ? `${text}[${part}]` : i === 0 ? String(part) : `${text}.${String(part)}`),
  '',
);

const valueAt = (params: unknown, path: PropertyKey[]): unknown => path.reduce<unknown>(
  (value, key) => (value && typeof value === 'object' ? (value as Record<PropertyKey, unknown>)[key] : undefined),
  params,
);

/** One short line per zod issue, as the agent reads it. */
function describeIssue(issue: ZodIssue, params: unknown): string[] {
  if (issue.code === 'unrecognized_keys') {
    const at = pathText(issue.path);
    return issue.keys.map((key) => {
      const hint = unknownParameterHint(key);
      return `unknown parameter ${key}${at ? ` in ${at}` : ''}${hint ? ` (${hint})` : ''}`;
    });
  }
  const field = pathText(issue.path) || 'arguments';
  // A union (target: string | {role,name,nth}) reports a missing value as invalid_union and an
  // enum as invalid_value, so the absent value — not the issue code — says "is required".
  if (valueAt(params, issue.path) === undefined) {
    const hint = REQUIRED_HINTS[field];
    return [`${field} is required${hint ? `. ${hint}` : ''}`];
  }
  const reason = issue.message.replace(/^Invalid input: /, '');
  return [reason.startsWith(`${field} `) ? reason : `${field}: ${reason}`];
}

/**
 * Validate a call's arguments against the tool's schema and the payload limits. A failure is one
 * `INVALID_ARGUMENT: …` error: `field is required`, `field: reason`, or `unknown parameter name`.
 */
export function parseToolParams(tool: ToolDefinition, params: Record<string, unknown>): Record<string, unknown> {
  try {
    payloadLimitsSchema.parse(params);
    return tool.inputSchema.parse(params) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const problems = err.issues.flatMap((issue) => describeIssue(issue, params));
      // An unknown top-level name: list the tool's own, so the first retry is right.
      if (err.issues.some((issue) => issue.code === 'unrecognized_keys' && issue.path.length === 0)) {
        problems.push(`${tool.name} takes: ${Object.keys(tool.inputSchema.shape).join(', ')}`);
      }
      throw new Error(`INVALID_ARGUMENT: ${problems.join('; ')}`, { cause: err });
    }
    throw err;
  }
}

/** Read the tool's borrowed names (ToolDefinition.normalize), then validate: the params and the result's note lines. */
export function prepareToolParams(tool: ToolDefinition, params: Record<string, unknown>): { params: Record<string, unknown>; notes: string[] } {
  const read = tool.normalize ? tool.normalize(params) : { params, notes: [] };
  return { params: parseToolParams(tool, read.params), notes: read.notes };
}
