import { Elysia } from 'elysia';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from './db/client.ts';
import { applySchema } from './db/schema.ts';
import { createTestApp } from './test-helpers/create-test-app.ts';
import { toBinary } from './server-factory.ts';
import type { ApiApp, WsAppContext, WsMessageHandler } from './apps/types.ts';

/**
 * Wire-contract test for the per-app WebSocket dispatch seam:
 *   - prefix collisions are caught at boot, not at first message;
 *   - binary tag collisions are caught at boot;
 *   - binary tags outside the reserved-app range (0x10–0xFF) are rejected;
 *   - `toBinary` recognises the shapes Bun and the WHATWG WS API actually deliver.
 *
 * The full dispatch pipeline (text → prefix lookup → onMessage; binary →
 * leading byte → onBinary) is exercised end-to-end by the family-phone WS
 * tests added in Phase E, since those are the first concrete consumer.
 */

const noopRoutes = () => new Elysia();

function emptyHandler(): WsMessageHandler {
  return { onMessage() {}, onBinary() {}, onClose() {} };
}

function app(id: string, prefix: string, binaryTag?: number): ApiApp {
  return {
    id,
    schema: '',
    routes: noopRoutes,
    ws: {
      prefix,
      ...(binaryTag !== undefined ? { binaryTag } : {}),
      handler: (_ctx: WsAppContext) => emptyHandler(),
    },
  };
}

describe('toBinary', () => {
  test('strings are text, not binary', () => {
    expect(toBinary('hello')).toBeNull();
    expect(toBinary('{"type":"x"}')).toBeNull();
  });

  test('Uint8Array passes through unchanged', () => {
    const u = new Uint8Array([0x10, 0x01, 0x02]);
    expect(toBinary(u)).toBe(u);
  });

  test('ArrayBuffer is wrapped in a Uint8Array view', () => {
    const buf = new ArrayBuffer(3);
    const view = new Uint8Array(buf);
    view[0] = 0x10;
    view[1] = 0xff;
    view[2] = 0x00;
    const out = toBinary(buf);
    expect(out).not.toBeNull();
    expect(out?.length).toBe(3);
    expect(out?.[0]).toBe(0x10);
  });

  test('non-binary, non-string inputs return null', () => {
    expect(toBinary(null)).toBeNull();
    expect(toBinary(undefined)).toBeNull();
    expect(toBinary({ type: 'x' })).toBeNull();
    expect(toBinary(42)).toBeNull();
  });
});

describe('server-factory WS seam — boot-time validation', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  test('duplicate prefix across apps is caught at boot', async () => {
    const a = app('alpha', 'call');
    const b = app('beta', 'call');
    await expect(createTestApp(db, { apps: [a, b] })).rejects.toThrow(
      /WS prefix 'call' claimed by both 'alpha' and 'beta'/,
    );
  });

  test('duplicate binary tag across apps is caught at boot', async () => {
    const a = app('alpha', 'a', 0x10);
    const b = app('beta', 'b', 0x10);
    await expect(createTestApp(db, { apps: [a, b] })).rejects.toThrow(
      /WS binary tag 0x10 claimed by both 'alpha' and 'beta'/,
    );
  });

  test('binary tag below the app range is rejected', async () => {
    const a = app('alpha', 'a', 0x0f);
    await expect(createTestApp(db, { apps: [a] })).rejects.toThrow(
      /binaryTag 15 outside the app range/,
    );
  });

  test('binary tag above 0xFF is rejected', async () => {
    const a = app('alpha', 'a', 0x100);
    await expect(createTestApp(db, { apps: [a] })).rejects.toThrow(
      /binaryTag 256 outside the app range/,
    );
  });

  test('two apps with distinct prefixes and tags boot cleanly', async () => {
    const a = app('alpha', 'one', 0x10);
    const b = app('beta', 'two', 0x11);
    const built = await createTestApp(db, { apps: [a, b] });
    expect(built).toBeDefined();
  });
});
