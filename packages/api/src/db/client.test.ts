import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, ensureParentDirectory } from './client.ts';

describe('db client', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `eal-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test('ensureParentDirectory is a no-op for :memory:', () => {
    ensureParentDirectory(':memory:');
    // No throw, no file system touched — the assertion is that the call returns.
    expect(true).toBe(true);
  });

  test('ensureParentDirectory is a no-op for other colon-prefixed paths', () => {
    ensureParentDirectory(':/some-bun-special:');
    expect(true).toBe(true);
  });

  test('ensureParentDirectory creates the parent of an on-disk path', () => {
    const dbPath = join(tmp, 'deep', 'nested', 'eal.sqlite');
    expect(existsSync(join(tmp, 'deep', 'nested'))).toBe(false);
    ensureParentDirectory(dbPath);
    expect(existsSync(join(tmp, 'deep', 'nested'))).toBe(true);
  });

  test('ensureParentDirectory is idempotent', () => {
    const dbPath = join(tmp, 'a', 'b', 'eal.sqlite');
    ensureParentDirectory(dbPath);
    ensureParentDirectory(dbPath);
    expect(existsSync(join(tmp, 'a', 'b'))).toBe(true);
  });

  test('createDb on an on-disk path materialises the file with WAL pragmas applied', () => {
    const dbPath = join(tmp, 'eal.sqlite');
    const db = createDb(dbPath);
    expect(existsSync(dbPath)).toBe(true);

    interface PragmaRow { journal_mode: string }
    const row = db.prepare<PragmaRow, []>('PRAGMA journal_mode').get();
    expect(row?.journal_mode).toBe('wal');
    db.close();
  });

  test('createDb on :memory: returns a working in-memory database', () => {
    const db = createDb(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO t (id) VALUES (1)');
    interface Row { id: number }
    const row = db.prepare<Row, []>('SELECT id FROM t').get();
    expect(row?.id).toBe(1);
    db.close();
  });
});
