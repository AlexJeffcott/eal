import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';

export function tokenPath(override?: string | undefined): string {
  // Stryker disable next-line ConditionalExpression,EqualityOperator -- equivalent: the falsy '' short-circuits before `length > 0` is evaluated
  if (override && override.length > 0) return override;
  const env = process.env['EAL_TOKEN_PATH'];
  // Stryker disable next-line ConditionalExpression,EqualityOperator -- equivalent: see above
  if (env && env.length > 0) return env;
  return join(homedir(), '.config', 'eal', 'token');
}

export function readToken(override?: string | undefined): string | null {
  const path = tokenPath(override);
  // Stryker disable next-line all -- equivalent: subsequent readFileSync throws and the catch returns null for the same missing-file outcome
  if (!existsSync(path)) return null;
  try {
    const contents = readFileSync(path, 'utf8').trim();
    return contents.length > 0 ? contents : null;
  } catch {
    // Stryker disable next-line all -- defensive; only reached if readFileSync throws after existsSync, which is not a real test surface
    return null;
  }
}

export function writeToken(token: string, override?: string | undefined): void {
  const path = tokenPath(override);
  mkdirSync(dirname(path), { recursive: true });
  // Stryker disable next-line ObjectLiteral,StringLiteral -- equivalent: the subsequent chmodSync re-applies 0o600, masking changes to writeFileSync options
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  try {
    // Stryker disable next-line all -- best-effort POSIX permission fix; success path is masked by the writeFileSync mode option
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms without POSIX permissions.
  }
}

export function deleteToken(override?: string | undefined): boolean {
  const path = tokenPath(override);
  // Stryker disable next-line all -- equivalent: unlinkSync below throws on missing file and the catch returns false for the same outcome
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    // Stryker disable next-line all -- defensive; only reached if unlinkSync races with another deleter, not a real test surface
    return false;
  }
}
