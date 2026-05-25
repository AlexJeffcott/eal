import { Elysia } from 'elysia';
import { familyPhoneHttpRoutes } from '../handlers/family-phone.http.ts';
import { familyPhonePairHttpRoutes } from '../handlers/family-phone-pair.http.ts';
import type { ApiApp } from './types.ts';

/**
 * Family-phone's own tables. References the global `users` table (each device
 * is owned by a human, identified the same way as elsewhere in eal). Per-call
 * audio routing state, challenge nonces, and the call matrix are added in
 * later phases — see docs/family-phone.md.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS family_phone_devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('handset','pwa','agent')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  paired_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_family_phone_devices_user_id ON family_phone_devices (user_id);

CREATE TABLE IF NOT EXISTS family_phone_pair_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_code    TEXT    NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('handset','pwa','agent')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  consumed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_family_phone_pair_user_code  ON family_phone_pair_requests (user_code);
CREATE INDEX IF NOT EXISTS idx_family_phone_pair_expires_at ON family_phone_pair_requests (expires_at);

CREATE TABLE IF NOT EXISTS family_phone_device_keys (
  device_id   INTEGER PRIMARY KEY REFERENCES family_phone_devices(id) ON DELETE CASCADE,
  public_key  BLOB    NOT NULL,
  alg         TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

export const familyPhoneApp: ApiApp = {
  id: 'family-phone',
  schema: SCHEMA,
  /**
   * `/api/family-phone/pair/complete` is called by a brand-new device that
   * has no credentials yet — it would be turned away by the global
   * user-principal gate. The handler enforces auth on its own terms (the
   * submitted user_code must match an un-consumed, un-expired pair request).
   * All other family-phone routes still flow through the global gate.
   */
  ownsAuthFor: (method, pathname) =>
    method === 'POST' && pathname === '/api/family-phone/pair/complete',
  routes: (ctx) => {
    const devices = familyPhoneHttpRoutes({
      db: ctx.db,
      getPrincipal: ctx.getPrincipal,
    });
    const pair = familyPhonePairHttpRoutes({
      db: ctx.db,
      getPrincipal: ctx.getPrincipal,
    });
    return new Elysia().use(devices).use(pair);
  },
};
