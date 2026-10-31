import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryService } from '../mcp-server/src/memory/service.js';
import { defaultPolicy, enablePolicy, writePolicy } from '../mcp-server/src/memory/policy.js';

/**
 * 007: what the stored form shape may hold.
 *
 * These tests live beside `memory-privacy.test.ts` rather than inside it: that file's harness starts an isolated
 * daemon for every test, and on Windows an isolated daemon cannot bind the IPC named pipe while the owner's
 * daemon holds it. These checks need no daemon — they drive the memory service directly and read the bytes it
 * wrote — so they run everywhere, including beside a running daemon.
 */
describe('007: the stored shape holds counts and vocabulary words only', () => {
  const SHAPE_ORIGIN = 'https://example.com';

  let dir: string;
  let memoryDir: string;
  let nowMs: number;

  const siteContext = (over: Record<string, unknown> = {}) => ({
    url: `${SHAPE_ORIGIN}/login`,
    incognito: false,
    topLevel: true,
    stable: true,
    lang: 'en',
    dir: 'ltr',
    passwordField: false,
    anonymous: true,
    anonymityReason: 'ok',
    ...over,
  });

  function service(shapeGate?: 'option1' | 'option2'): MemoryService {
    return new MemoryService({
      memoryDir,
      vault: { memoryEligibility: () => 'clear' },
      connection: () => ({ browserId: 'profile-a', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true }),
      now: () => nowMs,
      ...(shapeGate ? { shapeGate } : {}),
    });
  }

  /** Every byte the store wrote for this origin. */
  const storedBytes = (): string => {
    const sites = path.join(memoryDir, 'sites');
    if (!fs.existsSync(sites)) return '';
    return fs.readdirSync(sites).map((name) => fs.readFileSync(path.join(sites, name), 'utf8')).join('\n');
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-shape-priv-'));
    memoryDir = path.join(dir, 'memory');
    nowMs = Date.parse('2026-10-31T09:00:00.000Z');
    await writePolicy(memoryDir, enablePolicy(defaultPolicy(), new Date(nowMs).toISOString()));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** One read of a page whose form inside `main` was measured. */
  async function read(memory: MemoryService, shape: unknown, over: Record<string, unknown> = {}): Promise<void> {
    const url = `${SHAPE_ORIGIN}/login`;
    memory.afterCall(memory.beginCall('s1', 'browser_navigate'), {
      sessionId: 's1',
      tool: 'browser_navigate',
      params: { url, snapshot: true },
      daemonCallId: `call-${Math.random()}`,
      result: { success: true, url, tabId: 7, text: '- text "Welcome" [e1]' },
      observation: { siteContext: siteContext({ formShape: shape, ...over }), digestBefore: 'a', digestAfter: 'a', sanitizedUnchanged: true },
    });
    await memory.flush();
  }

  it('stores the measured shape byte for byte, with none of the page\'s strings', async () => {
    const memory = service();
    await read(memory, { fields: 3, required: 1, types: ['text', 'password', 'checkbox'], hidden: true });
    const stored = storedBytes();
    const record = JSON.parse(stored) as { facts: Array<{ factId: string; kind: string; value: unknown }> };
    // The stored value is exactly the reviewed words: two counts, a boolean, closed-vocabulary types and a mode.
    const shapes = record.facts.filter((fact) => fact.kind === 'ui.form.shape');
    expect(shapes).toHaveLength(1);
    expect(shapes[0].factId).toBe('ui.form.shape:/login');
    expect(shapes[0].value).toEqual({ shape: { fields: 3, required: 1, types: ['checkbox', 'password', 'text'], hidden: true }, commit: 'unknown' });
    // Nothing from the page: no label, name, value, placeholder, help text, id or selector.
    for (const planted of ['Username', 'username', 'Remember me', 'remember', 'current-password', 'autocomplete', 'Welcome', 'label', 'placeholder', 'hunter2']) {
      expect(stored, planted).not.toContain(planted);
    }
  });

  it('stores the count of a form that asks for a name, an address and a card number, and infers no purpose', async () => {
    const memory = service();
    // A name field, an address field and a card number: three fields, two types, no purpose to infer.
    await read(memory, { fields: 3, required: 0, types: ['text', 'number'], hidden: false });
    const stored = storedBytes();
    const record = JSON.parse(stored) as { facts: Array<{ kind: string; value: unknown }> };
    const shapes = record.facts.filter((fact) => fact.kind === 'ui.form.shape');
    expect(shapes).toHaveLength(1);
    expect(shapes[0].value).toEqual({ shape: { fields: 3, required: 0, types: ['number', 'text'], hidden: false }, commit: 'unknown' });
    for (const planted of ['name', 'address', 'card', 'postal', 'cvv', 'purpose']) {
      expect(stored, planted).not.toContain(planted);
    }
  });

  it('counts a field type outside the reviewed list as other, and never guesses it', async () => {
    const memory = service();
    await read(memory, { fields: 2, required: 0, types: ['text', 'creditcardnumber'], hidden: false });
    const stored = storedBytes();
    const record = JSON.parse(stored) as { facts: Array<{ kind: string; value: { shape: { types: string[] } } }> };
    const shapes = record.facts.filter((fact) => fact.kind === 'ui.form.shape');
    expect(shapes[0].value.shape.types).toEqual(['other', 'text']);
    expect(stored).not.toContain('creditcardnumber');
  });

  it('the counter holds a number and no part of the failed action', async () => {
    const memory = service();
    await read(memory, { fields: 1, required: 0, types: ['text'], hidden: false });
    memory.afterCall(memory.beginCall('s1', 'browser_click'), {
      sessionId: 's1',
      tool: 'browser_click',
      params: { tabId: 7, target: '.todo-list input.toggle' },
      daemonCallId: 'call-failed',
      result: { success: false, tabId: 7 },
      error: 'ELEMENT_HIDDEN: .todo-list input.toggle matches only hidden elements',
    });
    await memory.flush();
    const stored = storedBytes();
    const record = JSON.parse(stored) as { profiles: Record<string, { hidden?: { count: number } }> };
    expect(record.profiles['profile-a'].hidden).toEqual({ count: 1 });
    expect(stored).not.toMatch(/todo-list|input\.toggle|matches only hidden/u);
  });

  it("under Option 2 the shape of a signed-in page holds no name, value or path outside the reviewed list", async () => {
    const memory = service('option2');
    await read(memory, { fields: 2, required: 0, types: ['text'], hidden: true }, { anonymous: false });
    const stored = storedBytes();
    const record = JSON.parse(stored) as { facts: Array<{ factId: string; value: unknown }> };
    expect(record.facts).toHaveLength(1);
    expect(record.facts[0].factId).toBe('ui.form.shape:/login');
    expect(record.facts[0].value).toEqual({ shape: { fields: 2, required: 0, types: ['text'], hidden: true }, commit: 'unknown' });
    for (const planted of ['Username', 'Sign in', 'address', 'card', 'hunter2']) {
      expect(stored, planted).not.toContain(planted);
    }
  });
});
