import { z } from 'zod';
import { failureResult, rawResultOf } from './types.js';
import type { ToolHost, ToolResult } from './types.js';

export type SafetyAction = 'allow' | 'ask' | 'block';

export interface SafetySettings {
  enabled: boolean;
  defaultAction: SafetyAction;
  siteRules: Array<{ site: string; action: SafetyAction }>;
}

interface SafetyController {
  confirm(details: { categories: string[]; site: string; tool: string; target?: string }): Promise<'approved' | 'declined' | 'unavailable'>;
}

/** Results refused by the safety gate: nothing was dispatched, so the action wrapper gives them a not_dispatched receipt. */
const gateRefusals = new WeakSet<ToolResult>();

function refuse(message: string): ToolResult {
  const result = failureResult(message);
  gateRefusals.add(result);
  return result;
}

const settingsByHost = new WeakMap<ToolHost, SafetySettings>();
const controllerByHost = new WeakMap<ToolHost, SafetyController>();

export function attachSafetyController(host: ToolHost, controller: SafetyController): void {
  controllerByHost.set(host, controller);
  settingsByHost.set(host, { enabled: false, defaultAction: 'ask', siteRules: [] });
}

export function setSafetySettings(host: ToolHost, settings: SafetySettings): void {
  settingsByHost.set(host, {
    ...settings,
    siteRules: settings.siteRules.map((rule) => ({ ...rule, site: rule.site.toLowerCase() })),
  });
}

export function getSafetySettings(host: ToolHost): SafetySettings {
  const settings = settingsByHost.get(host);
  return settings ? { ...settings, siteRules: settings.siteRules.map((rule) => ({ ...rule })) }
    : { enabled: false, defaultAction: 'ask', siteRules: [] };
}

function classificationParams(tool: string, params: Record<string, unknown>): Record<string, unknown> {
  const common: Record<string, unknown> = { tabId: params.tabId, action: tool };
  if (params.target !== undefined) common.target = params.target;
  if (tool === 'browser_click' && params.dragTo !== undefined) common.dragTo = params.dragTo;
  if (tool === 'browser_click' && params.hover === true) common.hover = true;
  if (tool === 'browser_type') {
    if (params.submit === true) common.submit = true;
    if (typeof params.key === 'string') common.key = params.key;
  }
  if (tool === 'browser_fill' && Array.isArray(params.fields)) {
    common.fields = params.fields.map((field) => ({ target: (field as { target?: unknown })?.target }));
  }
  return common;
}

function targetSummary(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 160);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const target = value as { role?: unknown; name?: unknown; nth?: unknown };
  if (typeof target.role !== 'string' || typeof target.name !== 'string') return undefined;
  const nth = Number.isSafeInteger(target.nth) && (target.nth as number) >= 0 ? ` nth=${target.nth}` : '';
  return `role=${target.role} name=${JSON.stringify(target.name)}${nth}`.slice(0, 160);
}

interface Classification {
  site: string;
  categories: string[];
  fingerprint: string;
}

async function classify(host: ToolHost, tool: string, params: Record<string, unknown>): Promise<Classification> {
  // Page JS cannot be classified. Ask the classifier for the tab's host only (the extension probes no
  // element for browser_evaluate), and treat every evaluate as one category: the site's effective action.
  const evaluating = tool === 'browser_evaluate';
  const raw = await host.callTool('browser_classify_action', evaluating ? { tabId: params.tabId, action: 'browser_evaluate' } : classificationParams(tool, params)) as Record<string, unknown>;
  if (raw?.success !== true || typeof raw.site !== 'string' || !Array.isArray(raw.categories)) {
    throw new Error(typeof raw?.error === 'string' ? raw.error : 'classifier returned an invalid result');
  }
  return {
    site: raw.site.toLowerCase(),
    categories: evaluating ? ['evaluate'] : raw.categories.filter((value): value is string => typeof value === 'string'),
    fingerprint: evaluating ? '[]' : JSON.stringify(Array.isArray(raw.fingerprints) ? raw.fingerprints.filter((value) => typeof value === 'string') : []),
  };
}

