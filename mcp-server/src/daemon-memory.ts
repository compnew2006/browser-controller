import { createLogger } from './core/logger.js';
import type { MemoryCall, MemoryCallOutcome, MemoryService } from './memory/service.js';

const log = createLogger('browser-controller-daemon');

/** A reminder is optional; the routed result has already passed vault sanitization. */
export async function withSafeReminder(memory: MemoryService, call: MemoryCall, outcome: MemoryCallOutcome): Promise<unknown> {
  try {
    return await memory.withReminder(call, outcome);
  } catch {
    log.warn('memory reminder failed');
    return outcome.result;
  }
}

/** Observation cannot change a result already delivered to the caller. */
export function observeAfterReply(memory: MemoryService, call: MemoryCall, outcome: MemoryCallOutcome): void {
  try {
    memory.afterCall(call, outcome);
  } catch {
    log.warn('memory observation failed');
  }
}
