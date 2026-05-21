import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';

export function tokenPath(override?: string | undefined): string {
  if (override && override.length > 0) return override;
  const env = process.env['EAL_TOKEN_PATH'];
  if (env && env.length > 0) return env;
  return join(homedir(), '.config', 'eal', 'token');
}

export function readToken(override?: string | undefined): string | null {
  const path = tokenPath(override);
  if (!existsSync(path)) return null;
  try {
    const contents = readFileSync(path, 'utf8').trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

export function writeToken(token: string, override?: string | undefined): void {
  const path = tokenPath(override);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms without POSIX permissions.
  }
}

export function deleteToken(override?: string | undefined): boolean {
  const path = tokenPath(override);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
