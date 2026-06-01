import { Elysia } from 'elysia';
import { familyPhoneHttpRoutes } from '../handlers/family-phone.http.ts';
import { familyPhonePairHttpRoutes } from '../handlers/family-phone-pair.http.ts';
import { familyPhoneDeviceAuthHttpRoutes } from '../handlers/family-phone-device-auth.http.ts';
import { familyPhoneVoicemailHttpRoutes } from '../handlers/family-phone-voicemail.http.ts';
import { pstnContactsHttpRoutes } from '../handlers/family-phone-pstn-contacts.http.ts';
import { twilioHttpRoutes } from '../handlers/family-phone-twilio.http.ts';
import { twilioMediaWsRoute } from '../handlers/family-phone-twilio.ws.ts';
import { loadTwilioConfig } from '../twilio/config.ts';
import { createTwilioRestClient } from '../twilio/rest.ts';
import { placePstn, type PlacePstnDeps } from '../handlers/family-phone-place-pstn.ts';
import {
  createFamilyPhoneWsHandler,
  DEFAULT_UNANSWERED_MS,
  type FamilyPhoneWsHandlerOptions,
} from '../handlers/family-phone.ws.ts';
import { createCallRouter, type CallRouter } from '../handlers/family-phone-call-router.ts';
import { createFireOfflineCallWake } from '../handlers/family-phone-call-wake.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import type { DatabaseClient } from '../db/client.ts';
import type { WsService } from './types.ts';
import type { ApiApp } from './types.ts';

/**
 * Family-phone's own tables. References the global `users` table (each device
 * is owned by a human, identified the same way as elsewhere in eal). Per-call
 * audio routing state, challenge nonces, and the call matrix are added in
 * later phases — see docs/family-phone.md.
 */
