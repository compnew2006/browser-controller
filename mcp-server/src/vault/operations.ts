import type { PendingOperation } from './service-common.js';

/** What an operation carries besides its id: exactly the fields a cancellation predicate may match on. */
export type OperationMetadata = Pick<PendingOperation, 'scope'>
  & Partial<Pick<PendingOperation, 'sessionId' | 'connectionId' | 'grantId' | 'credentialId'>>;

/**
 * Every in-flight vault operation, keyed by request or fill id.
 *
 * Pure bookkeeping: a map, one AbortController per operation, and one promise
 * that resolves when the operation ends. It knows nothing about grants,
 * requests, or the transport — which is the point (ADR-02): a cancellation
 * policy can be reasoned about, and tested, without any of them.
 */
export class OperationRegistry {
  private readonly operations = new Map<string, PendingOperation>();

  /**
   * Starts tracking `id`. A caller that already owns the completion promise
   * passes it as `completion`, so the operation resolves when the caller says.
   */
  track(
    id: string,
    metadata: OperationMetadata,
    parentSignal?: AbortSignal,
    completion?: Pick<PendingOperation, 'done' | 'resolveDone'>,
  ): PendingOperation {
    let resolveDone = completion?.resolveDone;
    const done = completion?.done ?? new Promise<void>((resolve) => { resolveDone = resolve; });
    const operation: PendingOperation = {
      ...metadata,
      controller: new AbortController(),
      done,
      resolveDone: resolveDone!,
    };
    if (parentSignal) {
      operation.parentSignal = parentSignal;
      operation.parentAbortHandler = () => operation.controller.abort();
      if (parentSignal.aborted) operation.controller.abort();
      else parentSignal.addEventListener('abort', operation.parentAbortHandler, { once: true });
    }
    this.operations.set(id, operation);
    return operation;
  }

  get(id: string): PendingOperation | undefined {
    return this.operations.get(id);
  }

  /** Stops tracking `id` and resolves its `done`. Unknown ids are ignored, so a double complete is harmless. */
  complete(id: string): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    this.operations.delete(id);
    if (operation.parentSignal && operation.parentAbortHandler) {
      operation.parentSignal.removeEventListener('abort', operation.parentAbortHandler);
    }
    operation.resolveDone();
  }

  /** The abort signal bound to `id`, if that operation is still running. */
  signalFor(id: string): AbortSignal | undefined {
    return this.operations.get(id)?.controller.signal;
  }

  /** Aborts `id` alone; a caller that needs completion also awaits `waitForMatching`. */
  abort(id: string): void {
    this.operations.get(id)?.controller.abort();
  }

  /** Aborts in-flight work now; a caller that needs completion also awaits `waitForMatching`. */
  abortMatching(predicate: (operation: PendingOperation) => boolean): void {
    for (const operation of this.operations.values()) if (predicate(operation)) operation.controller.abort();
  }

  /** Resolves once every matching operation has been completed by its owner. */
  async waitForMatching(predicate: (operation: PendingOperation) => boolean): Promise<void> {
    const operations = [...this.operations.values()].filter(predicate);
    await Promise.all(operations.map((operation) => operation.done));
  }
}
