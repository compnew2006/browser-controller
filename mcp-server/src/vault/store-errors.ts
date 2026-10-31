import { formatError, type ErrorCode } from '../core/error-codes.js';

export class VaultStorageError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(formatError(code, message), options);
    this.name = 'VaultStorageError';
    this.code = code;
  }
}

/** A storage failure whose message names no secret path or value. */
export function fileError(code: ErrorCode, message: string): VaultStorageError {
  return new VaultStorageError(code, message);
}
