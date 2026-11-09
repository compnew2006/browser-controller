import { escapeHtml } from './open-tabs-view.js';

function count(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
}

function time(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(date)
    : '—';
}

function actionTitle(event, includeElementNames) {
  const target = includeElementNames ? event.targetLabel : null;
  if (event.operation === 'click') return target ? `Clicked: ${target}` : 'Clicked';
  if (event.operation === 'type') return target ? `Typed into: ${target}` : 'Typed into a field';
  if (event.operation === 'fill') return 'Filled fields';
  if (event.operation === 'drag') return 'Dragged an element';
  if (event.operation === 'navigate') return 'Navigated to a page';
  if (event.operation === 'snapshot') return 'Read page structure';
  if (event.operation === 'scroll') return 'Scrolled the page';
  if (event.operation === 'dialog') return 'Handled a dialog';
  return 'Performed a page action';
}

function dispatchCopy(event) {
  const status = event.dispatchStatus;
  const input = event.inputCounts;
  if (status === 'unknown') return event.operation === 'click'
    ? 'The click may or may not have been sent—check the page before retrying'
    : 'The input may or may not have been sent—check the page before retrying';
  if (status === 'not_sent') return event.operation === 'click' ? 'No click was sent' : 'No input was sent';
  if (status === 'partially_sent') {
    return `Confirmed ${count(input?.confirmed)} of ${count(input?.required)} inputs; the rest were not sent`;
  }
  if (status === 'sent') return event.operation === 'click'
    ? 'Click sent; the site did not confirm acceptance'
    : 'Input sent; the site did not confirm acceptance';
  if (event.executionStatus === 'running') return 'Tool is running';
  if (event.executionStatus === 'failed') return 'Tool failed before completion was confirmed';
  if (event.executionStatus === 'unknown') return 'Action result is unknown';
  return 'Tool call completed';
}

function siteEffectCopy(effect) {
  if (effect.kind === 'navigation') return 'Page navigation observed';
  if (effect.kind === 'dialog_open') return 'Dialog opened';
  if (effect.kind === 'download_started') return 'Download started';
  return '';
}

function clickCountText(event) {
  const counts = event.inputCounts;
  let clickCount = 'Click count unavailable';
  if (counts && [counts.confirmed, counts.uncertain, counts.required].every(Number.isInteger)
    && counts.confirmed >= 0 && counts.uncertain >= 0 && counts.required >= 1
    && counts.confirmed + counts.uncertain <= counts.required) {
    const notSent = counts.required - counts.confirmed - counts.uncertain;
    const detail = counts.uncertain > 0
      ? `${count(counts.confirmed)} confirmed, ${count(counts.uncertain)} uncertain${notSent ? `, ${count(notSent)} not sent` : ''}`
      : `${count(counts.confirmed)} of ${count(counts.required)} confirmed`;
    clickCount = `Clicks: ${detail}`;
  }
  return clickCount;
}

function clickDetails(event, includeElementNames) {
  const clickCount = escapeHtml(clickCountText(event));
  if (!includeElementNames) return `<p class="activity-detail">Element details hidden · ${clickCount}</p>`;
  const elementId = event.targetElementId
    ? `<code>${escapeHtml(event.targetElementId)}</code>`
    : '<span>not available</span>';
  return `<p class="activity-detail">Element ID: ${elementId} · ${clickCount}</p>`;
}

function actionRow(event, includeElementNames, stepNumber) {
  const effect = event.siteEffect ? siteEffectCopy(event.siteEffect) : '';
  const dispatch = event.dispatchStatus ? `<p class="activity-status" data-status="${escapeHtml(event.dispatchStatus)}">${escapeHtml(dispatchCopy(event))}</p>` : '';
  const site = effect ? `<p class="activity-effect">${escapeHtml(effect)}</p>` : '';
  const execution = event.executionStatus === 'failed' && event.dispatchStatus
    ? '<span class="activity-result">Tool failed</span>' : '';
  const details = event.operation === 'click' ? clickDetails(event, includeElementNames) : '';
  const number = Number.isInteger(stepNumber) && stepNumber > 0 ? stepNumber : 1;
  return `<li class="activity-row">
    <span class="activity-step-number" aria-label="Step ${count(number)}">${count(number)}</span>
    <div class="activity-row-content">
      <div class="activity-row-head"><strong><code>${escapeHtml(event.tool)}</code></strong><time>${escapeHtml(time(event.startedAt))}</time></div>
      <p class="activity-action-label">${escapeHtml(actionTitle(event, includeElementNames))}</p>
      ${details}${dispatch}${site}${execution}
    </div>
  </li>`;
}

