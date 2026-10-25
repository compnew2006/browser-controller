import { VaultService } from './service.js';
import { isRecord } from './service-common.js';
import { isCredentialVaultPath } from './protected-paths.js';

const INTERNAL_VAULT_TOOL_NAMES = new Set([
  'browser_vault_internal_inspect', 'browser_vault_internal_fill',
  'browser_vault_internal_open_ui', 'browser_vault_internal_protection_reset',
]);

interface VaultAwareBridge {
  vaultTransport: { selectBrowser(sessionId: string, browser: unknown): unknown };
  callTool(tool: string, params: Record<string, unknown>, sessionId: string, signal: AbortSignal, agentName: string): Promise<unknown>;
}

export interface RoutedCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

interface RouteOptions {
  bridge: VaultAwareBridge;
  vaultService: VaultService;
  sessionId: string;
  agentName: string;
  tool: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
}

function safeErrorText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (isRecord(value) && typeof value.message === 'string') {
    return `${typeof value.code === 'string' ? `${value.code}: ` : ''}${value.message}`.slice(0, 2_000);
  }
  return 'VAULT_PERMISSION_DENIED: the result could not be safely returned';
}

/** Applies profile selection, vault authorization and result scrubbing at the daemon boundary. */
export async function routeVaultAwareCall(options: RouteOptions): Promise<RoutedCallResult> {
  const { bridge, vaultService, sessionId, agentName, tool, signal } = options;
  let params = options.params;
  let pinnedBrowserId: string | undefined;
  let releaseRedaction: (() => void) | undefined;
  const sanitize = (value: unknown) => vaultService.sanitizeForSession(sessionId, value, tool, pinnedBrowserId);
  try {
    if (tool === 'browser_tabs' && params.browser !== undefined) {
      bridge.vaultTransport.selectBrowser(sessionId, params.browser);
      const { browser: _selectedBrowser, ...withoutSelector } = params;
      params = withoutSelector;
    }
    try {
      pinnedBrowserId = await vaultService.pinBrowserId(sessionId, agentName);
      if (tool !== 'browser_vault') releaseRedaction = vaultService.retainRedactionForBrowser(pinnedBrowserId);
    } catch (error) {
      // Keep the bridge's established NOT_CONNECTED diagnosis for ordinary tools.
      if (tool === 'browser_vault') throw error;
    }
    if (INTERNAL_VAULT_TOOL_NAMES.has(tool) || tool.startsWith('browser_vault_internal_')) {
      throw new Error('VAULT_PERMISSION_DENIED: private vault actions are daemon-owned');
    }

    let result: unknown;
    if (tool === 'browser_vault') {
      result = await vaultService.handlePublic(sessionId, params, signal);
    } else {
      if (tool === 'browser_fill' && Array.isArray(params.fields)) await assertVaultPathsNotUploaded(params.fields);
      await vaultService.assertToolAllowed(sessionId, tool, params);
      result = await bridge.callTool(tool, params, sessionId, signal, agentName);
    }
    return { success: true, result: await sanitize(result) };
  } catch (error) {
    const rawError = String(error instanceof Error ? error.message : error);
    const sanitizedError = await sanitize(rawError);
    const payload = (error as { result?: unknown })?.result;
    const sanitizedPayload = payload === undefined ? undefined : await sanitize(payload);
    return {
      success: false,
      error: safeErrorText(sanitizedError),
      ...(sanitizedPayload !== undefined ? { result: sanitizedPayload } : {}),
    };
  } finally {
    releaseRedaction?.();
  }
}

async function assertVaultPathsNotUploaded(fields: unknown[]): Promise<void> {
  for (const field of fields) {
    if (!isRecord(field) || !Array.isArray(field.value)) continue;
    for (const candidate of field.value) {
      if (typeof candidate === 'string' && await isCredentialVaultPath(candidate)) {
        throw new Error('FILE_NOT_ALLOWED: credential vault files cannot be uploaded.');
      }
    }
  }
}
