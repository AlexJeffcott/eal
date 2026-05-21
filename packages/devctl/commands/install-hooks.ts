import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const HOOKS_DIR = resolve(ROOT, '.git/hooks');

const PRE_COMMIT = `#!/usr/bin/env bash
# eal pre-commit hook — fast guards (~3s)
# Installed by: bun devctl install-hooks
set -e
cd "$(git rev-parse --show-toplevel)"
echo "[pre-commit] devctl check"
bun devctl check
echo "[pre-commit] devctl test unit"
bun devctl test unit
`;

const PRE_PUSH = `#!/usr/bin/env bash
# eal pre-push hook — full sweep (~30s)
# Installed by: bun devctl install-hooks
set -e
cd "$(git rev-parse --show-toplevel)"
echo "[pre-push] devctl check"
bun devctl check
echo "[pre-push] devctl test all"
bun devctl test all
`;

function writeHook(name: string, content: string): void {
  const path = resolve(HOOKS_DIR, name);
  writeFileSync(path, content, { encoding: 'utf8' });
  chmodSync(path, 0o755);
  console.log(`  wrote ${path}`);
}

export async function installHooksCmd(_args: string[]): Promise<number> {
  if (!existsSync(resolve(ROOT, '.git'))) {
    console.error('devctl install-hooks: no .git directory at repo root. Run `git init` first.');
    return 1;
  }
  mkdirSync(HOOKS_DIR, { recursive: true });
  console.log('devctl install-hooks: writing git hooks');
  writeHook('pre-commit', PRE_COMMIT);
  writeHook('pre-push', PRE_PUSH);
  console.log('devctl install-hooks: ok');
  return 0;
}
