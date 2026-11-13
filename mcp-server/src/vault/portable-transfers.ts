import { ERROR_CODES } from '../core/error-codes.js';
import { VaultStorageError } from './store-errors.js';
import { randomId } from './types.js';
import { MAX_PORTABLE_ARCHIVE_BYTES } from './portable-format.js';

export const MAX_PORTABLE_CHUNK_BYTES = 256 * 1024;
export const MAX_PORTABLE_TRANSFER_COUNT = 2;
export const MAX_PORTABLE_TRANSFER_BYTES = 20 * 1024 * 1024;
export const PORTABLE_TRANSFER_IDLE_MS = 2 * 60_000;
export const PORTABLE_TRANSFER_LIFETIME_MS = 5 * 60_000;

type TransferDirection = 'export' | 'import';
type TransferState = 'exporting' | 'uploading' | 'ready' | 'previewing' | 'previewed' | 'committing';

interface TransferSession {
  readonly transferId: string;
  readonly connectionId: string;
  readonly direction: TransferDirection;
  readonly archive: Buffer;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly hardExpiresAt: number;
  lastActivityAt: number;
  nextOffset: number;
  state: TransferState;
  previewToken?: string;
}

function transferError(code: typeof ERROR_CODES[keyof typeof ERROR_CODES], message: string): VaultStorageError {
  return new VaultStorageError(code, message);
}

/** Connection-bound, bounded, in-memory transport for encrypted portable vault archives. */
export class PortableTransferSessions {
  private readonly sessions = new Map<string, TransferSession>();
  private readonly expiryTimer: ReturnType<typeof setInterval> | null;

  constructor(
    private readonly now: () => number = Date.now,
    sweepIntervalMs = 30_000,
    private readonly idleTimeoutMs = PORTABLE_TRANSFER_IDLE_MS,
    private readonly transferLifetimeMs = PORTABLE_TRANSFER_LIFETIME_MS,
  ) {
    this.expiryTimer = sweepIntervalMs > 0
      ? setInterval(() => this.expire(), sweepIntervalMs)
      : null;
    this.expiryTimer?.unref?.();
  }

  startExport(connectionId: string, archive: Buffer): { transferId: string; byteLength: number; chunkBytes: number } {
    this.expire();
    if (!Buffer.isBuffer(archive) || archive.length === 0) {
      throw transferError(ERROR_CODES.INVALID_ARGUMENT, 'portable export data is invalid');
    }
    if (archive.length > MAX_PORTABLE_ARCHIVE_BYTES) {
      archive.fill(0);
      throw transferError(ERROR_CODES.RESPONSE_TOO_LARGE, 'portable vault archive exceeds the supported size limit');
    }
    this.assertCapacity(connectionId, archive.length);
    const session = this.createSession(connectionId, 'export', archive, 'exporting');
    return { transferId: session.transferId, byteLength: session.byteLength, chunkBytes: MAX_PORTABLE_CHUNK_BYTES };
  }

