import { AsyncLocalStorage } from 'node:async_hooks';
import { randomInt } from 'node:crypto';

/**
 * A small structured logger: one scope, one line per event, and a correlation
 * id that ties the lines of one request together.
 *
 * Why it exists: the daemon, the bridge and the MCP client each used raw
 * `console.error` calls, so a failure could not be followed from the call the
 * agent made to the extension that answered it. Every line now carries the id
 * of the request it belongs to.
 *
 * Two rules the format keeps:
 *   - The scope prefix stays the first token (`[Bridge]`, `[browser-controller]`),
 *     so the log reads the way it did before.
 *   - The message text is unchanged; the correlation id is only an extra field
 *     after it.
 *
 * Every level goes to stderr: the daemon's log is captured from stderr, and in
 * the MCP client stdout is the transport to the agent, so nothing may write
 * there.
 */

/** The extra fields a logger adds to every line. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** A short random id: 8 base36 characters. */
export function newCorrelationId(): string {
  let id = '';
  for (let i = 0; i < 8; i++) id += randomInt(36).toString(36);
  return id;
}

/**
 * The correlation id of the request in flight, if any.
 *
 * It is kept in an async context rather than in a module variable, so two
 * requests running at the same time never share one id — and a line logged
 * from a promise chain started inside a request still belongs to it.
 */
const ambient = new AsyncLocalStorage<string>();

/** The correlation id of the request in flight, or null outside any request. */
export function currentCorrelationId(): string | null {
  return ambient.getStore() ?? null;
}

/**
 * Run `fn` with `correlationId` bound as the id of the request in flight.
 * Everything logged inside `fn` — by this module or by any other that asks
 * for the ambient id — carries it.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return ambient.run(correlationId, fn);
}

export interface Logger {
  /** The scope every line of this logger starts with. */
  readonly scope: string;
  /** The id this logger pins to its lines, if any. */
  readonly correlationId: string | null;
  error(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  debug(message: string, ...extra: unknown[]): void;
  /** A logger that adds these fields to every line. */
  child(fields: LogFields): Logger;
  /** A logger that pins every line to this correlation id. */
  withCorrelationId(correlationId: string): Logger;
}

/** One field of a line: `key=value`. A missing value is left out. */
function formatField(key: string, value: string | number | boolean | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return `${key}=${String(value)}`;
}

class ScopedLogger implements Logger {
  constructor(
    readonly scope: string,
    readonly correlationId: string | null,
    private readonly ownFields: LogFields,
  ) {}

  /** The pinned id, or the id of the request in flight. */
  private id(): string | null {
    return this.correlationId ?? currentCorrelationId();
  }

  private write(message: string, extra: unknown[]): void {
    const id = this.id();
    const fields = id === null ? '' : ` cid=${id}`;
    const rest = Object.entries(this.ownFields)
      .map(([key, value]) => formatField(key, value))
      .filter((field): field is string => field !== null);
    const suffix = rest.length ? ` ${rest.join(' ')}` : '';
    console.error(`[${this.scope}] ${message}${fields}${suffix}`, ...extra);
  }

  error(message: string, ...extra: unknown[]): void {
    this.write(message, extra);
  }

  warn(message: string, ...extra: unknown[]): void {
    this.write(message, extra);
  }

  info(message: string, ...extra: unknown[]): void {
    this.write(message, extra);
  }

  debug(message: string, ...extra: unknown[]): void {
    this.write(message, extra);
  }

  child(fields: LogFields): Logger {
    return new ScopedLogger(this.scope, this.correlationId, { ...this.ownFields, ...fields });
  }

  withCorrelationId(correlationId: string): Logger {
    return new ScopedLogger(this.scope, correlationId, this.ownFields);
  }
}

/**
 * A logger for one scope. Its lines carry the id of the request in flight,
 * unless the logger is pinned to an id of its own.
 */
export function createLogger(scope: string, options: { correlationId?: string; fields?: LogFields } = {}): Logger {
  return new ScopedLogger(scope, options.correlationId ?? null, options.fields ?? {});
}
