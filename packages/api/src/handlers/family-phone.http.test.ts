import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

interface DeviceRow {
  id: number;
  user_id: number;
  label: string;
  kind: 'handset' | 'pwa' | 'agent';
  created_at: string;
  owner_display_name: string;
  online: boolean;
}

interface DevicesResponse {
  devices: DeviceRow[];
}

function isDeviceRow(value: unknown): value is DeviceRow {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !(
      'id' in value && 'user_id' in value && 'label' in value && 'kind' in value &&
      'created_at' in value && 'owner_display_name' in value && 'online' in value
    )
  ) {
    return false;
  }
  return (
    typeof value.id === 'number' &&
    typeof value.user_id === 'number' &&
    typeof value.label === 'string' &&
    (value.kind === 'handset' || value.kind === 'pwa' || value.kind === 'agent') &&
    typeof value.created_at === 'string' &&
    typeof value.owner_display_name === 'string' &&
    typeof value.online === 'boolean'
  );
}

function isDevicesResponse(body: unknown): body is DevicesResponse {
  if (typeof body !== 'object' || body === null || !('devices' in body)) return false;
  if (!Array.isArray(body.devices)) return false;
  return body.devices.every(isDeviceRow);
}

async function fetchJson(
  app: Awaited<ReturnType<typeof createTestApp>>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await app.handle(new Request(`https://localhost:3000${path}`, init));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed };
}

function deviceIdsInDb(db: DatabaseClient): number[] {
  interface Row { id: number }
  return db
    .prepare<Row, []>('SELECT id FROM family_phone_devices ORDER BY id')
    .all()
    .map((r) => r.id);
}