function batchCopy(events, incomplete, truncated) {
  if (truncated) return 'Batch activity is incomplete; earlier steps were removed';
  if (incomplete) return 'Batch not confirmed; no completion marker was recorded';
  const status = events.find((event) => event.batchExecutionStatus)?.batchExecutionStatus;
  if (status === 'completed') return 'Batch completed';
  if (status === 'failed') return 'Batch stopped with an error';
  if (status === 'aborted') return 'Batch was cancelled';
  return 'Batch completion status is unknown';
}

function renderVisit(visit, state) {
  const events = visit.events;
  const visitBatches = new Map();
  for (const event of events) {
    if (!event.batchRunId) continue;
    if (!visitBatches.has(event.batchRunId)) visitBatches.set(event.batchRunId, []);
    visitBatches.get(event.batchRunId).push(event);
  }
  const emittedBatches = new Set();
  let batchNumber = 0;
  let timelineStep = 0;
  const sortedEvents = [...events].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const rows = sortedEvents.map((event) => {
    if (!event.batchRunId) return actionRow(event, state.includeElementNames !== false, ++timelineStep);
    if (emittedBatches.has(event.batchRunId)) return '';
    emittedBatches.add(event.batchRunId);
    batchNumber++;
    const children = visitBatches.get(event.batchRunId).sort((a, b) => a.batchStepIndex - b.batchStepIndex);
    const incomplete = state.incompleteBatchRunIds.includes(event.batchRunId) || !children.some((item) => item.batchEndedAt);
    const truncated = state.truncatedBatchRunIds?.includes(event.batchRunId) === true;
    return `<li class="activity-batch">
      <div class="activity-batch-head"><strong>Batch ${count(batchNumber)}</strong><span>${escapeHtml(batchCopy(children, incomplete, truncated))}</span></div>
      <ol class="activity-batch-steps">${children.map((item) => actionRow(item, state.includeElementNames !== false, ++timelineStep)).join('')}</ol>
    </li>`;
  }).join('');
  const latest = sortedEvents[sortedEvents.length - 1];
  const latestOutcome = latest.dispatchStatus ? dispatchCopy(latest) : latest.executionStatus === 'failed' ? 'Tool failed' : 'Tool call completed';
  const pageContext = `<aside class="activity-page-context" aria-label="Page context">
    <div class="activity-context-head"><strong>${escapeHtml(visit.host)}</strong><span>${visit.open ? 'Tab open' : 'Tab closed'}</span></div>
    <span class="activity-context-label">Latest step</span>
    <code class="activity-context-tool">${escapeHtml(latest.tool)}</code>
    <p class="activity-context-outcome"${latest.dispatchStatus ? ` data-status="${escapeHtml(latest.dispatchStatus)}"` : ''}>${escapeHtml(latestOutcome)}</p>
    <span class="activity-context-count">${count(events.length)} ${events.length === 1 ? 'step' : 'steps'}</span>
  </aside>`;
  return `<section class="activity-visit">
    <div class="activity-visit-head"><strong>${escapeHtml(visit.host)}</strong><span>${visit.open ? 'Tab open' : 'Tab closed'}</span></div>
    <div class="activity-visit-layout">
      <ol class="activity-items">${rows}</ol>
      ${pageContext}
    </div>
  </section>`;
}

