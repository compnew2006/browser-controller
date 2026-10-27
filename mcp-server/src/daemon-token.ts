import { readToken } from './daemon-config.js';

/**
 * The token a thin MCP client sends in its hello. `npm run pairing:rotate`
 * rewrites token.json while clients run, so the file is re-read before every
 * (re)connect; a client exits on denial only when the file holds no newer token.
 */
export class ClientToken {
  private current: string;
  private readonly read: () => string | null;

  constructor(initial: string, read: () => string | null = readToken) {
    this.current = initial;
    this.read = read;
  }

  get value(): string { return this.current; }

  /** Adopt the token now in the file, if any. */
  refresh(): void {
    const fresh = this.read();
    if (fresh) this.current = fresh;
  }

  /** After a denial of `used`: true (and adopted) when the file holds a different token. */
  shouldRetryAfterDenial(used: string): boolean {
    const fresh = this.read();
    if (!fresh || fresh === used) return false;
    this.current = fresh;
    return true;
  }
}
