export class VaultStorageError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'VaultStorageError';
  }
}

/** A storage failure whose message names no secret path or value. */
export function fileError(code: string, message: string): VaultStorageError {
  return new VaultStorageError(code, message);
}
