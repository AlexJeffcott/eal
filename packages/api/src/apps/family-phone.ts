import { Elysia } from 'elysia';
import { familyPhoneHttpRoutes } from '../handlers/family-phone.http.ts';
import { familyPhonePairHttpRoutes } from '../handlers/family-phone-pair.http.ts';
import { familyPhoneDeviceAuthHttpRoutes } from '../handlers/family-phone-device-auth.http.ts';
import { createFamilyPhoneWsHandler } from '../handlers/family-phone.ws.ts';
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

-- A pair request is a 60s-TTL invite minted by an in-household browser. The
-- joining device supplies its own label and kind on /pair/complete, so this
-- table carries neither — the one-time migration below drops the legacy
-- label/kind columns by recreating the table if it exists with the old shape.
CREATE TABLE IF NOT EXISTS family_phone_pair_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_code    TEXT    NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS family_phone_challenges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    INTEGER NOT NULL REFERENCES family_phone_devices(id) ON DELETE CASCADE,
  nonce        BLOB    NOT NULL UNIQUE,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  consumed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_family_phone_challenges_device_id  ON family_phone_challenges (device_id);
CREATE INDEX IF NOT EXISTS idx_family_phone_challenges_expires_at ON family_phone_challenges (expires_at);

CREATE TABLE IF NOT EXISTS family_phone_device_sessions (
  token_hash    BLOB    PRIMARY KEY,
  device_id     INTEGER NOT NULL REFERENCES family_phone_devices(id) ON DELETE CASCADE,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT    NOT NULL,
  last_used_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_family_phone_device_sessions_device_id  ON family_phone_device_sessions (device_id);
CREATE INDEX IF NOT EXISTS idx_family_phone_device_sessions_expires_at ON family_phone_device_sessions (expires_at);
`;

export const familyPhoneApp: ApiApp = {
  id: 'family-phone',
  schema: SCHEMA,
  /**
   * Routes the family-phone app authenticates on its own terms, bypassing
   * the global user-principal gate:
   *   - /pair/complete   — a brand-new device with no credentials yet
   *   - /device/challenge — a paired device requesting a nonce to sign
   *   - /device/auth     — a paired device submitting a signature
   * The handlers enforce auth on the submitted user_code (pair) or on the
   * cryptographic signature against the registered public key (device).
   * All other family-phone routes still flow through the global gate.
   */
  ownsAuthFor: (method, pathname) => {
    if (method !== 'POST') return false;
    return (
      pathname === '/api/family-phone/pair/complete' ||
      pathname === '/api/family-phone/device/challenge' ||
      pathname === '/api/family-phone/device/auth'
    );
  },
  routes: (ctx) => {
    const broadcastDirectoryChanged = (): void => {
      ctx.ws.broadcast(FAMILY_PHONE_TOPIC, { type: 'directory:changed' });
    };
    const devices = familyPhoneHttpRoutes({
      db: ctx.db,
      getPrincipal: ctx.getPrincipal,
      onlineDevices: ONLINE_DEVICES,
      onDirectoryChanged: broadcastDirectoryChanged,
    });
    const pair = familyPhonePairHttpRoutes({
      db: ctx.db,
      getPrincipal: ctx.getPrincipal,
      onDirectoryChanged: broadcastDirectoryChanged,
    });
    const deviceAuth = familyPhoneDeviceAuthHttpRoutes({ db: ctx.db });
    return new Elysia().use(devices).use(pair).use(deviceAuth);
  },
  ws: {
    prefix: 'call',
    binaryTag: 0x10,
    handler: (ctx) =>
      createFamilyPhoneWsHandler(ctx, ONLINE_DEVICES, FAMILY_PHONE_TOPIC),
  },
};

/**
 * Topic every authenticated family-phone WS subscribes to. The server
 * publishes presence and directory changes to it so each device's panel
 * can re-fetch its devices list without manual refresh.
 */
const FAMILY_PHONE_TOPIC = 'family-phone';

/**
 * Per-process presence set, shared between the WS handler (which mutates it
 * on device auth/close) and the directory HTTP route (which reads it to
 * paint online/offline per row). Process-local — the single-machine deploy
 * makes that fine; a future multi-machine setup moves this to Redis.
 */
const ONLINE_DEVICES = new Set<number>();
