/** Session-only browser action history. No caller-provided params or results are persisted. */
export const ACTIVITY_STORAGE_KEY = 'bcChromeActionActivity';
export const ACTIVITY_EVENT_CAP = 500;
export const ACTIVITY_VISIT_CAP = 1_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_RE = /^browser_[a-z0-9_]{1,57}$/;
const OPERATIONS = new Set(['click', 'type', 'fill', 'drag', 'navigate', 'snapshot', 'scroll', 'dialog', 'other']);
const EXECUTION = new Set(['running', 'completed', 'failed', 'unknown']);
const DISPATCH = new Set(['not_sent', 'partially_sent', 'sent', 'unknown']);
const BATCH_EXECUTION = new Set(['completed', 'failed', 'aborted', 'unknown']);
const SITE_EFFECTS = new Set(['navigation', 'dialog_open', 'download_started']);
const ACTIVITY_OPERATIONS = Object.freeze({
  browser_click: 'click',
  browser_type: 'type',
  browser_fill: 'fill',
  browser_navigate: 'navigate',
  browser_snapshot: 'snapshot',
  browser_scroll: 'scroll',
  browser_handle_dialog: 'dialog',
  browser_evaluate: 'other',
});
export const ACTIVITY_TOOL_NAMES = Object.freeze(Object.keys(ACTIVITY_OPERATIONS).sort());

function validActivityContext(tool, value) {
  if (!ACTIVITY_OPERATIONS[tool] || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => ['eventId', 'batchRunId', 'batchStepIndex'].includes(key))
    && validId(value.eventId)
    && ((value.batchRunId === undefined && value.batchStepIndex === undefined)
      || (validId(value.batchRunId) && Number.isInteger(value.batchStepIndex)
        && value.batchStepIndex >= 1 && value.batchStepIndex <= 50));
}

function activityOperation(tool, params) {
  if (tool === 'browser_click' && params?.dragTo != null) return 'drag';
  if (tool === 'browser_click' && params?.hover === true) return 'other';
  return ACTIVITY_OPERATIONS[tool];
}

export function createInputActivity(tool, params) {
  const isClick = tool === 'browser_click' && params?.hover !== true;
  const isType = tool === 'browser_type';
  const isFill = tool === 'browser_fill';
  const isScroll = tool === 'browser_scroll' && (Number.isFinite(params?.dx) || Number.isFinite(params?.dy));
  if (!isClick && !isType && !isFill && !isScroll) return null;
  const keyUnits = typeof params.key === 'string'
    ? (/\S/.test(params.key) ? params.key.trim().split(/\s+/).length : 1)
    : 0;
  const required = isClick
    ? (params.dragTo != null ? 1 : Number.isInteger(params.count) ? params.count : 1)
    : isFill ? (Array.isArray(params.fields) ? params.fields.length : 0)
      : isScroll ? 1
        : (params.text ? 1 : 0) + (!params.text && params.clear ? 1 : 0) + keyUnits + (params.submit ? 1 : 0);
  if (!Number.isInteger(required) || required < 1 || required > 50) return null;
  let attempted = 0;
  let confirmed = 0;
  let uncertain = 0;
  let targetLabel;
  let targetElementId;
  let explicitSummary;
  return {
    observe(method, inputParams, status) {
      const mousePress = method === 'Input.dispatchMouseEvent' && inputParams?.type === 'mousePressed';
      const text = method === 'Input.insertText';
      const key = method === 'Input.dispatchKeyEvent'
        && ['keyDown', 'rawKeyDown'].includes(inputParams?.type)
        && !['Shift', 'Control', 'Alt', 'Meta'].includes(inputParams?.key)
        && !inputParams?.commands?.includes?.('selectAll');
      const wheel = method === 'Input.dispatchMouseEvent' && inputParams?.type === 'mouseWheel';
      const relevant = isClick ? mousePress : isType ? text || key : isScroll && wheel;
      if (!relevant || attempted >= required) return;
      attempted++;
      if (status === 'sent') confirmed++;
      else uncertain++;
    },
    setTargetLabel(value) { if (typeof value === 'string') targetLabel = value; },
    setTargetElementId(value) { if (typeof value === 'string') targetElementId = value; },
    setSummary(summary) { explicitSummary = summary; },
    summary() {
      const inputCounts = explicitSummary?.inputCounts ?? {
        confirmed: Math.min(confirmed, required),
        uncertain: Math.min(uncertain, Math.max(0, required - confirmed)),
        required,
      };
      const dispatchStatus = explicitSummary?.dispatchStatus ?? (uncertain > 0 ? 'unknown'
        : confirmed >= required ? 'sent'
          : confirmed > 0 ? 'partially_sent'
            : attempted === 0 ? 'not_sent' : 'unknown');
      return {
        targetLabel: targetLabel ?? explicitSummary?.targetLabel,
        targetElementId: targetElementId ?? explicitSummary?.targetElementId,
        dispatchStatus, inputCounts,
      };
    },
  };
}

