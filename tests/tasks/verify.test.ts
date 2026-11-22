import { describe, expect, it } from 'vitest';
import { pageSnapshotFromResult, verifyStep } from '../../mcp-server/src/tasks/verify.js';
import type { PageSnapshot } from '../../mcp-server/src/tasks/verify.js';
import type { TaskStep } from '../../mcp-server/src/tasks/types.js';
import { textResult } from '../../mcp-server/src/tools/types.js';

function stepWith(verify: TaskStep['verify']): TaskStep {
  return { tool: 'browser_navigate', params: { url: 'https://example.com' }, verify };
}

const loadedPage: PageSnapshot = {
  url: 'https://example.com/welcome',
  text: 'heading "Welcome to Example"\n- link "Get started" [ref=e1]\n- button "Buy now" [ref=e2]',
  ref: 'browser_snapshot tab 42',
};

describe('verifyStep', () => {
  it('test_error_page_fails_verification', () => {
    const errorPage: PageSnapshot = {
      url: 'https://example.com',
      text: "This page isn't working\nhttps://example.com is currently unable to handle this request.",
      ref: 'browser_snapshot tab 42',
    };
    const outcome = verifyStep(stepWith([{ kind: 'no-error-text', value: "isn't working" }]), errorPage);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('VERIFY_FAILED');
    expect(outcome.evidence).toContain('https://example.com');
    expect(outcome.evidence).toContain("isn't working");
  });

  it('test_successful_navigation_passes', () => {
    const outcome = verifyStep(
      stepWith([
        { kind: 'url-contains', value: 'example.com' },
        { kind: 'text-present', value: 'Welcome to Example' },
        { kind: 'no-error-text', value: "isn't working" },
      ]),
      loadedPage,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.code).toBeUndefined();
    expect(outcome.evidence).toContain('https://example.com/welcome');
  });

  it('fails url-contains when the page landed elsewhere', () => {
    const outcome = verifyStep(stepWith([{ kind: 'url-contains', value: 'example.com' }]), {
      ...loadedPage,
      url: 'https://other.test/login',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('VERIFY_FAILED');
    expect(outcome.evidence).toContain('https://other.test/login');
  });

  it('fails text-present when the expected text is missing', () => {
    const outcome = verifyStep(stepWith([{ kind: 'text-present', value: 'Order confirmed' }]), loadedPage);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('VERIFY_FAILED');
    expect(outcome.evidence).toContain('Order confirmed');
  });

  it('counts snapshot lines for element-count', () => {
    const twoButtons = verifyStep(
      stepWith([{ kind: 'element-count', selector: 'button', count: 2 }]),
      { ...loadedPage, text: '- button "Buy now" [ref=e2]\n- button "Sell" [ref=e3]\n- link "Home" [ref=e4]' },
    );
    expect(twoButtons.ok).toBe(true);

    const oneButton = verifyStep(
      stepWith([{ kind: 'element-count', selector: 'button', count: 2 }]),
      { ...loadedPage, text: '- button "Buy now" [ref=e2]\n- link "Home" [ref=e4]' },
    );
    expect(oneButton.ok).toBe(false);
    expect(oneButton.code).toBe('VERIFY_FAILED');
    expect(oneButton.evidence).toContain('button');
  });

  it('fails no-error-text on an empty page, even with no rules naming it', () => {
    const outcome = verifyStep(stepWith([{ kind: 'url-contains', value: 'example.com' }]), {
      url: 'https://example.com',
      text: '   \n',
      ref: 'browser_snapshot tab 42',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('VERIFY_FAILED');
    expect(outcome.evidence).toMatch(/empty/i);
  });

  it('fails an error page even when no rule names its text', () => {
    // A navigation that "succeeded" must never count as success on its own:
    // a Chrome error page fails verification with no rule needed.
    const outcome = verifyStep(stepWith([{ kind: 'url-contains', value: 'example.com' }]), {
      url: 'https://example.com',
      text: "This site can't be reached\nERR_CONNECTION_REFUSED",
      ref: 'browser_snapshot tab 42',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('VERIFY_FAILED');
  });

  it('passes a good page with no explicit rules', () => {
    const outcome = verifyStep(stepWith([]), loadedPage);
    expect(outcome.ok).toBe(true);
  });

  it('fails url-contains when the snapshot carries no URL', () => {
    const outcome = verifyStep(stepWith([{ kind: 'url-contains', value: 'example.com' }]), {
      url: '',
      text: 'heading "Welcome"',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('VERIFY_FAILED');
  });

  it('reports the first failing rule and keeps the evidence bounded', () => {
    const outcome = verifyStep(
      stepWith([
        { kind: 'url-contains', value: 'missing.test' },
        { kind: 'text-present', value: 'also missing' },
      ]),
      loadedPage,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.evidence).toContain('missing.test');
    expect(outcome.evidence.length).toBeLessThan(1000);
  });
});

describe('pageSnapshotFromResult', () => {
  it('builds a snapshot from a step result text and its raw URL', () => {
    const snapshot = pageSnapshotFromResult(textResult('page text'), 'result of browser_navigate');
    expect(snapshot.text).toBe('page text');
    expect(snapshot.ref).toBe('result of browser_navigate');
    expect(snapshot.url).toBe('');
  });
});