const SCHEMA = `
-- kind='pstn' rows are ephemeral per-E.164 entries created by the Twilio
-- bridge so the inbound (or future outbound) call has a virtual device on
-- the call router. They are not owned by any human, so user_id is NULL —
-- the CHECK enforces the invariant that every other kind has a user_id.
-- The label carries the E.164 (a friendly label can override it later);
-- the partial unique index keeps one row per remote number.
CREATE TABLE IF NOT EXISTS family_phone_devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('handset','pwa','agent','pstn')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  paired_at   TEXT,
  CHECK (kind = 'pstn' OR user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_family_phone_devices_user_id ON family_phone_devices (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_family_phone_devices_pstn_label
  ON family_phone_devices (label) WHERE kind = 'pstn';

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

-- One row per (device, browser-vendor push endpoint). A given device
-- typically has one row (the active subscription), but a key rotation
-- temporarily produces two until the old endpoint's vendor returns
-- 404/410 and the row is dropped. Endpoint is the natural unique key;
-- the device_id index lets the "wake target X" lookup walk just X's
-- rows on every offline call.
CREATE TABLE IF NOT EXISTS family_phone_push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL REFERENCES family_phone_devices(id) ON DELETE CASCADE,
  endpoint    TEXT    NOT NULL UNIQUE,
  p256dh      TEXT    NOT NULL,
  auth        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_family_phone_push_subs_device_id ON family_phone_push_subscriptions (device_id);

-- Voicemails stored for a target device. The agent worker is the
-- first writer (phase 6) but the column shape is wider than that:
-- from_device_id is nullable + from_external carries a phase-7
-- PSTN caller's display name or E.164. Audio is raw 16-bit signed
-- little-endian PCM at the recorded sample_rate / channels; the
-- WAV header is generated on read so the wire format stays canonical
-- and SQLite stores fewer bytes per row.
CREATE TABLE IF NOT EXISTS family_phone_voice_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  to_device_id    INTEGER NOT NULL REFERENCES family_phone_devices(id) ON DELETE CASCADE,
  from_device_id  INTEGER REFERENCES family_phone_devices(id) ON DELETE SET NULL,
  from_external   TEXT,
  body            TEXT    NOT NULL,
  audio_blob      BLOB    NOT NULL,
  sample_rate     INTEGER NOT NULL DEFAULT 24000,
  channels        INTEGER NOT NULL DEFAULT 1,
  duration_ms     INTEGER NOT NULL,
  read_at         TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_family_phone_voice_messages_to_read
  ON family_phone_voice_messages (to_device_id, read_at);

-- Phase 7A: the household's PSTN phonebook — friendly labels for E.164
-- numbers the trunk can dial out to and that may dial in. The contact is
-- household-wide (no user_id) because the trunk is one number shared by
-- the whole house; per-contact allow_in/allow_out is the routing gate
-- 7D will enforce. E.164 shape is validated at the HTTP boundary, not
-- here, so the repo stays a thin store.
CREATE TABLE IF NOT EXISTS family_phone_pstn_contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  e164        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  allow_in    INTEGER NOT NULL DEFAULT 1 CHECK (allow_in IN (0,1)),
  allow_out   INTEGER NOT NULL DEFAULT 1 CHECK (allow_out IN (0,1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_family_phone_pstn_contacts_label
  ON family_phone_pstn_contacts (label);
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
    // The Twilio Media Stream WS upgrade is a GET that carries no Bearer
    // token — Twilio cannot mint one. Endpoint security comes from the
    // signed-URL handoff in the voice webhook's TwiML; 7D adds a per-
    // source allowlist on top.
    if (method === 'GET' && pathname === '/api/family-phone/twilio/media') return true;
    if (method !== 'POST') return false;
    return (
      pathname === '/api/family-phone/pair/complete' ||
      pathname === '/api/family-phone/device/challenge' ||
      pathname === '/api/family-phone/device/auth' ||
      // Twilio voice webhook: authenticated by the X-Twilio-Signature
      // HMAC the handler verifies before doing anything. The global
      // Bearer gate would reject it before that check could run.
      pathname === '/api/family-phone/twilio/voice'
    );
  },
  routes: (ctx) => {
    const broadcastDirectoryChanged = (): void => {
      ctx.ws.broadcast(FAMILY_PHONE_TOPIC, { type: 'directory:changed' });
    };
    const router = getOrCreateRouter(ctx.db, ctx.ws);
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
    const voicemail = familyPhoneVoicemailHttpRoutes({
      db: ctx.db,
      getPrincipal: ctx.getPrincipal,
    });
    const pstnContacts = pstnContactsHttpRoutes({
      db: ctx.db,
      getPrincipal: ctx.getPrincipal,
    });
    // The Twilio webhook only mounts when TWILIO_ENABLED=true and every
    // required env var validates — see twilio/config.ts. With it off the
    // bare family-phone stack still boots; with it on, a missing var
    // fails the boot loudly. The wss:// URL is derived from EAL_ORIGIN
    // (already required for WebAuthn) so the trunk does not duplicate
    // the public-host config.
    const twilio = loadTwilioConfig();
    let app = new Elysia()
      .use(devices)
      .use(pair)
      .use(deviceAuth)
      .use(voicemail)
      .use(pstnContacts);
    if (twilio !== null) {
      const origin = process.env['EAL_ORIGIN'];
      if (origin === undefined || origin === '') {
        throw new Error(
          'EAL_API: TWILIO_ENABLED=true requires EAL_ORIGIN so Twilio can be told the wss:// media URL.',
        );
      }
      const publicHost = new URL(origin).host;
      const devices = createFamilyPhoneDevicesRepo(ctx.db);
      app = app
        .use(twilioHttpRoutes({ twilio, publicHost }))
        .use(
          twilioMediaWsRoute({
            router,
            devices,
            onlineDevices: ONLINE_DEVICES,
          }),
        );
    }
    return app;
  },
  ws: {
    prefix: 'call',
    binaryTag: 0x10,
    handler: (ctx) => {
      const opts: FamilyPhoneWsHandlerOptions = {
        router: getOrCreateRouter(ctx.db, ctx.ws),
      };
      const placePstnFn = buildPlacePstn(ctx.db);
      if (placePstnFn !== undefined) opts.placePstn = placePstnFn;
      return createFamilyPhoneWsHandler(ctx, ONLINE_DEVICES, FAMILY_PHONE_TOPIC, opts);
    },
  },
};

/**
 * Process-wide router cache keyed by db handle. The router carries
 * connection state (which device is on which wsId, the per-call FSM)
 * that the Twilio bridge and the family-phone WS handler must share —
 * the bridge places virtual-side calls and the WS handler turns real
 * handset accepts into router events. Server-factory builds the WS
 * handler before the routes, so this lazy keyed-by-db cache is the
 * simplest way to give both sides the same instance without changing
 * the ApiApp interface.
 */
const ROUTER_BY_DB = new WeakMap<DatabaseClient, CallRouter>();

/**
 * Construct the outbound-PSTN dialer for this db. Returns undefined when
 * TWILIO_ENABLED=false so the WS handler can reply with
 * reason='outbound-disabled' to any handset tap. The function captures
 * the Twilio config + the devices repo + the public TwiML URL once at
 * boot — the call:place-pstn message dispatch is a single async fetch
 * away after that.
 */
function buildPlacePstn(db: DatabaseClient): ((input: { fromDeviceId: number; to: string }) => ReturnType<typeof placePstn>) | undefined {
  const twilio = loadTwilioConfig();
  if (twilio === null) return undefined;
  const origin = process.env['EAL_ORIGIN'];
  if (origin === undefined || origin === '') return undefined;
  const restClient = createTwilioRestClient({ config: twilio });
  const devices = createFamilyPhoneDevicesRepo(db);
  const twimlBaseUrl = new URL('/api/family-phone/twilio/voice', origin).toString();
  const deps: PlacePstnDeps = { restClient, devices, twimlBaseUrl };
  return (input) => placePstn(deps, input);
}

function getOrCreateRouter(db: DatabaseClient, ws: WsService): CallRouter {
  const existing = ROUTER_BY_DB.get(db);
  if (existing) return existing;
  const fireOfflineCallWake = createFireOfflineCallWake(db);
  const created = createCallRouter({
    ws,
    unansweredMs: DEFAULT_UNANSWERED_MS,
    onCallInviteOfflineTarget: (fromDeviceId, targetDeviceId) => {
      void fireOfflineCallWake(targetDeviceId, fromDeviceId);
    },
  });
  ROUTER_BY_DB.set(db, created);
  return created;
}

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
