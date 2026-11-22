import { describe, expect, it } from 'vitest';
import { buildEvidenceReport } from '../../mcp-server/src/tasks/evidence.js';
import type { Task } from '../../mcp-server/src/tasks/types.js';

function taskWith(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    goal: 'Check the balance on the account page',
    constraints: [],
    steps: [
      {
        tool: 'browser_navigate',
        params: { url: 'https://example.com/account' },
        verify: [{ kind: 'url-contains', value: 'example.com/account' }],
        result: {
          status: 'ok',
          detail:
            'verified 1 rule(s) at https://example.com/account; snapshot=browser_snapshot tab 42; observed="الرصيد: 1,234.56 ريال بتاريخ 2026-11-22 والرمز ABC-123"',
        },
      },
      {
        tool: 'browser_snapshot',
        params: {},
        verify: [{ kind: 'text-present', value: 'الرصيد' }],
      },
    ],
    state: 'paused-question',
    evidence: [
      'step 1 (browser_navigate): ok — verified 1 rule(s) at https://example.com/account; snapshot=browser_snapshot tab 42; observed="الرصيد: 1,234.56 ريال بتاريخ 2026-11-22 والرمز ABC-123"',
    ],
    ...overrides,
  };
}

describe('buildEvidenceReport', () => {
  it('test_report_lists_unresolved_items', () => {
    const report = buildEvidenceReport(taskWith());
    // The step that never ran is unresolved: it belongs in "ما بقي غير مؤكد"
    // in the text and in the JSON, never in the found values.
    expect(report.text).toContain('ما بقي غير مؤكد');
    const unconfirmed = report.text.split('ما بقي غير مؤكد')[1]?.split('ما لم يُتحقق منه')[0] ?? '';
    expect(unconfirmed).toContain('browser_snapshot');
    expect(report.json.unconfirmed.some((item) => item.tool === 'browser_snapshot')).toBe(true);
    expect(report.json.unconfirmed.some((item) => item.step === 2)).toBe(true);
    expect(report.json.values.some((value) => value.tool === 'browser_snapshot')).toBe(false);
  });

  it('has the five fixed sections in order', () => {
    const { text } = buildEvidenceReport(taskWith());
    const sections = ['ما تم فحصه', 'القيم التي وُجدت', 'المصادر', 'ما بقي غير مؤكد', 'ما لم يُتحقق منه'];
    let last = -1;
    for (const section of sections) {
      const at = text.indexOf(section);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it('copies found values verbatim from step results', () => {
    const report = buildEvidenceReport(taskWith());
    const verbatim = 'الرصيد: 1,234.56 ريال بتاريخ 2026-11-22 والرمز ABC-123';
    expect(report.text).toContain(verbatim);
    expect(report.json.values).toHaveLength(1);
    expect(report.json.values[0]?.value).toBe(verbatim);
    expect(report.json.values[0]?.step).toBe(1);
    expect(report.json.values[0]?.source).toBe('https://example.com/account');
  });

  it('keeps failed, verify-failed and unrun steps out of the found values', () => {
    const report = buildEvidenceReport(
      taskWith({
        state: 'failed',
        steps: [
          {
            tool: 'browser_navigate',
            params: { url: 'https://example.com/account' },
            verify: [{ kind: 'url-contains', value: 'example.com/account' }],
            result: { status: 'failed', detail: 'tab closed before the page loaded; code 404' },
          },
          {
            tool: 'browser_snapshot',
            params: {},
            verify: [{ kind: 'no-error-text', value: "isn't working" }],
            result: {
              status: 'verify-failed',
              detail:
                'verification failed: page shows error text "isn\'t working" — url=https://example.com/account; snapshot=browser_snapshot tab 42; observed="this page isn\'t working"',
            },
          },
          { tool: 'browser_snapshot', params: {}, verify: [] },
        ],
      }),
    );
    expect(report.json.values).toHaveLength(0);
    expect(report.text.split('القيم التي وُجدت')[1]?.split('المصادر')[0] ?? '').toContain('لا توجد قيم مؤكدة');
    // The tool failure is an unknown outcome: unconfirmed, not a found value.
    expect(report.json.unconfirmed.some((item) => item.step === 1)).toBe(true);
    // The failed verification is not verified — and its error text is evidence of failure, not a value.
    expect(report.json.notVerified.some((item) => item.step === 2)).toBe(true);
    expect(report.json.notVerified.some((item) => item.step === 3)).toBe(true);
    // The step that never ran is both unconfirmed and not verified.
    expect(report.json.unconfirmed.some((item) => item.step === 3)).toBe(true);
  });

  it('lists sources once, in order of first appearance', () => {
    const report = buildEvidenceReport(taskWith());
    expect(report.json.sources).toEqual(['https://example.com/account']);
    expect(report.text.split('المصادر')[1]?.split('ما بقي غير مؤكد')[0] ?? '').toContain(
      'https://example.com/account',
    );
  });

  it('records a paused task as unconfirmed work, not as a finding', () => {
    const report = buildEvidenceReport(taskWith({ state: 'paused-login' }));
    expect(report.json.unconfirmed.some((item) => item.step === undefined)).toBe(true);
    expect(report.json.values).toHaveLength(1);
  });

  it('says explicitly when a section has nothing', () => {
    const report = buildEvidenceReport(
      taskWith({
        state: 'done',
        steps: [
          {
            tool: 'browser_navigate',
            params: { url: 'https://example.com' },
            verify: [],
            result: { status: 'ok', detail: 'verified 0 rule(s) at https://example.com; snapshot=unseen; observed="ok"' },
          },
        ],
      }),
    );
    expect(report.json.unconfirmed).toHaveLength(0);
    expect(report.json.notVerified).toHaveLength(0);
    expect(report.text).toContain('لا شيء بقي غير مؤكد');
    expect(report.text).toContain('لا توجد خطوات لم يُتحقق منها');
  });

  it('lists every step checked, with its verify rules and status', () => {
    const report = buildEvidenceReport(taskWith());
    expect(report.json.checked).toHaveLength(2);
    expect(report.json.checked[0]?.status).toBe('ok');
    expect(report.json.checked[0]?.verify).toEqual(['url-contains "example.com/account"']);
    expect(report.json.checked[1]?.status).toBe('not-run');
    expect(report.text.split('ما تم فحصه')[1]?.split('القيم التي وُجدت')[0] ?? '').toContain('browser_snapshot');
  });

  it('keeps inner quotes of the observed text in the verbatim value', () => {
    const report = buildEvidenceReport(
      taskWith({
        steps: [
          {
            tool: 'browser_snapshot',
            params: {},
            verify: [],
            result: {
              status: 'ok',
              detail:
                'verified 0 rule(s) at https://example.com; snapshot=browser_snapshot tab 42; observed="heading "Welcome to Example" - link "Get started""',
            },
          },
        ],
        state: 'done',
      }),
    );
    expect(report.json.values[0]?.value).toBe('heading "Welcome to Example" - link "Get started"');
  });

  it('falls back to the whole detail when there is no observed excerpt', () => {
    const report = buildEvidenceReport(
      taskWith({
        steps: [
          {
            tool: 'browser_snapshot',
            params: {},
            verify: [],
            result: { status: 'ok', detail: 'page read, code 200' },
          },
        ],
        state: 'done',
      }),
    );
    expect(report.json.values[0]?.value).toBe('page read, code 200');
  });
});