  startImport(connectionId: string, byteLength: unknown): { transferId: string; chunkBytes: number } {
    this.expire();
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) <= 0) {
      throw transferError(ERROR_CODES.INVALID_ARGUMENT, 'portable archive size is invalid');
    }
    if ((byteLength as number) > MAX_PORTABLE_ARCHIVE_BYTES) {
      throw transferError(ERROR_CODES.RESPONSE_TOO_LARGE, 'portable vault archive exceeds the supported size limit');
    }
    this.assertCapacity(connectionId, byteLength as number);
    const archive = Buffer.alloc(byteLength as number);
    const session = this.createSession(connectionId, 'import', archive, 'uploading');
    return { transferId: session.transferId, chunkBytes: MAX_PORTABLE_CHUNK_BYTES };
  }

  readExportChunk(connectionId: string, transferId: string, offset: unknown): { offset: number; chunkBase64: string; done: boolean } {
    const session = this.ownedSession(connectionId, transferId, 'export');
    if (session.state !== 'exporting' || !Number.isSafeInteger(offset) || offset !== session.nextOffset) {
      throw transferError(ERROR_CODES.INVALID_ARGUMENT, 'portable export offset is invalid');
    }
    const start = session.nextOffset;
    const end = Math.min(start + MAX_PORTABLE_CHUNK_BYTES, session.byteLength);
    const chunkBase64 = session.archive.subarray(start, end).toString('base64');
    session.nextOffset = end;
    this.touch(session);
    const done = end === session.byteLength;
    if (done) this.remove(session);
    return { offset: start, chunkBase64, done };
  }

  appendImportChunk(
    connectionId: string,
    transferId: string,
    offset: unknown,
    chunkBase64: unknown,
  ): { received: number; done: boolean } {
    const session = this.ownedSession(connectionId, transferId, 'import');
    if (session.state !== 'uploading' || !Number.isSafeInteger(offset) || offset !== session.nextOffset
      || typeof chunkBase64 !== 'string' || chunkBase64.length === 0
      || chunkBase64.length > Math.ceil(MAX_PORTABLE_CHUNK_BYTES / 3) * 4) {
      throw transferError(ERROR_CODES.INVALID_ARGUMENT, 'portable import chunk is invalid');
    }
    const chunk = Buffer.from(chunkBase64, 'base64');
    try {
      if (chunk.toString('base64') !== chunkBase64 || chunk.length === 0 || chunk.length > MAX_PORTABLE_CHUNK_BYTES
        || chunk.length > session.byteLength - session.nextOffset) {
        throw transferError(ERROR_CODES.INVALID_ARGUMENT, 'portable import chunk encoding is invalid');
      }
      chunk.copy(session.archive, session.nextOffset);
      session.nextOffset += chunk.length;
      this.touch(session);
      const done = session.nextOffset === session.byteLength;
      if (done) session.state = 'ready';
      return { received: session.nextOffset, done };
    } finally {
      chunk.fill(0);
    }
  }

  beginImportPreview(connectionId: string, transferId: string): { previewToken: string; archive: Buffer } {
    const session = this.ownedSession(connectionId, transferId, 'import');
    if (session.state !== 'ready' || session.nextOffset !== session.byteLength) {
      throw transferError(ERROR_CODES.INVALID_ARGUMENT, 'portable import upload is incomplete');
    }
    session.previewToken = randomId('pvi');
    session.state = 'previewing';
    this.touch(session);
    return { previewToken: session.previewToken, archive: session.archive };
  }

  finishImportPreview(connectionId: string, transferId: string, previewToken: string, success: boolean): void {
    const session = this.ownedSession(connectionId, transferId, 'import');
    if (session.state !== 'previewing' || session.previewToken !== previewToken) {
      throw transferError(ERROR_CODES.VAULT_PERMISSION_DENIED, 'portable import preview is no longer current');
    }
    if (success) {
      session.state = 'previewed';
    } else {
      session.state = 'ready';
      delete session.previewToken;
    }
    this.touch(session);
  }

  beginImportCommit(connectionId: string, previewToken: string): { transferId: string; archive: Buffer } {
    this.expire();
    const session = [...this.sessions.values()].find((candidate) => candidate.previewToken === previewToken);
    if (!session || session.direction !== 'import' || session.connectionId !== connectionId) {
      throw transferError(ERROR_CODES.VAULT_PERMISSION_DENIED, 'portable import preview is not available to this connection');
    }
    if (session.state !== 'previewed') {
      throw transferError(ERROR_CODES.VAULT_PERMISSION_DENIED, 'portable import preview is no longer current');
    }
    session.state = 'committing';
    this.touch(session);
    return { transferId: session.transferId, archive: session.archive };
  }

  finishImportCommit(connectionId: string, transferId: string, previewToken: string, success: boolean): void {
    const session = this.ownedSession(connectionId, transferId, 'import');
    if (session.state !== 'committing' || session.previewToken !== previewToken) {
      throw transferError(ERROR_CODES.VAULT_PERMISSION_DENIED, 'portable import preview is no longer current');
    }
    if (success) this.remove(session);
    else {
      session.state = 'previewed';
      this.touch(session);
    }
  }

  /** A cancel from another connection is a no-op, so it cannot probe or clear another owner's transfer. */
  cancel(connectionId: string, transferIdOrToken: unknown): boolean {
    this.expire();
    if (typeof transferIdOrToken !== 'string') return false;
    const session = this.sessions.get(transferIdOrToken)
      ?? [...this.sessions.values()].find((candidate) => candidate.previewToken === transferIdOrToken);
    if (!session || session.connectionId !== connectionId) return false;
    this.remove(session);
    return true;
  }

  clearConnection(connectionId: string): void {
    for (const session of this.sessions.values()) {
      if (session.connectionId === connectionId) this.remove(session);
    }
  }

  clearAll(): void {
    for (const session of this.sessions.values()) this.remove(session);
  }

  dispose(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.clearAll();
  }

  private createSession(connectionId: string, direction: TransferDirection, archive: Buffer, state: TransferState): TransferSession {
    const now = this.now();
    const session: TransferSession = {
      transferId: randomId('ptx'),
      connectionId,
      direction,
      archive,
      byteLength: archive.length,
      createdAt: now,
      lastActivityAt: now,
      hardExpiresAt: now + this.transferLifetimeMs,
      nextOffset: 0,
      state,
    };
    this.sessions.set(session.transferId, session);
    return session;
  }

  private assertCapacity(connectionId: string, bytes: number): void {
    const active = [...this.sessions.values()];
    if (active.some((session) => session.connectionId === connectionId)
      || active.length >= MAX_PORTABLE_TRANSFER_COUNT
      || active.reduce((total, session) => total + session.byteLength, bytes) > MAX_PORTABLE_TRANSFER_BYTES) {
      throw transferError(ERROR_CODES.VAULT_BUSY, 'another portable vault transfer is active or the memory limit is full');
    }
  }

  private ownedSession(connectionId: string, transferId: string, direction: TransferDirection): TransferSession {
    this.expire();
    const session = this.sessions.get(transferId);
    if (!session || session.direction !== direction) {
      throw transferError(ERROR_CODES.VAULT_PERMISSION_DENIED, 'portable vault transfer is not available');
    }
    if (session.connectionId !== connectionId) {
      throw transferError(ERROR_CODES.VAULT_PERMISSION_DENIED, 'portable vault transfer belongs to another connection');
    }
    return session;
  }

  private touch(session: TransferSession): void {
    session.lastActivityAt = this.now();
  }

  private remove(session: TransferSession): void {
    session.archive.fill(0);
    this.sessions.delete(session.transferId);
  }

  private expire(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now >= session.hardExpiresAt || now - session.lastActivityAt >= this.idleTimeoutMs) this.remove(session);
    }
  }
}