describe('family-phone http wire contract', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
  });

  test("GET /api/family-phone/devices: returns the household's devices with owner names", async () => {
    const elisa = createUsersRepo(db).insert({ displayName: 'elisa' });
    db.prepare(
      "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, ?, ?)",
    ).run(alex.userId, "Alex's handset", 'handset');
    db.prepare(
      "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, ?, ?)",
    ).run(alex.userId, "Alex's laptop PWA", 'pwa');
    db.prepare(
      "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, ?, ?)",
    ).run(elisa.id, "Elisa's handset", 'handset');

    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'GET', '/api/family-phone/devices');

    expect(res.status).toBe(200);
    expect(isDevicesResponse(res.body)).toBe(true);
    if (!isDevicesResponse(res.body)) throw new Error('unreachable');
    expect(res.body.devices.length).toBe(3);
    expect(res.body.devices.map((d) => d.label).sort()).toEqual([
      "Alex's handset",
      "Alex's laptop PWA",
      "Elisa's handset",
    ]);
    const elisaRow = res.body.devices.find((d) => d.label === "Elisa's handset");
    expect(elisaRow?.owner_display_name).toBe('elisa');
    expect(elisaRow?.online).toBe(false);
  });

  test('GET /api/family-phone/devices: 401 when unauthenticated', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await fetchJson(app, 'GET', '/api/family-phone/devices');
    expect(res.status).toBe(401);
  });

  test('DELETE /api/family-phone/devices/:id: owner can delete their own device', async () => {
    interface InsertedRow { id: number }
    const inserted = db
      .prepare<InsertedRow, [number]>(
        "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, 'mine', 'pwa') RETURNING id",
      )
      .get(alex.userId);
    if (!inserted) throw new Error('insert returned no row');
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'DELETE', `/api/family-phone/devices/${inserted.id}`);
    expect(res.status).toBe(200);
    expect(deviceIdsInDb(db)).not.toContain(inserted.id);
  });

  test('DELETE /api/family-phone/devices/:id: 403 when caller does not own the device', async () => {
    const elisa = createUsersRepo(db).insert({ displayName: 'elisa' });
    interface InsertedRow { id: number }
    const inserted = db
      .prepare<InsertedRow, [number]>(
        "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, 'elisas', 'handset') RETURNING id",
      )
      .get(elisa.id);
    if (!inserted) throw new Error('insert returned no row');
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'DELETE', `/api/family-phone/devices/${inserted.id}`);
    expect(res.status).toBe(403);
    expect(deviceIdsInDb(db)).toContain(inserted.id);
  });

  test('DELETE /api/family-phone/devices/:id: 404 for an unknown device', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'DELETE', '/api/family-phone/devices/9999');
    expect(res.status).toBe(404);
  });

  test('DELETE /api/family-phone/devices/:id: 400 for a malformed id', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'DELETE', '/api/family-phone/devices/abc');
    expect(res.status).toBe(400);
  });

  test('DELETE /api/family-phone/devices/:id: 401 when unauthenticated', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await fetchJson(app, 'DELETE', '/api/family-phone/devices/1');
    expect(res.status).toBe(401);
  });

  test('PATCH /api/family-phone/devices/:id: owner can rename their own device', async () => {
    interface InsertedRow { id: number }
    const inserted = db
      .prepare<InsertedRow, [number]>(
        "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, 'old', 'pwa') RETURNING id",
      )
      .get(alex.userId);
    if (!inserted) throw new Error('insert returned no row');
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'PATCH', `/api/family-phone/devices/${inserted.id}`, {
      label: '  Alex iPhone  ',
    });
    expect(res.status).toBe(200);
    interface Row { label: string }
    const row = db
      .prepare<Row, [number]>('SELECT label FROM family_phone_devices WHERE id = ?')
      .get(inserted.id);
    expect(row?.label).toBe('Alex iPhone');
  });

  test('PATCH /api/family-phone/devices/:id: 403 when caller does not own the device', async () => {
    const elisa = createUsersRepo(db).insert({ displayName: 'elisa' });
    interface InsertedRow { id: number }
    const inserted = db
      .prepare<InsertedRow, [number]>(
        "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, 'elisas', 'handset') RETURNING id",
      )
      .get(elisa.id);
    if (!inserted) throw new Error('insert returned no row');
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'PATCH', `/api/family-phone/devices/${inserted.id}`, {
      label: 'hijack',
    });
    expect(res.status).toBe(403);
  });

  test('PATCH /api/family-phone/devices/:id: 404 for an unknown device', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'PATCH', '/api/family-phone/devices/9999', {
      label: 'x',
    });
    expect(res.status).toBe(404);
  });

  test('PATCH /api/family-phone/devices/:id: 400 for an empty label', async () => {
    interface InsertedRow { id: number }
    const inserted = db
      .prepare<InsertedRow, [number]>(
        "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, 'old', 'pwa') RETURNING id",
      )
      .get(alex.userId);
    if (!inserted) throw new Error('insert returned no row');
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'PATCH', `/api/family-phone/devices/${inserted.id}`, {
      label: '   ',
    });
    expect(res.status).toBe(400);
  });

  test('PATCH /api/family-phone/devices/:id: 400 for an over-long label', async () => {
    interface InsertedRow { id: number }
    const inserted = db
      .prepare<InsertedRow, [number]>(
        "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, 'old', 'pwa') RETURNING id",
      )
      .get(alex.userId);
    if (!inserted) throw new Error('insert returned no row');
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'PATCH', `/api/family-phone/devices/${inserted.id}`, {
      label: 'x'.repeat(61),
    });
    expect(res.status).toBe(400);
  });

  test('PATCH /api/family-phone/devices/:id: 401 when unauthenticated', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await fetchJson(app, 'PATCH', '/api/family-phone/devices/1', { label: 'x' });
    expect(res.status).toBe(401);
  });

  test('family_phone_devices.kind rejects values outside the enum', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO family_phone_devices (user_id, label, kind) VALUES (?, ?, ?)",
        )
        .run(alex.userId, 'bad', 'tablet'),
    ).toThrow();
  });
});
