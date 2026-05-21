#!/usr/bin/env bun

/**
 * Bans React/Preact hooks (anti-pattern — polly $state replaces them), test isolation
 * markers, and TS suppression comments. Matches are word-boundary aware and skipped
 * when they fall inside string or template literals (so a check script can name its
 * own ban list).
 *
 * `@ts-expect-error` is permitted ONLY in test files and only when the line above
 * carries an explanatory comment.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

interface Violation {
  file: string;
  line: number;
  content: string;
  reason: string;
}

const BANNED_HOOKS = [
  'useState',
  'useEffect',
  'useSignal',
  'useRef',
  'useMemo',
  'useCallback',
  'useContext',
  'useReducer',
  'useLayoutEffect',
];

const BANNED_TEST_MARKERS = [
  { token: '.skip(', regex: /\.skip\(/ },
  { token: '.only(', regex: /\.only\(/ },
  { token: 'xit(', regex: /\bxit\(/ },
  { token: 'xdescribe(', regex: /\bxdescribe\(/ },
];

const BANNED_TS_SUPPRESSIONS = [
  { token: '@ts-ignore', regex: /@ts-ignore\b/ },
  { token: '@ts-nocheck', regex: /@ts-nocheck\b/ },
];

// Built from parts so the literal token doesn't appear in this source file
// (which would otherwise trip the check on itself).
const TS_EXPECT_ERROR = new RegExp(`${'@ts-'}${'expect-error'}\\b`);

const violations: Violation[] = [];

function isTestFile(filePath: string): boolean {
  return (
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx') ||
    filePath.endsWith('.browser.tsx') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.tsx')
  );
}

function computeTemplateMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let inTemplate = false;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    if (inTemplate || inBlockComment) mask[i] = true;
    const line = lines[i] ?? '';
    let j = 0;
    while (j < line.length) {
      const ch = line[j];
      const next = line[j + 1];
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          j += 2;
          continue;
        }
      } else if (inTemplate) {
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '`') inTemplate = false;
      } else {
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          j += 2;
          continue;
        }
        if (ch === '/' && next === '/') break;
        if (ch === '`') inTemplate = true;
        else if (ch === "'" || ch === '"') {
          let k = j + 1;
          while (k < line.length) {
            if (line[k] === '\\') {
              k += 2;
              continue;
            }
            if (line[k] === ch) break;
            k += 1;
          }
          j = k;
        }
      }
      j += 1;
    }
  }
  return mask;
}

function isInsideString(line: string, idx: number): boolean {
  const before = line.substring(0, idx);
  const singles = (before.match(/'/g) ?? []).length;
  const doubles = (before.match(/"/g) ?? []).length;
  const backticks = (before.match(/`/g) ?? []).length;
  return singles % 2 === 1 || doubles % 2 === 1 || backticks % 2 === 1;
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

function findMatch(line: string, re: RegExp): number | null {
  const m = re.exec(line);
  return m ? m.index : null;
}

async function scanFile(filePath: string): Promise<void> {
  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.split('\n');
  const templateMask = computeTemplateMask(lines);
  const inTest = isTestFile(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (templateMask[i]) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    for (const hook of BANNED_HOOKS) {
      const re = new RegExp(`\\b${hook}\\s*\\(`);
      const idx = findMatch(line, re);
      if (idx !== null && !isInsideString(line, idx)) {
        violations.push({
          file: filePath,
          line: i + 1,
          content: line.trim(),
          reason: `forbidden hook: ${hook}`,
        });
      }
    }

    for (const marker of BANNED_TEST_MARKERS) {
      const idx = findMatch(line, marker.regex);
      if (idx !== null && !isInsideString(line, idx)) {
        violations.push({
          file: filePath,
          line: i + 1,
          content: line.trim(),
          reason: `forbidden test marker: ${marker.token}`,
        });
      }
    }

    for (const suppression of BANNED_TS_SUPPRESSIONS) {
      const idx = findMatch(line, suppression.regex);
      if (idx !== null && !isInsideString(line, idx)) {
        violations.push({
          file: filePath,
          line: i + 1,
          content: line.trim(),
          reason: `forbidden TS suppression: ${suppression.token}`,
        });
      }
    }

    const expectErrorIdx = findMatch(line, TS_EXPECT_ERROR);
    if (expectErrorIdx !== null && !isInsideString(line, expectErrorIdx)) {
      const prev = lines[i - 1] ?? '';
      const hasExplanation = /\/\/|\/\*/.test(prev) && prev.trim().length > 3;
      if (!inTest || !hasExplanation) {
        violations.push({
          file: filePath,
          line: i + 1,
          content: line.trim(),
          reason: inTest
            ? '@ts-expect-error requires an explanation comment on the line above'
            : '@ts-expect-error allowed only in test files',
        });
      }
    }
  }
}

const rootDir = process.cwd();
await scanDirectory(join(rootDir, 'packages'));
await scanDirectory(join(rootDir, 'scripts'));

if (violations.length === 0) {
  process.exit(0);
}

console.error(`Found ${violations.length} banned token violation(s):`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.reason}]  ${v.content.slice(0, 120)}`);
}
process.exit(1);
