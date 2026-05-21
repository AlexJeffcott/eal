#!/usr/bin/env bun

/**
 * Scans all TypeScript files for forbidden `as` type assertions.
 * Allowed: `as const`, import/export aliases, SQL `) as alias`, JSX text.
 * `as unknown as` is NOT an escape hatch — proper type guards are required.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

interface Violation {
  file: string;
  line: number;
  content: string;
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
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
        continue;
      }
      await scanDirectory(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      await scanFile(fullPath);
    }
  }
}

function computeTemplateMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let inTemplate = false;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    if (inTemplate || inBlockComment) {
      mask[i] = true;
    }
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
        if (ch === '`') {
          inTemplate = false;
        }
      } else {
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          j += 2;
          continue;
        }
        if (ch === '/' && next === '/') {
          break;
        }
        if (ch === '`') {
          inTemplate = true;
        } else if (ch === "'" || ch === '"') {
          let k = j + 1;
          while (k < line.length) {
            if (line[k] === '\\') {
              k += 2;
              continue;
            }
            if (line[k] === ch) {
              break;
            }
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

async function scanFile(filePath: string): Promise<void> {
  const file = Bun.file(filePath);
  const content = await file.text();
  const lines = content.split('\n');
  const templateMask = computeTemplateMask(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (templateMask[i]) continue;

    if (
      line.trim().startsWith('//') ||
      line.trim().startsWith('*') ||
      line.trim().startsWith('/*')
    ) {
      continue;
    }

    if (!line.includes(' as ')) continue;

    const commentIndex = line.indexOf('//');
    const asIndex = line.indexOf(' as ');
    if (commentIndex !== -1 && commentIndex < asIndex) continue;

    if (line.includes(' as const')) continue;

    if (line.match(/\bas\s*[=:,]/)) continue;
    if (line.match(/\)\s+as\s+\w+/)) continue;

    if (
      line.match(/\b(import|export)\s+.*\s+as\s+\w+/) ||
      line.match(/\b(import|export)\s+\*\s+as\s+\w+/) ||
      line.match(/\b(import|export)\s+type\s+.*\s+as\s+\w+/) ||
      line.match(/^\s*\w+\s+as\s+\w+,\s*$/)
    ) {
      continue;
    }

    const beforeAs = line.substring(0, line.indexOf(' as '));
    const singleQuotes = (beforeAs.match(/'/g) ?? []).length;
    const doubleQuotes = (beforeAs.match(/"/g) ?? []).length;
    const backticks = (beforeAs.match(/`/g) ?? []).length;
    if (singleQuotes % 2 === 1 || doubleQuotes % 2 === 1 || backticks % 2 === 1) continue;

    const textBeforeAs = line.substring(0, asIndex);
    const lastOpenBracket = textBeforeAs.lastIndexOf('>');
    const nextCloseBracket = line.indexOf('<', asIndex);
    if (lastOpenBracket !== -1 && nextCloseBracket !== -1) {
      const betweenBrackets = line.substring(lastOpenBracket + 1, nextCloseBracket);
      if (
        !betweenBrackets.includes('{') &&
        !betweenBrackets.includes('}') &&
        !betweenBrackets.includes('"') &&
        !betweenBrackets.includes("'") &&
        !betweenBrackets.includes('`')
      ) {
        continue;
      }
    }

    const trimmed = line.trim();
    if (
      trimmed === line.substring(line.indexOf(trimmed)) &&
      !textBeforeAs.includes('=') &&
      !textBeforeAs.includes('{') &&
      !textBeforeAs.includes('}') &&
      !textBeforeAs.includes(':') &&
      !textBeforeAs.includes(';') &&
      !textBeforeAs.includes('(') &&
      !line.startsWith('//') &&
      !line.startsWith('/*') &&
      !line.includes('const ') &&
      !line.includes('let ') &&
      !line.includes('var ')
    ) {
      continue;
    }

    violations.push({ file: filePath, line: i + 1, content: line.trim() });
  }
}

const rootDir = process.cwd();
await scanDirectory(join(rootDir, 'packages'));
await scanDirectory(join(rootDir, 'scripts'));

if (violations.length === 0) {
  process.exit(0);
}

console.error(`Found ${violations.length} forbidden 'as' type assertion(s):`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.content.slice(0, 120)}`);
}
process.exit(1);
