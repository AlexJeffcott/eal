#!/usr/bin/env bun

/**
 * Enforces package import boundaries.
 *
 * Rule: `@eal/client-mock` must not be imported from production code in `@eal/api`,
 * `@eal/cli`, or `@eal/web`. It is only legal in test files (`*.test.ts`, `*.browser.tsx`,
 * `*.spec.ts`) and in the `@eal/browser-test-harness` and `@eal/e2e-tests` packages.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Violation {
  file: string;
  line: number;
  content: string;
  reason: string;
}

const violations: Violation[] = [];

const PRODUCTION_PACKAGES = ['api', 'cli', 'web'];
const FORBIDDEN_IMPORT_RE = /from\s+['"]@eal\/client-mock(['"\/])/;

function isTestFile(filePath: string): boolean {
  return (
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx') ||
    filePath.endsWith('.browser.tsx') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.tsx') ||
    filePath.includes('/tests/') ||
    filePath.includes('/__tests__/')
  );
}

async function scanDirectory(dir: string, pkg: string): Promise<void> {
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
      await scanDirectory(fullPath, pkg);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      await scanFile(fullPath, pkg);
    }
  }
}

async function scanFile(filePath: string, pkg: string): Promise<void> {
  if (isTestFile(filePath)) return;
  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (FORBIDDEN_IMPORT_RE.test(line)) {
      violations.push({
        file: filePath,
        line: i + 1,
        content: line.trim(),
        reason: `package @eal/${pkg} must not import @eal/client-mock from production code`,
      });
    }
  }
}

const rootDir = process.cwd();
for (const pkg of PRODUCTION_PACKAGES) {
  await scanDirectory(join(rootDir, 'packages', pkg), pkg);
}

if (violations.length === 0) {
  process.exit(0);
}

console.error(`Found ${violations.length} package boundary violation(s):`);
for (const v of violations) {
  const rel = relative(rootDir, v.file);
  console.error(`  ${rel}:${v.line}  [${v.reason}]  ${v.content.slice(0, 120)}`);
}
process.exit(1);
