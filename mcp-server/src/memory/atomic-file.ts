/**
 * The atomic write now lives in the shared JSON-store engine
 * (`core/json-store.ts`). This module keeps the old import path working for
 * the memory policy writers.
 */
export { AtomicWriteAborted, atomicWriteFile, fsyncDirectory, type AtomicWriteOptions } from '../core/json-store.js';
