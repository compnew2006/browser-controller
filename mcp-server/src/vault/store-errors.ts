export class VaultStorageError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'VaultStorageError';
  }
}
