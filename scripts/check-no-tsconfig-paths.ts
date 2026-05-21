#!/usr/bin/env bun

/**
 * Bans `paths` entries in any tsconfig.json. We use Bun workspaces; path aliases create
 * silent divergence between what TypeScript and Bun resolve.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Violation {
  file: string;
  reason: string;
}

const violations: Violation[] = [];

async function scanDirectory(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      await scanDirectory(fullPath);
    } else if (entry.isFile() && (entry.name === 'tsconfig.json' || entry.name.startsWith('tsconfig.') && entry.name.endsWith('.json'))) {
      await scanFile(fullPath);
    }
  }
}

async function scanFile(filePath: string): Promise<void> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (/"paths"\s*:/.test(stripped)) {
    violations.push({ file: filePath, reason: '`paths` is not allowed in tsconfig.json' });
  }
}

const rootDir = process.cwd();
await scanFile(join(rootDir, 'tsconfig.json')).catch(() => {});
await scanDirectory(join(rootDir, 'packages'));

if (violations.length === 0) {
  process.exit(0);
}

console.error(`Found ${violations.length} tsconfig violation(s):`);
for (const v of violations) {
  const rel = relative(rootDir, v.file);
  console.error(`  ${rel}  [${v.reason}]`);
}
process.exit(1);