export function renderActionActivity(envelope, options = {}) {
  if (options.loading) {
    return '<div class="activity-state" role="status" aria-live="polite"><span class="activity-skeleton"></span><span class="activity-skeleton short"></span><span class="activity-skeleton"></span><span class="activity-skeleton short"></span><span class="activity-loading">Loading activity…</span></div>';
  }
  if (options.error || envelope?.success === false) {
    return `<div class="activity-state activity-error" role="alert">${escapeHtml(options.error || 'Could not load activity.')}</div>`;
  }
  const state = envelope?.data ?? envelope ?? {};
  const events = Array.isArray(state.events) ? state.events : [];
  const storageWarning = envelope?.storageError
    ? '<div class="activity-warning" role="status">Session storage is unavailable; activity may not survive a service worker restart.</div>' : '';
  const truncated = state.historyTruncated
    ? '<div class="activity-warning" role="status">The activity limit was reached; older actions were removed.</div>' : '';
  if (!events.length) {
    return `${storageWarning}${truncated}<div class="activity-empty"><strong>No activity yet</strong><span>Actions the agent takes on a page will appear here.</span></div>`;
  }
  const activeIds = new Set((state.currentVisits || []).map((visit) => visit.pageVisitId));
  const visits = new Map();
  for (const event of events) {
    if (!visits.has(event.pageVisitId)) visits.set(event.pageVisitId, {
      pageVisitId: event.pageVisitId, host: event.host, open: activeIds.has(event.pageVisitId), events: [],
    });
    visits.get(event.pageVisitId).events.push(event);
  }
  const ordered = [...visits.values()].sort((a, b) => {
    const lastA = Math.max(...a.events.map((event) => Date.parse(event.startedAt)));
    const lastB = Math.max(...b.events.map((event) => Date.parse(event.startedAt)));
    return lastB - lastA;
  });
  return `${storageWarning}${truncated}${ordered.map((visit) => renderVisit(visit, state)).join('')}`;
}

export function bindActionActivity() {
  const panel = document.querySelector('[data-panel="activity"]');
  const countEl = document.getElementById('activityCount');
  const listEl = document.getElementById('activityList');
  const namesInput = document.getElementById('activityNames');
  const clearBtn = document.getElementById('activityClear');
  let envelope = null;
  let error = null;
  let loading = true;
  let markupCache = '';
  let requestId = 0;

  function render() {
    const data = envelope?.data;
    const markup = renderActionActivity(envelope, { loading, error });
    const events = Array.isArray(data?.events) ? data.events : [];
    countEl.textContent = events.length ? String(events.length) : '';
    clearBtn.disabled = loading || events.length === 0;
    namesInput.disabled = loading || !envelope;
    if (envelope && typeof data?.includeElementNames === 'boolean') namesInput.checked = data.includeElementNames;
    listEl.setAttribute('aria-busy', String(loading));
    if (markup !== markupCache) {
      const scrollTop = listEl.scrollTop;
      listEl.innerHTML = markup;
      listEl.scrollTop = scrollTop;
      markupCache = markup;
    }
  }

  function request(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ success: false, error: 'Could not reach the extension worker.' });
        else resolve(response || { success: false, error: 'The extension worker returned no response.' });
      });
    });
  }

  async function refresh(force = false) {
    if (panel.hidden && !force) return;
    const currentRequest = ++requestId;
    if (!envelope) {
      loading = true;
      render();
    }
    const response = await request({ type: 'getActionActivity' });
    if (currentRequest !== requestId) return;
    if (!response || response.success === false) error = response?.error || 'Could not load activity.';
    else { envelope = response; error = null; }
    loading = false;
    render();
  }

  namesInput.addEventListener('change', async () => {
    namesInput.disabled = true;
    const response = await request({ type: 'setActionActivityLabelsVisible', visible: namesInput.checked });
    if (response?.success === false) error = response.error || 'Could not update element name privacy.';
    else { envelope = response; error = null; }
    loading = false;
    render();
  });

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    const response = await request({ type: 'clearActionActivity' });
    if (response?.success === false) error = response.error || 'Could not clear activity.';
    else { envelope = response; error = null; }
    render();
  });

  return { refresh };
}