/** Run before dispatch. The classifier receives targets and action kinds only, never field values. */
export async function enforceActionSafety(
  host: ToolHost,
  tool: string,
  params: Record<string, unknown>,
): Promise<ToolResult | null> {
  const settings = getSafetySettings(host);
  if (!settings.enabled || (tool === 'browser_click' && params.hover === true)) return null;

  let classification: Classification;
  try {
    classification = await classify(host, tool, params);
  } catch (error) {
    return refuse(`SAFETY_CHECK_FAILED: ${error instanceof Error ? error.message : String(error)}; no action was dispatched.`);
  }
  if (classification.categories.length === 0) return null;

  const rule = settings.siteRules.find((item) => item.site === classification.site);
  const decision = rule?.action ?? settings.defaultAction;
  if (decision === 'allow') return null;
  if (decision === 'block') {
    return refuse(`ACTION_BLOCKED: safety policy blocks ${classification.categories.join(', ')} on ${classification.site}; no action was dispatched.`);
  }

  const controller = controllerByHost.get(host);
  if (!controller) return refuse('CLIENT_CONFIRMATION_UNAVAILABLE: no confirmation channel is available; no action was dispatched.');
  let confirmation: 'approved' | 'declined' | 'unavailable';
  try {
    const fillTargets = tool === 'browser_fill' && Array.isArray(params.fields)
      ? params.fields.map((field) => targetSummary((field as { target?: unknown })?.target)).filter((value): value is string => value !== undefined).join(', ')
      : undefined;
    const requestedTarget = targetSummary(params.target);
    confirmation = await controller.confirm({
      categories: classification.categories,
      site: classification.site,
      tool,
      ...(requestedTarget ? { target: requestedTarget }
        : fillTargets ? { target: fillTargets.slice(0, 160) } : {}),
    });
  } catch {
    confirmation = 'unavailable';
  }
  if (confirmation === 'unavailable') {
    return refuse('CLIENT_CONFIRMATION_UNAVAILABLE: this MCP client cannot ask for confirmation; no action was dispatched.');
  }
  if (confirmation !== 'approved') {
    return refuse(`ACTION_NOT_CONFIRMED: ${classification.categories.join(', ')} on ${classification.site} was declined or dismissed; no action was dispatched.`);
  }

  // A page can change while the confirmation UI is open. Recheck the category and
  // host immediately before dispatch, and refuse if the requested action changed.
  try {
    const current = await classify(host, tool, params);
    const before = [...classification.categories].sort().join(',');
    const after = [...current.categories].sort().join(',');
    if (current.site !== classification.site || after !== before || current.fingerprint !== classification.fingerprint) {
      return refuse('SAFETY_TARGET_CHANGED: the page action changed while confirmation was open; no action was dispatched. Review the page and try again.');
    }
  } catch (error) {
    return refuse(`SAFETY_CHECK_FAILED: ${error instanceof Error ? error.message : String(error)}; no action was dispatched.`);
  }
  return null;
}

export const actionOptionsShape = {
  observe: z.enum(['diff']).optional(),
  expect: z.object({
    urlIncludes: z.string().optional(),
    textIncludes: z.string().optional(),
  }).strict().optional(),
};

interface Snapshot {
  text: string;
  url?: string;
  truncated: boolean;
}

async function snapshot(host: ToolHost, tabId: number): Promise<Snapshot> {
  const raw = await host.callTool('browser_snapshot', { tabId, maxChars: 50_000 }) as Record<string, unknown>;
  if (raw?.success !== true || typeof raw.text !== 'string') {
    throw new Error(typeof raw?.error === 'string' ? raw.error : 'browser_snapshot did not return page text');
  }
  return {
    text: raw.text,
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    truncated: raw.truncated === true,
  };
}

function diff(before: Snapshot, after: Snapshot): Record<string, unknown> {
  const oldLines = before.text.split('\n').filter(Boolean);
  const newLines = after.text.split('\n').filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((line) => !oldSet.has(line));
  const removed = oldLines.filter((line) => !newSet.has(line));
  return {
    added: added.slice(0, 20).map((line) => line.slice(0, 300)),
    removed: removed.slice(0, 20).map((line) => line.slice(0, 300)),
    truncated: before.truncated || after.truncated || added.length > 20 || removed.length > 20,
  };
}

export function summaryOf(result: ToolResult): string {
  const item = result.content.find((part) => part.type === 'text');
  if (!result.isError) return 'completed';
  const firstLine = item?.type === 'text' ? item.text.split('\n', 1)[0] : '';
  const code = /^([A-Z][A-Z0-9_]+):/.exec(firstLine)?.[1];
  return code ? `failed (${code})` : 'failed';
}

export function withReceipt(result: ToolResult, tool: string, receipt: Record<string, unknown>, success: boolean): ToolResult {
  return {
    ...result,
    structuredContent: { success, receipt: { tool, ...receipt } },
  };
}

