import { z } from 'zod';
/**
 * Reusable `tabId` schema fields. Plan task 1.1: every page-interaction tool
 * MUST target a specific tab (the agent gets the id from `browser_tabs list`)
 * so the active tab the user is looking at never gets hijacked.
 */
export const tabIdParam = z
    .number()
    .int()
    .describe('Target tab id (from browser_tabs list). Actions apply to THIS tab, not the active tab.');
/** Mandatory tabId (click/type/snapshot/…). */
export function requireTabId() {
    return tabIdParam;
}
/** Optional tabId — for tools like navigate where "active tab" is still acceptable. */
export function optionalTabId() {
    return tabIdParam.optional().describe('Target tab id. If omitted, uses the active tab.');
}
export function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
export function errorResult(message) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
export function imageResult(base64, mimeType = 'image/png') {
    return { content: [{ type: 'image', data: base64, mimeType }] };
}
//# sourceMappingURL=types.js.map