export async function beginActivity(tool, params, activityContext) {
  if (!validActivityContext(tool, activityContext)) return null;
  const tabId = Number.isInteger(params?.tabId) ? params.tabId : null;
  const startedAt = new Date().toISOString();
  if (tabId == null) return { tool, params, activityContext, startedAt, deferred: true };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || typeof tab.url !== 'string') return null;
  const log = getActivityLog();
  const activity = { log, event: null, tool, params, activityContext, startedAt, deferred: false, eventPromise: null };
  activity.eventPromise = log.ensureVisit(tabId, tab.url).then((visit) => {
    if (!visit) return null;
    const event = {
      kind: 'action', schemaVersion: 1,
      eventId: activityContext.eventId,
      tabId, pageVisitId: visit.pageVisitId, host: visit.host,
      tool, operation: activityOperation(tool, params), startedAt,
      executionStatus: 'running',
      ...(activityContext.batchRunId ? { batchRunId: activityContext.batchRunId, batchStepIndex: activityContext.batchStepIndex } : {}),
    };
    activity.event = event;
    return log.append(event);
  }).catch(() => null);
  return activity;
}

function activityPatch(result, error, inputActivity) {
  const endedAt = new Date().toISOString();
  const patch = {
    endedAt,
    executionStatus: error || result?.success === false ? 'failed' : 'completed',
  };
  const kind = result?.navigated ? 'navigation'
    : result?.dialog ? 'dialog_open'
      : result?.download ? 'download_started' : null;
  if (kind) patch.siteEffect = { kind, observedAt: endedAt };
  const summary = inputActivity?.summary?.() ?? result?._activity;
  if (summary && typeof summary === 'object') {
    if (typeof summary.targetLabel === 'string') patch.targetLabel = summary.targetLabel;
    if (typeof summary.targetElementId === 'string') patch.targetElementId = summary.targetElementId;
    if (['not_sent', 'partially_sent', 'sent', 'unknown'].includes(summary.dispatchStatus)
      && summary.inputCounts && typeof summary.inputCounts === 'object') {
      patch.dispatchStatus = summary.dispatchStatus;
      patch.inputCounts = summary.inputCounts;
    }
  }
  return patch;
}

