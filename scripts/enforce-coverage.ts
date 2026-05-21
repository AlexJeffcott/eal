#!/usr/bin/env bun

/**
 * Reads coverage output from stdin (the `bun test --coverage` table) and applies
 * the per-file rules in `scripts/coverage.config.ts`. Exits 0 if every covered
 * non-exempt file meets the default threshold AND every exempt entry points at
 * files that exist on disk; exits 1 otherwise with a report.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './coverage.config.ts';

const ROOT = resolve(import.meta.dir, '..');

interface CoverageRow {
  file: string;
  funcs: number;
  lines: number;
}

function parseCoverageTable(stdout: string): CoverageRow[] {
  const rows: CoverageRow[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(' ')) continue;
    if (!line.includes('|')) continue;
    if (line.includes('All files')) continue;
    if (line.includes('% Funcs')) continue;
    if (line.trim().startsWith('---')) continue;

    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    const file = cells[0];
    const funcs = Number(cells[1]);
    const lines = Number(cells[2]);
    if (!file || file.length === 0 || Number.isNaN(funcs) || Number.isNaN(lines)) continue;
    if (!file.includes('/')) continue;
    rows.push({ file, funcs, lines });
  }
  return rows;
}

interface Violation {
  file: string;
  metric: 'lines' | 'funcs';
  observed: number;
  required: number;
}

function evaluate(rows: CoverageRow[]): {
  violations: Violation[];
  staleExempts: string[];
  missingExemptFiles: string[];
  missingClaimedBy: { file: string; claimedBy: string }[];
} {
  const violations: Violation[] = [];
  const t = config.defaultThreshold;
  const staleExempts: string[] = [];

  for (const row of rows) {
    const exemption = config.exempt[row.file];
    if (exemption) {
      if (row.lines >= t.lines && row.funcs >= t.funcs) {
        staleExempts.push(row.file);
      }
      continue;
    }
    if (row.lines < t.lines) {
      violations.push({ file: row.file, metric: 'lines', observed: row.lines, required: t.lines });
    }
    if (row.funcs < t.funcs) {
      violations.push({ file: row.file, metric: 'funcs', observed: row.funcs, required: t.funcs });
    }
  }

  // Validate that every exempt entry points at a real source file AND that its
  // `claimedBy` test path exists (or is the explicit "n/a — not yet wired" form).
  const missingExemptFiles: string[] = [];
  const missingClaimedBy: { file: string; claimedBy: string }[] = [];
  for (const [file, entry] of Object.entries(config.exempt)) {
    if (!existsSync(resolve(ROOT, file))) {
      missingExemptFiles.push(file);
    }
    const claimedBy = entry.claimedBy.trim();
    const isWaiver = claimedBy.startsWith('n/a');
    if (!isWaiver && !existsSync(resolve(ROOT, claimedBy))) {
      missingClaimedBy.push({ file, claimedBy });
    }
  }

  return { violations, staleExempts, missingExemptFiles, missingClaimedBy };
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
  }
  return chunks.join('');
}

const stdout = await readStdin();
const rows = parseCoverageTable(stdout);
if (rows.length === 0) {
  console.error('enforce-coverage: no coverage rows parsed from stdin. Was --coverage piped in?');
  process.exit(1);
}

const { violations, staleExempts, missingExemptFiles, missingClaimedBy } = evaluate(rows);

if (missingExemptFiles.length > 0) {
  console.error('enforce-coverage: exempt entries point at files that do not exist:');
  for (const f of missingExemptFiles) console.error(`  ${f}`);
  console.error('  Either the file was renamed/deleted, or the path is a typo.');
}

if (missingClaimedBy.length > 0) {
  console.error('enforce-coverage: exempt entries point at claimedBy test files that do not exist:');
  for (const { file, claimedBy } of missingClaimedBy) {
    console.error(`  ${file}  →  claimedBy: ${claimedBy}`);
  }
  console.error('  Either the test was renamed/deleted, or the claim was wrong. Use "n/a — …" for waivers.');
}

if (staleExempts.length > 0) {
  console.error('enforce-coverage: exempt entries that now meet the threshold — remove from coverage.config.ts:');
  for (const f of staleExempts) console.error(`  ${f}  (reason was: ${config.exempt[f]?.reason ?? '?'})`);
}

if (violations.length > 0) {
  console.error(`enforce-coverage: ${violations.length} file(s) below the default threshold:`);
  for (const v of violations) {
    console.error(`  ${v.file}  ${v.metric}=${v.observed.toFixed(2)}%  (required ≥ ${v.required}%)`);
  }
}

if (
  violations.length > 0 ||
  staleExempts.length > 0 ||
  missingExemptFiles.length > 0 ||
  missingClaimedBy.length > 0
) {
  process.exit(1);
}

console.log(`enforce-coverage: ok (${rows.length} files, ${Object.keys(config.exempt).length} exempt)`);
process.exit(0);
