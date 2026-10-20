/**
 * Pure intercept-rule engine (no chrome deps — unit-testable).
 * Mirrors the MCP-side zod constraints in mcp-server/src/tools/intercept.ts;
 * the wire boundary is untrusted so both ends validate (ADR-4).
 */

import { resolveTypes } from "./resource-types.js";

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
  if (rule.types !== undefined) {
    try {
      resolveTypes(rule.types);
    } catch (err) {
      throw new Error(`${where}: ${err.message}`, { cause: err });
    }
  }
  if (rule.tabIds !== undefined && !Array.isArray(rule.tabIds)) {
    throw new Error(`${where}: tabIds must be an array`);
  }
  if (rule.tabIds !== undefined && !rule.tabIds.every(Number.isInteger)) {
    throw new Error(`${where}: tabIds must be integers`);
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

// A CORS preflight belongs to the fetch/XHR it precedes.
const CDP_TO_WEBREQUEST = {
  Document: ["main_frame", "sub_frame"], XHR: ["xmlhttprequest"], Fetch: ["xmlhttprequest"], Preflight: ["xmlhttprequest"],
  Stylesheet: ["stylesheet"], Script: ["script"], Image: ["image"], Font: ["font"], Media: ["media"],
  WebSocket: ["websocket"], Ping: ["ping"], CSPViolationReport: ["csp_report"],
};

/** The webRequest type names (what rule.types holds) for a CDP resourceType. */
export function cdpResourceTypes(resourceType) {
  return CDP_TO_WEBREQUEST[resourceType] || ["other"];
}

function base64Utf8(text) {
  let bin = "";
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function looksLikeJson(text) {
  if (!/^\s*[[{]/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * Fetch.fulfillRequest params for a mock rule and the paused request:
 * rule.headers are the mock's response headers, a cross-origin caller is
 * allowed (its Origin echoed), and the CORS preflight Chrome sends before a
 * non-simple cross-origin request is answered too — it pauses like the request.
 */
export function mockFulfillParams(rule, request) {
  const sent = Object.entries(request.headers || {});
  const get = (name) => sent.find(([k]) => k.toLowerCase() === name)?.[1];
  const custom = Object.entries(rule.headers || {}).map(([name, value]) => ({ name, value: String(value) }));
  const has = (name) => custom.some((h) => h.name.toLowerCase() === name);
  const origin = get("origin");
  const cors = origin && !has("access-control-allow-origin")
    ? [{ name: "Access-Control-Allow-Origin", value: origin }, { name: "Access-Control-Allow-Credentials", value: "true" }]
    : [];
  // A cross-origin page only sees the mock's own headers when they are exposed.
  if (cors.length && custom.length && !has("access-control-expose-headers")) {
    cors.push({ name: "Access-Control-Expose-Headers", value: custom.map((h) => h.name).join(", ") });
  }
  const preflightMethod = request.method === "OPTIONS" && get("access-control-request-method");
  if (preflightMethod) {
    const asked = get("access-control-request-headers");
    return {
      responseCode: 204,
      responseHeaders: [...cors, ...custom.filter((h) => /^access-control-/i.test(h.name)),
        ...(has("access-control-allow-methods") ? [] : [{ name: "Access-Control-Allow-Methods", value: preflightMethod }]),
        ...(asked && !has("access-control-allow-headers") ? [{ name: "Access-Control-Allow-Headers", value: asked }] : [])],
    };
  }
  const body = rule.mockBody ?? "";
  const type = has("content-type") ? [] : [{ name: "Content-Type", value: looksLikeJson(body) ? "application/json" : "text/plain; charset=utf-8" }];
  return { responseCode: rule.mockStatus ?? 200, responseHeaders: [...type, ...cors, ...custom], body: base64Utf8(body) };
}

/** Scope key for storage: global or sorted tab list. */
export function scopeKey(tabIds) {
  if (!tabIds || tabIds.length === 0) return "global";
  // Deduplicated: two rules for tab 15 are scope "tabs:15", not "tabs:15,15".
  return `tabs:${[...new Set(tabIds)].sort((a, b) => a - b).join(",")}`;
}
