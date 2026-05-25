import { familyPhoneHttpRoutes } from '../handlers/family-phone.http.ts';
import type { ApiApp } from './types.ts';

/**
 * Family-phone's own tables. References the global `users` table (each device
 * is owned by a human, identified the same way as elsewhere in eal). Per-device
 * public keys, pairing codes, call log, locations, and the call matrix will be
 * added as the corresponding features land — see docs/family-phone.md.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS family_phone_devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('handset','pwa','agent')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_family_phone_devices_user_id ON family_phone_devices (user_id);
`;

export const familyPhoneApp: ApiApp = {
  id: 'family-phone',
  schema: SCHEMA,
  routes: (ctx) =>
    familyPhoneHttpRoutes({
      db: ctx.db,
      getPrincipal: ctx.getPrincipal,
    }),
};
