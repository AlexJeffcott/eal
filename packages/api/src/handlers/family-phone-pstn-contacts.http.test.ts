import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import type { Principal } from '../auth/principals.ts';

interface ContactRecord {
  id: number;
  e164: string;
  label: string;
  allowIn: boolean;
  allowOut: boolean;
  createdAt: string;
  updatedAt: string;
}

function isContactRecord(value: unknown): value is ContactRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !(
      'id' in value &&
      'e164' in value &&
      'label' in value &&
      'allowIn' in value &&
      'allowOut' in value
    )
  ) {
    return false;
  }
  return (
    typeof value.id === 'number' &&
    typeof value.e164 === 'string' &&
    typeof value.label === 'string' &&
    typeof value.allowIn === 'boolean' &&
    typeof value.allowOut === 'boolean'
  );
}

function expectContact(value: unknown): ContactRecord {
  if (typeof value !== 'object' || value === null || !('contact' in value)) {
    throw new Error(`expected { contact }, got ${JSON.stringify(value)}`);
  }
  const c = value.contact;
  if (!isContactRecord(c)) throw new Error(`bad contact shape ${JSON.stringify(c)}`);
  return c;
}

function expectContacts(value: unknown): ContactRecord[] {
  if (typeof value !== 'object' || value === null || !('contacts' in value)) {
    throw new Error(`expected { contacts }, got ${JSON.stringify(value)}`);
  }
  const list = value.contacts;
  if (!Array.isArray(list) || !list.every(isContactRecord)) {
    throw new Error(`bad contacts list ${JSON.stringify(list)}`);
  }
  return list;
}

function expectError(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    throw new Error(`expected { error }, got ${JSON.stringify(value)}`);
  }
  const e = value.error;
  if (typeof e !== 'string') throw new Error(`bad error shape ${JSON.stringify(e)}`);
  return e;
}

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

async function fetchJson(
  app: TestApp,
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

describe('PSTN contacts http wire contract', () => {
  let db: DatabaseClient;
  let alex: Principal;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const u = createUsersRepo(db).insert({ displayName: 'alex' });
    alex = { userId: u.id, displayName: u.display_name };
  });

  test('GET /pstn-contacts rejects unauthenticated requests with 401', async () => {
    const app = await createTestApp(db, { principalOverride: null });
    const res = await fetchJson(app, 'GET', '/api/family-phone/pstn-contacts');
    expect(res.status).toBe(401);
  });

  test('GET /pstn-contacts returns an empty list when none exist', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'GET', '/api/family-phone/pstn-contacts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contacts: [] });
  });

  test('POST creates a contact and returns it in camelCase', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'POST', '/api/family-phone/pstn-contacts', {
      e164: '+441234567890',
      label: 'Nonna',
      allowIn: true,
      allowOut: true,
    });
    expect(res.status).toBe(200);
    const c = expectContact(res.body);
    expect(c.e164).toBe('+441234567890');
    expect(c.label).toBe('Nonna');
    expect(c.allowIn).toBe(true);
    expect(c.allowOut).toBe(true);
    expect(c.createdAt).toBeTruthy();
  });

  test('POST trims whitespace from label and rejects an empty one', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const ok = await fetchJson(app, 'POST', '/api/family-phone/pstn-contacts', {
      e164: '+441234567890',
      label: '  Nonna  ',
      allowIn: true,
      allowOut: true,
    });
    expect(ok.status).toBe(200);
    expect(expectContact(ok.body).label).toBe('Nonna');

    const bad = await fetchJson(app, 'POST', '/api/family-phone/pstn-contacts', {
      e164: '+441234567891',
      label: '   ',
      allowIn: true,
      allowOut: true,
    });
    expect(bad.status).toBe(400);
    expect(expectError(bad.body)).toMatch(/label/);
  });

  test('POST rejects a number that is not E.164', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    for (const bogus of ['0123456789', '+0441234567890', '+', '+44 123 456', '+1234']) {
      const res = await fetchJson(app, 'POST', '/api/family-phone/pstn-contacts', {
        e164: bogus,
        label: 'x',
        allowIn: true,
        allowOut: true,
      });
      expect(res.status).toBe(400);
      expect(expectError(res.body)).toMatch(/E\.164/);
    }
  });

  test('POST with a duplicate e164 returns 409', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    await fetchJson(app, 'POST', '/api/family-phone/pstn-contacts', {
      e164: '+441234567890',
      label: 'Nonna',
      allowIn: true,
      allowOut: true,
    });
    const dup = await fetchJson(app, 'POST', '/api/family-phone/pstn-contacts', {
      e164: '+441234567890',
      label: 'Different label',
      allowIn: true,
      allowOut: true,
    });
    expect(dup.status).toBe(409);
    expect(expectError(dup.body)).toMatch(/already exists/);
  });

  test('PATCH updates label + allow flags, keeps e164 and createdAt', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = expectContact(
      (
        await fetchJson(app, 'POST', '/api/family-phone/pstn-contacts', {
          e164: '+391234567890',
          label: 'Nonno',
          allowIn: true,
          allowOut: true,
        })
      ).body,
    );
    const res = await fetchJson(app, 'PATCH', `/api/family-phone/pstn-contacts/${created.id}`, {
      label: 'Nonno (Bologna)',
      allowIn: false,
      allowOut: true,
    });
    expect(res.status).toBe(200);
    const patched = expectContact(res.body);
    expect(patched.id).toBe(created.id);
    expect(patched.e164).toBe('+391234567890');
    expect(patched.label).toBe('Nonno (Bologna)');
    expect(patched.allowIn).toBe(false);
    expect(patched.allowOut).toBe(true);
    expect(patched.createdAt).toBe(created.createdAt);
  });

  test('PATCH on a missing id returns 404', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'PATCH', '/api/family-phone/pstn-contacts/9999', {
      label: 'x',
      allowIn: true,
      allowOut: true,
    });
    expect(res.status).toBe(404);
  });

  test('GET returns every contact sorted by label then e164', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    for (const [e164, label] of [
      ['+441234567892', 'Zola'],
      ['+441234567890', 'Anna'],
      ['+441234567891', 'Anna'],
    ] as const) {
      await fetchJson(app, 'POST', '/api/family-phone/pstn-contacts', {
        e164,
        label,
        allowIn: true,
        allowOut: true,
      });
    }
    const res = await fetchJson(app, 'GET', '/api/family-phone/pstn-contacts');
    expect(res.status).toBe(200);
    const list = expectContacts(res.body);
    expect(list.map((c) => [c.label, c.e164])).toEqual([
      ['Anna', '+441234567890'],
      ['Anna', '+441234567891'],
      ['Zola', '+441234567892'],
    ]);
  });

  test('DELETE removes the contact and returns { deleted: true }', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const created = expectContact(
      (
        await fetchJson(app, 'POST', '/api/family-phone/pstn-contacts', {
          e164: '+441234567890',
          label: 'Nonna',
          allowIn: true,
          allowOut: true,
        })
      ).body,
    );
    const res = await fetchJson(app, 'DELETE', `/api/family-phone/pstn-contacts/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    const missing = await fetchJson(
      app,
      'DELETE',
      `/api/family-phone/pstn-contacts/${created.id}`,
    );
    expect(missing.status).toBe(404);
  });

  test('DELETE with a non-numeric id returns 400', async () => {
    const app = await createTestApp(db, { principalOverride: alex });
    const res = await fetchJson(app, 'DELETE', '/api/family-phone/pstn-contacts/abc');
    expect(res.status).toBe(400);
  });
});
