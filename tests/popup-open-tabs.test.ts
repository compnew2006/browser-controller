import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  agentLabelFor,
  controlBadgeParts,
  openTabsSignature,
  renderOpenTabRows,
} from '../extension/popup/open-tabs-view.js';

/**
 * Popup Open Tabs rendering (pure module — the DOM side in popup.js only
 * swaps the HTML in and patches badges). Regression: a tab an agent was
 * driving rendered as "— free —".
 */

const agents = [
  { sessionId: 's-7f3a', name: 'Claude' },
  { sessionId: 's-91bc', name: 'Cursor' },
];
const tab = (over: Record<string, unknown> = {}) => ({
  id: 3, url: 'https://example.com/a', title: 'A', active: false, lockedBy: null, controlledBy: null, ...over,
});
const running = { sessionId: 's-7f3a', agentName: 'Claude', active: true };

/** The <option> values marked selected in the rendered HTML. */
const selectedValues = (html: string) => [...html.matchAll(/<option value="([^"]*)" selected>/g)].map((m) => m[1]);

describe('renderOpenTabRows', () => {
  it('a free tab shows "— free —" with nothing preselected and no badge', () => {
    const html = renderOpenTabRows([tab()], agents);
    expect(html).toContain('— free —');
    expect(html).not.toContain('ctrl-owner');
    expect(selectedValues(html)).toEqual([]);
  });

  it('a controlled tab shows the agent badge, is not "free", and preselects the controller', () => {
    const html = renderOpenTabRows([tab({ controlledBy: running })], agents);
    expect(html).not.toContain('— free —');
    expect(html).toContain('— not pinned —');
    expect(html).toMatch(/class="ctrl-owner" data-ctrl-tab="3"[^>]*>● Claude</);
    expect(selectedValues(html)).toEqual(['s-7f3a']);
  });

  it('a lingering (idle) controller renders the hollow, muted badge', () => {
    const html = renderOpenTabRows([tab({ controlledBy: { ...running, active: false } })], agents);
    expect(html).toMatch(/class="ctrl-owner idle"[^>]*>○ Claude</);
  });

  it("the user's pending Pin choice wins over the controller default (incl. an explicit none)", () => {
    const ctrlTab = tab({ controlledBy: running });
    expect(selectedValues(renderOpenTabRows([ctrlTab], agents, new Map([[3, 's-91bc']])))).toEqual(['s-91bc']);
    expect(selectedValues(renderOpenTabRows([ctrlTab], agents, new Map([[3, '']])))).toEqual([]);
  });

  it('a locked tab shows the lock owner and unpin button, not the badge or dropdown', () => {
    const html = renderOpenTabRows([tab({ lockedBy: 's-91bc', controlledBy: running })], agents);
    expect(html).toContain('🔒 Cursor · s-91bc');
    expect(html).toContain('data-action="unlockTab"');
    expect(html).not.toContain('ctrl-owner');
    expect(html).not.toContain('<select');
  });

  it('marks a tab listed from another window', () => {
    const html = renderOpenTabRows([tab({ otherWindow: true, controlledBy: running })], agents);
    expect(html).toContain('class="tab-title other"');
    expect(html).toContain('(in another window)');
  });

  it('escapes page- and agent-supplied text', () => {
    const html = renderOpenTabRows(
      [tab({ title: '<img src=x onerror=alert(1)>', controlledBy: { sessionId: 's-x', agentName: '<b>evil</b>', active: true } })],
      [],
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>evil');
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
  });
});

describe('openTabsSignature', () => {
  it('ignores the running/idle flip (patched in place, no rebuild)', () => {
    const a = openTabsSignature([tab({ controlledBy: running })], agents);
    const b = openTabsSignature([tab({ controlledBy: { ...running, active: false } })], agents);
    expect(a).toBe(b);
  });

  it('changes when control appears, moves to another agent, or the lock changes', () => {
    const free = openTabsSignature([tab()], agents);
    const ctrl = openTabsSignature([tab({ controlledBy: running })], agents);
    const other = openTabsSignature([tab({ controlledBy: { ...running, sessionId: 's-91bc' } })], agents);
    const locked = openTabsSignature([tab({ lockedBy: 's-7f3a' })], agents);
    expect(new Set([free, ctrl, other, locked]).size).toBe(4);
  });
});

describe('labels', () => {
  it('agentLabelFor: roster name, then the call-supplied name, then the bare id', () => {
    expect(agentLabelFor(agents, 's-7f3a')).toBe('Claude · s-7f3a');
    expect(agentLabelFor([], 's-zz', 'Windsurf')).toBe('Windsurf · s-zz');
    expect(agentLabelFor([], 's-zz')).toBe('s-zz');
    expect(agentLabelFor([], null, null)).toBe('agent');
  });

  it('controlBadgeParts: short name in the row, full session in the tooltip', () => {
    const b = controlBadgeParts(running, agents);
    expect(b).toMatchObject({ idle: false, text: '● Claude' });
    expect(b.title).toContain('Claude · s-7f3a');
    expect(b.title).toContain('running a call now');
    expect(controlBadgeParts({ sessionId: null, agentName: null, active: false }, []).text).toBe('○ agent');
  });

  it('escapeHtml covers all five metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
