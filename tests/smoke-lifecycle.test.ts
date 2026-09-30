import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/smoke-real-chrome.mjs'), 'utf8');

describe('real Chrome smoke lifecycle', () => {
  it('uses the systemd user service when it owns the daemon', () => {
    expect(script).toContain("SYSTEMD_SERVICE = 'browser-controller-daemon.service'");
    expect(script).toContain("['--user', 'restart', SYSTEMD_SERVICE]");
    expect(script).toContain('if (managedDaemon)');
  });
});
