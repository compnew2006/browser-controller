/**
 * Pure intercept-rule engine (no chrome deps — unit-testable).
 * Mirrors the MCP-side zod constraints in mcp-server/src/tools/intercept.ts;
 * the wire boundary is untrusted so both ends validate (ADR-4).
 */

export const MAX_RULES = 50;
export const MAX_MATCH_LEN = 500;
export const MAX_MOCK_BODY = 20_000;

const VALID_ACTIONS = new Set(["log", "block", "redirect", "header", "mock"]);

/** Validate one rule; throws an actionable Error on the first problem. */
export function validateRule(rule, index = 0) {
  const where = `rules[${index}]`;
  if (!rule || typeof rule !== "object")
    throw new Error(`${where}: rule must be an object`);
  if (
    rule.id !== undefined &&
    (typeof rule.id !== "string" || rule.id.length < 1 || rule.id.length > 64)
  ) {
    throw new Error(`${where}: id must be a 1-64 char string`);
  }
  if (
    typeof rule.match !== "string" ||
    rule.match.length < 1 ||
    rule.match.length > MAX_MATCH_LEN
  ) {
    throw new Error(`${where}: match must be a 1-${MAX_MATCH_LEN} char regex`);
  }
  if (rule.match.trim() === ".*" || rule.match.trim() === ".+") {
    throw new Error(
      `${where}: match-all patterns are rejected (scope your rule)`,
    );
  }
  try {
    new RegExp(rule.match);
  } catch (err) {
    throw new Error(`${where}: invalid match regex: ${err?.message || err}`, { cause: err });
  }
  if (!VALID_ACTIONS.has(rule.action)) {
    throw new Error(
      `${where}: action must be one of log|block|redirect|header|mock`,
    );
  }
  if (rule.action === "redirect" && typeof rule.redirectUrl !== "string") {
    throw new Error(`${where}: redirect rules require redirectUrl`);
  }
  if (rule.mockBody !== undefined && rule.mockBody.length > MAX_MOCK_BODY) {
    throw new Error(`${where}: mockBody exceeds ${MAX_MOCK_BODY} chars`);
  }
  if (rule.types !== undefined && !Array.isArray(rule.types)) {
    throw new Error(`${where}: types must be an array`);
  }
  if (rule.tabIds !== undefined && !Array.isArray(rule.tabIds)) {
    throw new Error(`${where}: tabIds must be an array`);
  }
  return rule;
}

/** Validate a rule set (cap + per-rule). Returns the rules unchanged. */
export function validateRuleSet(rules) {
  if (!Array.isArray(rules)) throw new Error("rules must be an array");
  if (rules.length > MAX_RULES)
    throw new Error(`Too many rules: ${rules.length} > ${MAX_RULES}`);
  const seen = new Set();
  rules.forEach((r, i) => {
    validateRule(r, i);
    const id = r.id ?? `r${i + 1}`;
    if (seen.has(id)) throw new Error(`Duplicate rule id: ${id}`);
    seen.add(id);
  });
  return rules;
}

/** Does a rule match this request? Disabled rules never match. */
export function matchRule(rule, { url, type, tabId }) {
  if (rule.enabled === false) return false;
  if (rule.tabIds && tabId != null && !rule.tabIds.includes(tabId))
    return false;
  if (rule.types && type != null && !rule.types.includes(type)) return false;
  try {
    return new RegExp(rule.match).test(url);
  } catch {
    return false;
  }
}

/** All matching rules for a request, in order. */
export function evaluateRules(rules, req) {
  return (rules || []).filter((r) => matchRule(r, req));
}

/** Scope key for storage: global or sorted tab list. */
export function scopeKey(tabIds) {
  if (!tabIds || tabIds.length === 0) return "global";
  // Deduplicated: two rules for tab 15 are scope "tabs:15", not "tabs:15,15".
  return `tabs:${[...new Set(tabIds)].sort((a, b) => a - b).join(",")}`;
}
