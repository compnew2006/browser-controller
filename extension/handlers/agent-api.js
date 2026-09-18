import { resolveTab, safeExec } from '../lib/page-exec.js';
import {
  observationSnapshots,
  persistSessionState,
} from '../lib/state.js';
import {
  actionError,
  PAGE_ACT_V2,
  PAGE_OBSERVE_V2,
  PAGE_V2_INSTALL,
  validateActionArguments,
} from '../lib/observation-v2.js';
import { SNAPSHOT_MAX_ENTRIES, SNAPSHOT_TTL_MS } from '../lib/snapshot-registry.js';
import { handleUploadFile } from './cdp.js';

const sessionKey = (sessionId) => String(sessionId || 'anonymous');

/**
 * Install the (idempotent) page runtime, then run the observe/act entrypoint.
 * Both are passed as chrome.scripting `func:` so Chrome executes their source
 * natively — rebuilding helpers with eval() would throw in every isolated
 * world, whose CSP is script-src 'self' without unsafe-eval.
 */
async function execPageV2(tabId, func, args) {
  await safeExec(tabId, PAGE_V2_INSTALL, []);
  return safeExec(tabId, func, args);
}

/** Report protocol calls honestly: page-side metric + the install round trip. */
function withInstallRoundTrip(result) {
  const protocolCalls = (result?.metrics?.protocolCalls ?? 0) + 1;
  return { ...result, metrics: { ...result?.metrics, protocolCalls } };
}

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
  const result = await execPageV2(tabId, PAGE_OBSERVE_V2, [{
    snapshotId: id,
    sessionId: sessionKey(sessionId),
    mode,
    maxElements: Math.min(1000, Math.max(1, Number(params.maxElements) || 500)),
    maxSnapshots: SNAPSHOT_MAX_ENTRIES,
    ttlMs: SNAPSHOT_TTL_MS,
    now: createdAt,
  }]);
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
  return withInstallRoundTrip({ ...result, tabId });
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
    result = await execPageV2(params.tabId, PAGE_ACT_V2, [{
      snapshotId: params.snapshotId,
      sessionId: sessionKey(sessionId),
      documentId: ownership.snapshot.documentId,
      routeEpoch: ownership.snapshot.routeEpoch,
      ttlMs: SNAPSHOT_TTL_MS,
      params,
    }]);
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
        // Runtime install + safe-action injection + target recheck + four CDP
        // commands + best-effort input/change dispatch.
        protocolCalls: 8,
      },
    };
  }
  return withInstallRoundTrip({ ...result, tabId: params.tabId });
}
