import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('managed daemon deployment contract', () => {
  it('supports a connect-only thin-client mode', () => {
    const source = fs.readFileSync(path.join(root, 'mcp-server/src/index.ts'), 'utf8');
    expect(source).toContain('BROWSER_CONTROLLER_DAEMON_MODE');
    expect(source).toContain('CONNECT_ONLY_DAEMON');
    expect(source).toContain('waiting for managed daemon');
  });

  it('ships a systemd user unit for the shared daemon', () => {
    const unit = fs.readFileSync(path.join(root, 'deploy/systemd/browser-controller-daemon.service'), 'utf8');
    expect(unit).toContain('mcp-server/dist/daemon.js');
    expect(unit).toContain('Restart=always');
  });
});
