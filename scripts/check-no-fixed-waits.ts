#!/usr/bin/env bun

/**
 * Bans fixed-duration waits.
 *
 * A fixed sleep — `await new Promise((r) => setTimeout(r, n))`, `Bun.sleep(n)`,
 * `page.waitForTimeout(n)` — guesses how long an operation takes. Too short and
 * it flakes on a loaded machine; too long and every run wastes that time. The
 * guess is never right, only un-noticed.
 *
 * Wait on a real signal instead: `pollUntil` (re-check a condition until it
 * holds), `flushMicrotasks` (let a promise chain settle), or a web-first
 * assertion / `waitFor` in the e2e helpers. Where the wait genuinely IS the
 * behaviour — reconnect backoff, the cadence between polls — use `delay`.
 *
 * All three live in `packages/shared/src/timers.ts`, the one file allowed to
 * call `setTimeout` for a delay. This script itself is allowlisted because it
 * must name the patterns it forbids.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface Violation {
  file: string;
  line: number;
  content: string;
  reason: string;
}

// Paths (relative to the repo root) exempt from the scan.
const ALLOWLIST = new Set(['packages/shared/src/timers.ts', 'scripts/check-no-fixed-waits.ts']);

const PATTERNS: { regex: RegExp; reason: string }[] = [
  {
    regex: /new Promise\b.*\bsetTimeout\b/,
    reason: 'fixed sleep: new Promise wrapping setTimeout — use pollUntil/flushMicrotasks, or delay',
  },
  {
    regex: /\bsetTimeout\s*\(\s*(?:resolve|res|done|_resolve|r)\s*[,)]/,
    reason: 'fixed sleep: setTimeout resolving a promise — use pollUntil/flushMicrotasks, or delay',
  },
  {
    regex: /\bBun\.sleep\s*\(/,
    reason: 'fixed sleep: Bun.sleep — use pollUntil, or delay',
  },
  {
    regex: /\bwaitForTimeout\s*\(/,
    reason: 'fixed sleep: waitForTimeout — wait on a real condition or assertion instead',
  },
];

const ROOT = process.cwd();
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
  const rel = relative(ROOT, filePath);
  if (ALLOWLIST.has(rel)) return;

  const content = await Bun.file(filePath).text();
  const lines = content.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();

    // Skip comments — a doc comment may legitimately name a banned pattern.
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    for (const { regex, reason } of PATTERNS) {
      if (regex.test(line)) {
        violations.push({ file: rel, line: i + 1, content: trimmed, reason });
        break;
      }
    }
  }
}

await scanDirectory(join(ROOT, 'packages'));
await scanDirectory(join(ROOT, 'scripts'));

if (violations.length === 0) {
  process.exit(0);
}

console.error(`Found ${violations.length} fixed-wait violation(s):`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.reason}]`);
  console.error(`    ${v.content.slice(0, 120)}`);
}
process.exit(1);
