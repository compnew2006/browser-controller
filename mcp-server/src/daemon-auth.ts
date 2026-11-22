/**
 * The daemon's token check, extracted from `daemon.ts` (Task 8): the
 * daemon sits exactly on the 600-line maintenance gate, and the
 * task-question intercept needed room in `routeCall`, so this pure check
 * moved here instead of the file growing.
 */
import crypto from 'node:crypto';

/**
 * Whether the presented token is the daemon's token. Constant-time
 * compare with NO length early-return (audit timing leak): pad both to
 * a fixed size so timingSafeEqual always runs on equal-length buffers
 * and the comparison time doesn't reveal the token length. A length
 * mismatch short-circuits after a full-length compare, which leaks nothing.
 */
export function checkPresentedToken(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const FIXED = 128;
  const a = Buffer.alloc(FIXED);
  const b = Buffer.alloc(FIXED);
  a.write(presented);
  b.write(expected);
  return crypto.timingSafeEqual(a, b) && presented === expected;
}
