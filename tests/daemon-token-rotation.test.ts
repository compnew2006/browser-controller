import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let stateDir: string;
const writeToken = (token: string) => fs.writeFileSync(path.join(stateDir, 'token.json'), JSON.stringify({ token, createdAt: 1 }), { mode: 0o600 });

async function load() {
  vi.resetModules();
  return import('../mcp-server/src/daemon-token.js');
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-token-'));
  vi.stubEnv('BC_STATE_DIR', stateDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('thin client token rotation (AC-V3)', () => {
  it('a denial with a changed token file retries with the new token', async () => {
    writeToken('old-token');
    const { ClientToken } = await load();
    const tokens = new ClientToken('old-token');
    const used = tokens.value;
    writeToken('new-token');
    expect(tokens.shouldRetryAfterDenial(used)).toBe(true);
    expect(tokens.value).toBe('new-token');
  });

  it('a denial with an unchanged token file does not retry (the caller exits)', async () => {
    writeToken('same-token');
    const { ClientToken } = await load();
    const tokens = new ClientToken('same-token');
    expect(tokens.shouldRetryAfterDenial(tokens.value)).toBe(false);
  });

  it('a missing token file does not retry and keeps the held token', async () => {
    const { ClientToken } = await load();
    const tokens = new ClientToken('held');
    expect(tokens.shouldRetryAfterDenial('held')).toBe(false);
    tokens.refresh();
    expect(tokens.value).toBe('held');
  });

  it('refresh() picks up a rotated token before the next hello', async () => {
    writeToken('old-token');
    const { ClientToken } = await load();
    const tokens = new ClientToken('old-token');
    writeToken('rotated');
    tokens.refresh();
    expect(tokens.value).toBe('rotated');
  });
});
