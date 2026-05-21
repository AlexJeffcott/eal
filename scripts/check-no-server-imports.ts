#!/usr/bin/env bun

/**
 * Forbids server-only Node/Bun imports in client packages. The browser cannot import
 * `bun:sqlite`, `node:fs`, `node:child_process`, etc. If a violation lands in `@eal/client`,
 * `@eal/client-mock`, or `@eal/web`, the bundle breaks at runtime.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Violation {
  file: string;
  line: number;
  content: string;
  forbidden: string;
}

const FORBIDDEN_IMPORTS = [
  'bun:sqlite',
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:net',
  'node:os',
  'node:dns',
  'node:cluster',
];

// `web` is the browser surface; `client` and `client-mock` are isomorphic
// libraries used by both CLI (Bun) and SPA (browser), so they must stay
// browser-safe. `cli` is Bun-only so it may use node:* freely.
const CLIENT_PACKAGES = ['client', 'client-mock', 'web'];

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
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      await scanFile(fullPath);
    }
  }
}

async function scanFile(filePath: string): Promise<void> {
  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const forbidden of FORBIDDEN_IMPORTS) {
      const re = new RegExp(`from\\s+['"]${forbidden}['"]`);
      if (re.test(line)) {
        violations.push({
          file: filePath,
          line: i + 1,
          content: line.trim(),
          forbidden,
        });
      }
    }
  }
}

const rootDir = process.cwd();
for (const pkg of CLIENT_PACKAGES) {
  await scanDirectory(join(rootDir, 'packages', pkg));
}

if (violations.length === 0) {
  process.exit(0);
}

console.error(`Found ${violations.length} forbidden server-import(s) in client packages:`);
for (const v of violations) {
  const rel = relative(rootDir, v.file);
  console.error(`  ${rel}:${v.line}  [${v.forbidden}]  ${v.content.slice(0, 120)}`);
}
process.exit(1);
