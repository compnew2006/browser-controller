import { describe, it, expect } from 'vitest';
import { allTools, toolMap, isIdempotent, toolTimeoutMs } from '../../mcp-server/src/tools/index.js';

describe('Tool Registry', () => {
  // Single source of truth for the expected tool set. Both the count test and
  // the per-tool presence loop below derive from this list, so adding a tool
  // only requires appending its name here (no fragile hard-coded count).
  const expectedTools = [
    'browser_navigate', 'browser_click', 'browser_type', 'browser_scroll',
    'browser_press_key', 'browser_wait', 'browser_snapshot', 'browser_screenshot',
    'browser_console', 'browser_network', 'browser_tabs', 'browser_find',
    'browser_text', 'browser_hover', 'browser_select', 'browser_evaluate',
    'browser_click_text', 'browser_handle_dialog',
    'browser_upload_file', 'browser_run_action',
    'browser_drag', 'browser_fill_form',
  ];

  it(`registers every expected tool (${expectedTools.length})`, () => {
    expect(allTools.length).toBe(expectedTools.length);
  });

  it('all tools have unique names', () => {
    const names = allTools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools have description and inputSchema', () => {
    for (const tool of allTools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(typeof tool.handler).toBe('function');
    }
  });

  // Progressive disclosure: every tool must have a concise `summary` for the
  // browser_tools meta tool. Without it, search/list would return empty.
  it('all tools have a summary (progressive disclosure)', () => {
    for (const tool of allTools) {
      expect(tool.summary, `${tool.name} must have a summary`).toBeTruthy();
      expect(typeof tool.summary).toBe('string');
      expect(tool.summary.length, `${tool.name} summary should be <80 chars`).toBeLessThan(80);
      expect(tool.summary.length, `${tool.name} summary should be >10 chars`).toBeGreaterThan(10);
    }
  });

  it('toolMap contains all tools', () => {
    expect(toolMap.size).toBe(allTools.length);
    for (const tool of allTools) {
      expect(toolMap.get(tool.name)).toBe(tool);
    }
  });

  // --- Wire-name drift guard (audit C1) -------------------------------------
  // The tool's .name MUST equal the string it passes to bridge.callTool(),
  // otherwise idempotency-retry lookup silently fails and the extension's
  // dispatch needs aliases to paper over the mismatch. This previously broke
  // browser_find/browser_text. Static-source check on handler.toString().
  describe('wire name == .name (no drift)', () => {
    for (const tool of allTools) {
      it(`${tool.name} calls bridge.callTool with its own name`, () => {
        const src = tool.handler.toString();
        const calls = [...src.matchAll(/callTool\(\s*['"]([^'"]+)['"]/g)];
        expect(calls.length, `${tool.name} should call bridge.callTool exactly once`).toBe(1);
        const wireName = calls[0]![1];
        expect(wireName, `${tool.name} sends wire name "${wireName}" — must equal .name`).toBe(tool.name);
      });
    }
  });

  // --- Idempotency classification (audit M2) --------------------------------
  // Reads are retry-safe; mutating tools must NOT be. browser_console/network
  // mutate when clear:true, so they are explicitly non-idempotent.
  describe('idempotency classification', () => {
    it('marks read-only tools as idempotent', () => {
      expect(isIdempotent('browser_snapshot')).toBe(true);
      expect(isIdempotent('browser_screenshot')).toBe(true);
      expect(isIdempotent('browser_text')).toBe(true);
      expect(isIdempotent('browser_find')).toBe(true);
    });
    it('marks clear-able capture tools as NON-idempotent (clear mutates)', () => {
      expect(isIdempotent('browser_console')).toBe(false);
      expect(isIdempotent('browser_network')).toBe(false);
    });
    it('marks mutating tools as NON-idempotent', () => {
      for (const t of ['browser_click','browser_type','browser_navigate','browser_evaluate','browser_tabs','browser_scroll']) {
        expect(isIdempotent(t), `${t} must not be retried`).toBe(false);
      }
    });
  });

  // --- timeoutMs registry guard (audit M3) ----------------------------------
  // Every tool MUST declare a numeric `timeoutMs`. This is the guard that keeps
  // the registry the single source of transport-timeout truth: without it, a
  // tool that forgets `timeoutMs` silently falls back to the bridge default
  // (30s) and nobody notices until a too-short/long timeout misbehaves in
  // production. The lookup helper is total-safe, but that's no substitute for
  // every tool being explicit.
  it('every tool declares a positive numeric timeoutMs', () => {
    for (const tool of allTools) {
      expect(typeof tool.timeoutMs, `${tool.name} must declare timeoutMs`).toBe('number');
      expect(tool.timeoutMs!, `${tool.name} timeoutMs must be > 0`).toBeGreaterThan(0);
      // and the lookup helper must agree with the declared value
      expect(toolTimeoutMs(tool.name)).toBe(tool.timeoutMs);
    }
  });

  for (const name of expectedTools) {
    it(`includes ${name}`, () => {
      expect(toolMap.has(name)).toBe(true);
    });
  }
});
