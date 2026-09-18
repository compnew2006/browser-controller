import { resolveTab, safeExec } from '../lib/page-exec.js';
import {
  observationSnapshots,
  persistSessionState,
} from '../lib/state.js';
import {
  actionError,
  createPageV2Helpers,
  inferAllowedActions,
  PAGE_ACT_V2,
  PAGE_OBSERVE_V2,
  validateActionArguments,
} from '../lib/observation-v2.js';
import { SNAPSHOT_MAX_ENTRIES, SNAPSHOT_TTL_MS } from '../lib/snapshot-registry.js';
import { handleUploadFile } from './cdp.js';

const sessionKey = (sessionId) => String(sessionId || 'anonymous');

function snapshotId() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `s_${random}`;
}

async function tabOrError(tabId) {
  try {
    return { tab: await resolveTab(tabId) };
  } catch (error) {
    return {
      error: actionError('TAB_NOT_FOUND', error?.message || `Tab ${tabId} was not found.`, { tabId }),
    };
  }
}

export async function handleObserve(params = {}, sessionId, _agentName, signal) {
  const { tabId, mode = 'compact' } = params;
  if (mode !== 'compact') {
    return actionError('INVALID_ACTION_ARGUMENTS', 'Phase 1 supports mode:"compact" only.', {
      requestedMode: mode,
      supportedModes: ['compact'],
    });
  }
  const resolved = await tabOrError(tabId);
  if (resolved.error) return resolved.error;
  if (signal?.aborted) return actionError('STALE_STATE', 'Observation was cancelled.');

  const id = snapshotId();
  const createdAt = Date.now();
  const result = await safeExec(tabId, PAGE_OBSERVE_V2, [{
    snapshotId: id,
    sessionId: sessionKey(sessionId),
    mode,
    maxElements: Math.min(1000, Math.max(1, Number(params.maxElements) || 500)),
    maxSnapshots: SNAPSHOT_MAX_ENTRIES,
    ttlMs: SNAPSHOT_TTL_MS,
    now: createdAt,
  }, createPageV2Helpers.toString(), inferAllowedActions.toString()]);
  if (signal?.aborted) return actionError('STALE_STATE', 'Observation was cancelled.');
  if (!result?.success || !result.documentId || !result.documentVersion) {
    return result?.success === false
      ? result
      : actionError('STALE_STATE', 'The page did not produce a coherent observation.');
  }

  observationSnapshots.register({
    snapshotId: id,
    tabId,
    sessionId: sessionKey(sessionId),
    documentId: result.documentId,
    documentVersion: result.documentVersion,
    routeEpoch: result.routeEpoch,
    url: result.url,
    createdAt,
  });
  persistSessionState();
  return { ...result, tabId };
}

export async function handleAct(params = {}, sessionId, _agentName, signal) {
  if (!params || typeof params !== 'object') {
    return actionError('INVALID_ACTION_ARGUMENTS', 'Action parameters must be an object.');
  }
  const argumentsResult = validateActionArguments(params);
  if (!argumentsResult.ok) return argumentsResult;
  if (typeof params.snapshotId !== 'string' || !params.snapshotId.trim()) {
    return actionError('INVALID_ACTION_ARGUMENTS', 'snapshotId is required.', { missing: 'snapshotId' });
  }
  const ownership = observationSnapshots.validate(params.snapshotId, params.tabId, sessionKey(sessionId));
  if (!ownership.ok) return { success: false, ...ownership };
  const resolved = await tabOrError(params.tabId);
  if (resolved.error) return resolved.error;
  if (signal?.aborted) {
    return actionError('STALE_STATE', 'Action was cancelled before it could complete.', {
      actionOutcome: 'not_completed',
    });
  }

  let result;
  try {
    result = await safeExec(params.tabId, PAGE_ACT_V2, [{
      snapshotId: params.snapshotId,
      sessionId: sessionKey(sessionId),
      documentId: ownership.snapshot.documentId,
      routeEpoch: ownership.snapshot.routeEpoch,
      ttlMs: SNAPSHOT_TTL_MS,
      params,
    }, createPageV2Helpers.toString(), inferAllowedActions.toString()]);
  } catch (error) {
    const message = error?.message || String(error);
    if (/context.*invalidated|frame.*removed|page.*navigat/i.test(message)) {
      return actionError('STALE_STATE', 'The page changed while the action was being dispatched; its outcome is unknown.', {
        tabId: params.tabId,
        action: params.action,
        ref: params.ref,
        documentVersion: ownership.snapshot.documentVersion,
        navigationDetected: true,
        documentChanged: true,
        actionOutcome: 'unknown',
      });
    }
    throw error;
  }
  if (signal?.aborted) {
    if (result?.success && !result.preparedUpload) {
      return { ...result, tabId: params.tabId, cancelledAfterDispatch: true };
    }
    return actionError('STALE_STATE', 'Action was cancelled before it could complete.', {
      actionOutcome: 'not_completed',
    });
  }
  if (!result?.success) return result || actionError('STALE_STATE', 'The page returned no action result.');

  if (result.preparedUpload) {
    let upload;
    try {
      upload = await handleUploadFile({
        tabId: params.tabId,
        selector: result.selector,
        filePath: params.filePath,
        files: params.files,
      });
    } catch (error) {
      const message = error?.message || String(error);
      if (/tab .*not found|no tab with id/i.test(message)) {
        return actionError('TAB_NOT_FOUND', 'The tab closed during the upload handoff.', { tabId: params.tabId });
      }
      if (/does not accept multiple|filePath or files required/i.test(message)) {
        return actionError('INVALID_ACTION_ARGUMENTS', 'The file selection is incompatible with this input.', {
          invalid: 'files',
        });
      }
      return actionError('STALE_STATE', 'The file input changed during the upload handoff; observe again.', {
        ref: params.ref,
        reason: 'UPLOAD_HANDOFF_FAILED',
      });
    }
    return {
      ...result,
      ...upload,
      ok: true,
      tabId: params.tabId,
      metrics: {
        ...result.metrics,
        // Initial safe-action injection + target recheck + four CDP commands
        // + best-effort input/change dispatch.
        protocolCalls: 7,
      },
    };
  }
  return { ...result, tabId: params.tabId };
}
