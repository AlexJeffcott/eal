#!/usr/bin/env bun

/**
 * Forbids imports from `packages/api/src/test-helpers/` outside test files.
 * Production code must reach `createApp`, never `createTestApp`.
 *
 * Exempt: `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, `*.browser.tsx`,
 * and anything under a `tests/` or `__tests__/` directory.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Violation {
  file: string;
  line: number;
  content: string;
}

const violations: Violation[] = [];

const FORBIDDEN_IMPORT_RE = /from\s+['"](?:[^'"]*\/)?test-helpers\//;

function isTestFile(filePath: string): boolean {
  return (
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.tsx') ||
    filePath.endsWith('.browser.tsx') ||
    filePath.includes('/tests/') ||
    filePath.includes('/__tests__/') ||
    filePath.includes('/test-helpers/')
  );
}

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
  if (isTestFile(filePath)) return;
  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (FORBIDDEN_IMPORT_RE.test(line)) {
      violations.push({ file: filePath, line: i + 1, content: line.trim() });
    }
  }
}

const rootDir = process.cwd();
for (const pkg of ['api', 'cli', 'web']) {
  await scanDirectory(join(rootDir, 'packages', pkg));
}

if (violations.length === 0) {
  process.exit(0);
}

console.error(`Found ${violations.length} forbidden test-helpers import(s) in production code:`);
for (const v of violations) {
  const rel = relative(rootDir, v.file);
  console.error(`  ${rel}:${v.line}  ${v.content.slice(0, 120)}`);
}
process.exit(1);