/** Preserve the legacy text content while adding a safe, machine-readable action receipt. */
export function actionHandler(
  tool: string,
  handler: (host: ToolHost, params: Record<string, unknown>) => Promise<ToolResult>,
  options: { safety?: boolean } = {},
) {
  const wrapped = async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
    const { expect, observe, ...actionParams } = params;
    const tabId = actionParams.tabId as number;
    const wantsObservation = observe === 'diff';
    const wanted = expect as { urlIncludes?: string; textIncludes?: string } | undefined;
    let before: Snapshot | undefined;

    const expectedValues = wanted ? [wanted.urlIncludes, wanted.textIncludes].filter((value): value is string => value !== undefined) : [];
    if (wanted && (expectedValues.length === 0 || expectedValues.some((value) => value.length === 0))) {
      const failed = failureResult('INVALID_ARGUMENT: expect needs a non-empty urlIncludes or textIncludes value');
      return withReceipt(failed, tool, { status: 'not_dispatched', reason: 'invalid_expectation' }, false);
    }

    if (wantsObservation) {
      try {
        before = await snapshot(host, tabId);
      } catch (error) {
        const failed = failureResult(`OBSERVATION_FAILED: ${error instanceof Error ? error.message : String(error)}; no action was dispatched.`);
        return withReceipt(failed, tool, { status: 'not_dispatched', reason: 'before_snapshot_failed' }, false);
      }
    }

    const blocked = options.safety === false ? null : await enforceActionSafety(host, tool, actionParams);
    if (blocked) {
      return withReceipt(blocked, tool, { status: 'not_dispatched', summary: summaryOf(blocked) }, false);
    }

    // A dispatch error keeps its upstream coding (INTERNAL_ERROR for a message with no CODE:)
    // and stays a throw, so browser_batch can resend a rate-limited step. A failed result
    // (isError) still gets its receipt below.
    const result = await handler(host, actionParams);
    // The handler ran its own gate check (browser_fill checks files first) and refused.
    if (gateRefusals.has(result)) {
      return withReceipt(result, tool, { status: 'not_dispatched', summary: summaryOf(result) }, false);
    }
    const raw = rawResultOf(result) ?? {};
    let after: Snapshot | undefined;
    if (wantsObservation || wanted) {
      try {
        after = await snapshot(host, tabId);
      } catch {
        // The browser action already ran. Report the missing observation without converting
        // a successful action into a retry-looking error unless an expectation needs it.
      }
    }

    const checks: Record<string, boolean> = {};
    if (after && wanted?.urlIncludes !== undefined) checks.urlIncludes = !!after.url?.includes(wanted.urlIncludes);
    if (after && wanted?.textIncludes !== undefined) checks.textIncludes = after.text.includes(wanted.textIncludes);
    const expectPassed = Object.values(checks).every(Boolean);
    const expectFailed = !!wanted && !!after && !expectPassed;
    const expectUnavailable = !!wanted && !after;
    let output = result;
    if ((expectFailed || expectUnavailable) && !result.isError) {
      const code = expectUnavailable ? 'EXPECTATION_UNAVAILABLE' : 'EXPECTATION_FAILED';
      const message = expectUnavailable
        ? 'the action completed, but the postcondition could not be checked; do not repeat it without checking the page.'
        : 'the action completed, but the requested postcondition did not match; do not repeat it without checking the page.';
      output = {
        ...result,
        isError: true,
        content: result.content.map((part) => part.type === 'text'
          ? { ...part, text: `${code.toUpperCase()}: ${message}\n${part.text}` }
          : part),
      };
    }

    const observation = wantsObservation
      ? (before && after ? { kind: 'diff', ...diff(before, after) } : { kind: 'diff', status: 'unavailable' })
      : undefined;
    const receipt: Record<string, unknown> = {
      status: output.isError ? (expectUnavailable ? 'expectation_unavailable' : expectFailed ? 'expectation_failed' : 'error') : 'completed',
      summary: summaryOf(result),
      ...(typeof raw.url === 'string' ? { urlChanged: before ? before.url !== raw.url : undefined } : {}),
      ...(wanted ? { expect: { passed: !!after && expectPassed, checks, ...(expectUnavailable ? { status: 'observation_unavailable' } : {}) } } : {}),
      ...(observation ? { observation } : {}),
    };
    return withReceipt(output, tool, receipt, !output.isError);
  };
  (wrapped as typeof wrapped & { toolName?: string }).toolName = tool;
  return wrapped;
}
