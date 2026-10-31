import { describe, expect, it } from 'vitest';
import { toolMap } from '../mcp-server/src/tools/registry.js';
import { TOOL_NAMES } from '../mcp-server/src/protocol/tool-names.js';
import { DAEMON_ONLY_WIRE_TOOLS, isKnownWireTool } from '../mcp-server/src/protocol/wire-tools.js';

/**
 * The tool names of the wire are generated, not written by hand.
 *
 * The registry is the single source of truth; protocol/tool-names.ts is a
 * generated copy of it, and the wire layer checks a name against that copy
 * instead of importing the tools layer. This test is what makes the copy
 * impossible to let drift: a tool added to the registry without regenerating
 * the file (or a file edited by hand) fails here.
 */
describe('the generated tool-name list', () => {
  it('holds exactly the registry names, sorted, with no stale entry', () => {
    const registryNames = [...toolMap.keys()].sort();
    expect([...TOOL_NAMES]).toEqual(registryNames);
  });

  it('is sorted and free of duplicates', () => {
    expect([...TOOL_NAMES]).toEqual([...TOOL_NAMES].sort());
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it('lets every registered name through the wire allow-list', () => {
    for (const name of TOOL_NAMES) {
      expect(isKnownWireTool(name), name).toBe(true);
    }
  });

  it('still refuses the daemon-only action, unknown names and non-strings', () => {
    expect(DAEMON_ONLY_WIRE_TOOLS.has('browser_memory_internal_context')).toBe(true);
    expect(isKnownWireTool('browser_memory_internal_context')).toBe(false);
    for (const name of ['browser_nope', '', 'constructor', '__proto__', undefined, 42]) {
      expect(isKnownWireTool(name), String(name)).toBe(false);
    }
  });
});
