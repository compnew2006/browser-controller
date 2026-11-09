import { describe, expect, it } from 'vitest';
import { renderActionActivity } from '../extension/popup/activity-view.js';

const baseEvent = {
  kind: 'action', schemaVersion: 1,
  tabId: 3, pageVisitId: 'visit-a', host: 'example.test',
  tool: 'browser_click', operation: 'click',
  startedAt: '2026-11-09T10:00:00.000Z', executionStatus: 'completed',
};

describe('popup activity renderer', () => {
  it('shows tool steps beside privacy-safe page context', () => {
    const rendered = renderActionActivity({ data: {
      events: [
        { ...baseEvent, eventId: 'event-nav', tool: 'browser_navigate', operation: 'navigate', startedAt: '2026-11-09T10:00:00.000Z' },
        { ...baseEvent, eventId: 'event-snapshot', tool: 'browser_snapshot', operation: 'snapshot', startedAt: '2026-11-09T10:00:01.000Z', batchRunId: 'batch-a', batchStepIndex: 2 },
        { ...baseEvent, eventId: 'event-type', tool: 'browser_type', operation: 'type', startedAt: '2026-11-09T10:00:02.000Z', batchRunId: 'batch-a', batchStepIndex: 3 },
        { ...baseEvent, eventId: 'event-click', tool: 'browser_click', operation: 'click', startedAt: '2026-11-09T10:00:03.000Z', batchRunId: 'batch-a', batchStepIndex: 4, targetElementId: 'confirm', dispatchStatus: 'sent', inputCounts: { confirmed: 2, uncertain: 0, required: 2 }, batchEndedAt: '2026-11-09T10:00:04.000Z', batchExecutionStatus: 'completed' },
      ],
      currentVisits: [{ tabId: 3, pageVisitId: 'visit-a', host: 'example.test' }],
      historyTruncated: false, incompleteBatchRunIds: [], includeElementNames: true,
    } });
    expect(rendered).toContain('browser_navigate');
    expect(rendered).toContain('browser_snapshot');
    expect(rendered).toContain('browser_type');
    expect(rendered).toContain('browser_click');
    expect(rendered).toContain('class="activity-step-number" aria-label="Step 2">2</span>');
    expect(rendered).toContain('activity-page-context');
    expect(rendered).toContain('example.test');
    expect(rendered).toContain('Element ID: <code>confirm</code>');
    expect(rendered).toContain('Clicks: 2 of 2 confirmed');
    expect(rendered).not.toContain('private page text');
  });

  it('keeps step numbers continuous across separate batch calls', () => {
    const rendered = renderActionActivity({ data: {
      events: [
        { ...baseEvent, eventId: 'event-nav', tool: 'browser_navigate', operation: 'navigate' },
        { ...baseEvent, eventId: 'event-snapshot', tool: 'browser_snapshot', operation: 'snapshot', startedAt: '2026-11-09T10:00:01.000Z' },
        { ...baseEvent, eventId: 'event-click-1', batchRunId: 'batch-a', batchStepIndex: 1, startedAt: '2026-11-09T10:00:02.000Z', batchEndedAt: '2026-11-09T10:00:03.000Z', batchExecutionStatus: 'completed' },
        { ...baseEvent, eventId: 'event-click-2', batchRunId: 'batch-b', batchStepIndex: 1, startedAt: '2026-11-09T10:00:04.000Z', batchEndedAt: '2026-11-09T10:00:05.000Z', batchExecutionStatus: 'completed' },
      ],
      currentVisits: [{ tabId: 3, pageVisitId: 'visit-a', host: 'example.test' }],
      historyTruncated: false, incompleteBatchRunIds: [], includeElementNames: true,
    } });
    expect(rendered).toContain('aria-label="Step 1">1</span>');
    expect(rendered).toContain('aria-label="Step 2">2</span>');
    expect(rendered).toContain('aria-label="Step 3">3</span>');
    expect(rendered).toContain('aria-label="Step 4">4</span>');
  });

  it('groups batch children under their source page visit and separates dispatch from site effects', () => {
    const rendered = renderActionActivity({
      storageError: false,
      data: {
        events: [
          { ...baseEvent, eventId: 'event-1', pageVisitId: 'visit-a', targetLabel: 'OK', targetElementId: 'confirm', batchRunId: 'batch-a', batchStepIndex: 1, dispatchStatus: 'sent', inputCounts: { confirmed: 2, uncertain: 0, required: 2 }, siteEffect: { kind: 'navigation', observedAt: '2026-11-09T10:00:01.000Z' }, batchEndedAt: '2026-11-09T10:00:02.000Z', batchExecutionStatus: 'completed' },
          { ...baseEvent, eventId: 'event-2', pageVisitId: 'visit-a', targetLabel: 'Save', targetElementId: 'save', batchRunId: 'batch-a', batchStepIndex: 2, dispatchStatus: 'sent', inputCounts: { confirmed: 1, uncertain: 0, required: 1 }, batchEndedAt: '2026-11-09T10:00:02.000Z', batchExecutionStatus: 'completed' },
        ],
        currentVisits: [{ tabId: 3, pageVisitId: 'visit-a', host: 'example.test' }],
        historyTruncated: false, incompleteBatchRunIds: [], includeElementNames: true,
      },
    });
    expect(rendered).toContain('Batch 1');
    expect(rendered).toContain('Tab open');
    expect(rendered).toContain('Clicked button: OK');
    expect(rendered).toContain('Element ID: <code>confirm</code>');
    expect(rendered).toContain('Clicks: 2 of 2 confirmed');
    expect(rendered).toContain('Click sent; the site did not confirm acceptance');
    expect(rendered).toContain('Page navigation observed');
    expect(rendered).not.toContain('batch-a');
  });

  it('renders explicit unknown, partial, incomplete, closed, and truncation states', () => {
    const rendered = renderActionActivity({
      data: {
        events: [
          { ...baseEvent, eventId: 'event-3', pageVisitId: 'visit-old', dispatchStatus: 'unknown', inputCounts: { confirmed: 0, uncertain: 1, required: 1 } },
          { ...baseEvent, eventId: 'event-4', pageVisitId: 'visit-old', operation: 'click', batchRunId: 'batch-b', batchStepIndex: 1, dispatchStatus: 'partially_sent', inputCounts: { confirmed: 1, uncertain: 0, required: 2 } },
        ],
        currentVisits: [], historyTruncated: true,
        incompleteBatchRunIds: ['batch-b'], includeElementNames: false,
      },
    });
    expect(rendered).toContain('Tab closed');
    expect(rendered).toContain('The click may or may not have been sent—check the page before retrying');
    expect(rendered).toContain('Batch not confirmed; no completion marker was recorded');
    expect(rendered).toContain('Confirmed 1 of 2 inputs; the rest were not sent');
    expect(rendered).toContain('older actions were removed');
  });

  it('hides element IDs with names while retaining the per-call click count', () => {
    const rendered = renderActionActivity({ data: {
      events: [{ ...baseEvent, eventId: 'event-private', targetLabel: 'OK', targetElementId: 'private-confirm', dispatchStatus: 'sent', inputCounts: { confirmed: 3, uncertain: 0, required: 3 } }],
      currentVisits: [], historyTruncated: false, incompleteBatchRunIds: [], includeElementNames: false,
    } });
    expect(rendered).toContain('Element details hidden');
    expect(rendered).toContain('Clicks: 3 of 3 confirmed');
    expect(rendered).not.toContain('private-confirm');
    expect(rendered).not.toContain('Clicked button: OK');
  });

  it('has loading, empty, storage-error, and escaped-label output', () => {
    expect(renderActionActivity(null, { loading: true })).toContain('Loading activity');
    expect(renderActionActivity({ data: { events: [] } })).toContain('No activity yet');
    expect(renderActionActivity({ data: { events: [], currentVisits: [] }, storageError: true })).toContain('Session storage is unavailable');
    const rendered = renderActionActivity({ data: {
      events: [{ ...baseEvent, eventId: 'event-5', targetLabel: '<img src=x onerror=alert(1)>', targetElementId: '<svg onload=x>' }],
      currentVisits: [], historyTruncated: false, incompleteBatchRunIds: [], includeElementNames: true,
    } });
    expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered).toContain('Element ID: <code>&lt;svg onload=x&gt;</code>');
    expect(rendered).not.toContain('<img src=x');
    expect(rendered).not.toContain('<svg onload=x>');
  });
});
