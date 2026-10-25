import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** True for the vault store/key/backup tree, including symlink aliases. */
export async function isCredentialVaultPath(candidate: string): Promise<boolean> {
  const stateDir = process.env.BC_STATE_DIR || path.join(os.homedir(), '.browser-controller');
  const lexicalRoot = path.resolve(stateDir, 'vault');
  const lexicalCandidate = path.resolve(candidate.startsWith('~/') ? path.join(os.homedir(), candidate.slice(2)) : candidate);
  if (inside(lexicalRoot, lexicalCandidate)) return true;
  const [realRoot, realCandidate] = await Promise.all([
    realpath(lexicalRoot).catch(() => lexicalRoot),
    realpath(lexicalCandidate).catch(() => lexicalCandidate),
  ]);
  return inside(realRoot, realCandidate) || inside(lexicalRoot, realCandidate);
}