export async function finishActivity(activity, result, error, inputActivity) {
  if (!activity) return result;
  const { log } = activity;
  if (activity.deferred) {
    const tabId = Number.isInteger(result?.tabId) ? result.tabId : null;
    const url = typeof result?.url === 'string' ? result.url : null;
    if (tabId != null && url) {
      void getActivityLog().ensureVisit(tabId, url).then((visit) => {
        if (!visit) return null;
        const created = {
          kind: 'action', schemaVersion: 1, eventId: activity.activityContext.eventId,
          tabId, pageVisitId: visit.pageVisitId, host: visit.host,
          tool: activity.tool, operation: activityOperation(activity.tool, activity.params),
          startedAt: activity.startedAt, ...activityPatch(result, error, inputActivity),
          ...(activity.activityContext.batchRunId ? { batchRunId: activity.activityContext.batchRunId, batchStepIndex: activity.activityContext.batchStepIndex } : {}),
        };
        return getActivityLog().append(created);
      }).catch(() => {});
    }
  } else {
    const patch = activityPatch(result, error, inputActivity);
    void activity.eventPromise.then(() => {
      if (!activity.event) return null;
      return log.update(activity.event.eventId, patch);
    }).catch(() => {});
  }
  if (result && typeof result === 'object' && '_activity' in result) {
    const { _activity: _discarded, ...safe } = result;
    return safe;
  }
  return result;
}

function freshState() {
  return {
    schemaVersion: 1,
    events: [],
    currentVisits: [],
    historyTruncated: false,
    incompleteBatchRunIds: [],
    includeElementNames: true,
  };
}

function clone(value) {
  return structuredClone(value);
}

function validId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function boundedText(value, max) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
  return clean || undefined;
}

function hostFromUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const host = new URL(value).hostname.toLowerCase().slice(0, 255);
    return host && !/[/?#@]/.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

function validHost(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || /[/?#@\s]/.test(value)) return undefined;
  return value.toLowerCase();
}

function validTime(value) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function safeCounts(value) {
  if (!value || typeof value !== 'object') return undefined;
  const { confirmed, uncertain, required } = value;
  if (![confirmed, uncertain, required].every(Number.isInteger)
    || confirmed < 0 || uncertain < 0 || required < 1 || required > 50
    || confirmed > 50 || uncertain > 50 || confirmed + uncertain > required) return undefined;
  return { confirmed, uncertain, required };
}

function sanitizeEvent(raw, includeElementNames) {
  if (!raw || typeof raw !== 'object' || raw.kind !== 'action' || raw.schemaVersion !== 1
    || !validId(raw.eventId) || !Number.isInteger(raw.tabId) || raw.tabId < 0
    || !validId(raw.pageVisitId) || !validHost(raw.host)
    || typeof raw.tool !== 'string' || !TOOL_RE.test(raw.tool)
    || typeof raw.operation !== 'string' || !OPERATIONS.has(raw.operation)
    || !validTime(raw.startedAt) || !EXECUTION.has(raw.executionStatus)) return undefined;

  const event = {
    kind: 'action',
    schemaVersion: 1,
    eventId: raw.eventId,
    tabId: raw.tabId,
    pageVisitId: raw.pageVisitId,
    host: validHost(raw.host),
    tool: raw.tool,
    operation: raw.operation,
    startedAt: validTime(raw.startedAt),
    executionStatus: raw.executionStatus,
  };
  const endedAt = validTime(raw.endedAt);
  if (endedAt) event.endedAt = endedAt;
  const inputCounts = safeCounts(raw.inputCounts);
  if (DISPATCH.has(raw.dispatchStatus) && inputCounts) {
    event.dispatchStatus = raw.dispatchStatus;
    event.inputCounts = inputCounts;
  }
  if (includeElementNames) {
    const targetLabel = boundedText(raw.targetLabel, 160);
    if (targetLabel) event.targetLabel = targetLabel;
    const targetElementId = boundedText(raw.targetElementId, 160);
    if (targetElementId) event.targetElementId = targetElementId;
  }
  if (raw.siteEffect && SITE_EFFECTS.has(raw.siteEffect.kind)) {
    const observedAt = validTime(raw.siteEffect.observedAt);
    if (observedAt) event.siteEffect = { kind: raw.siteEffect.kind, observedAt };
  }
  if (validId(raw.batchRunId) && Number.isInteger(raw.batchStepIndex) && raw.batchStepIndex >= 1 && raw.batchStepIndex <= 50) {
    event.batchRunId = raw.batchRunId;
    event.batchStepIndex = raw.batchStepIndex;
    const batchEndedAt = validTime(raw.batchEndedAt);
    if (batchEndedAt && BATCH_EXECUTION.has(raw.batchExecutionStatus)) {
      event.batchEndedAt = batchEndedAt;
      event.batchExecutionStatus = raw.batchExecutionStatus;
    }
  }
  return event;
}

function normalizeVisit(raw) {
  if (!raw || !Number.isInteger(raw.tabId) || raw.tabId < 0 || !validId(raw.pageVisitId)) return undefined;
  const host = validHost(raw.host);
  return host ? { tabId: raw.tabId, pageVisitId: raw.pageVisitId, host } : undefined;
}

function normalizeState(raw) {
  const state = freshState();
  if (!raw || raw.schemaVersion !== 1) return state;
  state.includeElementNames = raw.includeElementNames !== false;
  state.historyTruncated = raw.historyTruncated === true;
  state.currentVisits = Array.isArray(raw.currentVisits)
    ? raw.currentVisits.map(normalizeVisit).filter(Boolean).slice(-ACTIVITY_VISIT_CAP)
    : [];
  state.events = Array.isArray(raw.events)
    ? raw.events.map((item) => sanitizeEvent(item, state.includeElementNames)).filter(Boolean).slice(-ACTIVITY_EVENT_CAP)
    : [];
  if (Array.isArray(raw.incompleteBatchRunIds)) {
    state.incompleteBatchRunIds = [...new Set(raw.incompleteBatchRunIds.filter(validId))].slice(-ACTIVITY_EVENT_CAP);
  }
  return state;
}

/**
 * Storage is injected for tests; production uses chrome.storage.session. Mutations are
 * serialized so clearing or hiding labels cannot be undone by an earlier queued write.
 */
export function createActivityLog(storageArea = globalThis.chrome?.storage?.session, options = {}) {
  if (!storageArea) throw new Error('chrome.storage.session is unavailable');
  const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
  let state = freshState();
  let loaded = false;
  let loadFailed = false;
  let storageError = false;
  let queue = Promise.resolve();

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const stored = await storageArea.get(ACTIVITY_STORAGE_KEY);
      state = normalizeState(stored?.[ACTIVITY_STORAGE_KEY]);
      state.events = state.events.map((event) => event.executionStatus === 'running'
        ? { ...event, executionStatus: 'unknown' }
        : event);
      const unfinished = state.events
        .filter((event) => event.batchRunId && !event.batchEndedAt)
        .map((event) => event.batchRunId);
      state.incompleteBatchRunIds = [...new Set([...state.incompleteBatchRunIds, ...unfinished])].slice(-ACTIVITY_EVENT_CAP);
    } catch {
      state = freshState();
      loadFailed = true;
      storageError = true;
    }
    loaded = true;
  }

  function enqueue(change) {
    const pending = queue.then(async () => {
      await ensureLoaded();
      const next = normalizeState(change(state));
      state = next;
      if (!loadFailed) {
        try {
          await storageArea.set({ [ACTIVITY_STORAGE_KEY]: clone(state) });
          storageError = false;
        } catch {
          storageError = true;
        }
      }
      return clone(state);
    });
    queue = pending.catch(() => undefined);
    return pending;
  }

  function makeVisit(tabId, url) {
    const host = hostFromUrl(url);
    if (!Number.isInteger(tabId) || tabId < 0 || !host) return undefined;
    return { tabId, pageVisitId: makeId(), host };
  }

  return {
    async get() {
      await ensureLoaded();
      await queue;
      return clone(state);
    },
    async getStatus() {
      const data = await this.get();
      return { data, storageError };
    },
    async ensureVisit(tabId, url) {
      let result;
      const next = await enqueue((current) => {
        result = current.currentVisits.find((visit) => visit.tabId === tabId);
        if (result) return current;
        result = makeVisit(tabId, url);
        if (!result) return current;
        return { ...current, currentVisits: [...current.currentVisits, result].slice(-ACTIVITY_VISIT_CAP) };
      });
      return result ?? next.currentVisits.find((visit) => visit.tabId === tabId);
    },
    async rotateVisit(tabId, url) {
      const visit = makeVisit(tabId, url);
      if (!visit) return undefined;
      const next = await enqueue((current) => ({
        ...current,
        currentVisits: [...current.currentVisits.filter((item) => item.tabId !== tabId), visit].slice(-ACTIVITY_VISIT_CAP),
      }));
      return next.currentVisits.find((item) => item.tabId === tabId);
    },
    async closeVisit(tabId) {
      return enqueue((current) => ({ ...current, currentVisits: current.currentVisits.filter((item) => item.tabId !== tabId) }));
    },
    async append(raw) {
      return enqueue((current) => {
        const event = sanitizeEvent(raw, current.includeElementNames);
        if (!event || current.events.some((item) => item.eventId === event.eventId)) return current;
        const events = [...current.events, event];
        const incomplete = new Set(current.incompleteBatchRunIds);
        if (event.batchRunId) incomplete.add(event.batchRunId);
        let historyTruncated = current.historyTruncated;
        while (events.length > ACTIVITY_EVENT_CAP) {
          const evicted = events.shift();
          historyTruncated = true;
          if (evicted.batchRunId && events.some((item) => item.batchRunId === evicted.batchRunId)) incomplete.add(evicted.batchRunId);
        }
        return { ...current, events, historyTruncated, incompleteBatchRunIds: [...incomplete].slice(-ACTIVITY_EVENT_CAP) };
      });
    },
    async update(eventId, patch) {
      return enqueue((current) => ({
        ...current,
        events: current.events.map((item) => item.eventId === eventId
          ? sanitizeEvent({ ...item, ...patch, eventId: item.eventId }, current.includeElementNames) ?? item
          : item),
      }));
    },
    async finishBatch(marker) {
      if (!marker || marker.kind !== 'batch-finished' || marker.schemaVersion !== 1 || !validId(marker.batchRunId)
        || !validTime(marker.endedAt) || !BATCH_EXECUTION.has(marker.executionStatus)) return this.get();
      return enqueue((current) => {
        if (!current.events.some((item) => item.batchRunId === marker.batchRunId)) return current;
        return {
          ...current,
          incompleteBatchRunIds: current.incompleteBatchRunIds.filter((id) => id !== marker.batchRunId),
          events: current.events.map((item) => item.batchRunId === marker.batchRunId
            ? { ...item, batchEndedAt: validTime(marker.endedAt), batchExecutionStatus: marker.executionStatus }
            : item),
        };
      });
    },
    async setElementNamesVisible(includeElementNames) {
      return enqueue((current) => ({
        ...current,
        includeElementNames: includeElementNames === true,
        events: includeElementNames === true
          ? current.events
          : current.events.map(({ targetLabel: _targetLabel, targetElementId: _targetElementId, ...item }) => item),
      }));
    },
    async clear() {
      return enqueue((current) => ({ ...current, events: [], historyTruncated: false, incompleteBatchRunIds: [] }));
    },
  };
}

let sharedActivityLog;
export function getActivityLog() {
  sharedActivityLog ??= createActivityLog();
  return sharedActivityLog;
}

export function finishActivityBatch(message) {
  const allowed = new Set(['type', 'schemaVersion', 'batchRunId', 'endedAt', 'executionStatus']);
  if (!message || Object.keys(message).some((key) => !allowed.has(key)) || message.schemaVersion !== 1
    || !validId(message.batchRunId) || !validTime(message.endedAt)
    || !BATCH_EXECUTION.has(message.executionStatus)) return false;
  void getActivityLog().finishBatch({
    kind: 'batch-finished', schemaVersion: 1,
    batchRunId: message.batchRunId, endedAt: message.endedAt, executionStatus: message.executionStatus,
  }).catch(() => {});
  return true;
}
