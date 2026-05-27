import { agentRulesHttpRoutes } from '../handlers/agent-rules.http.ts';
import type { ApiApp } from './types.ts';

/**
 * The agent app — proactivity rules and (later) action audit + the phone
 * lock that serialises outbound calls. This first slice carries only the
 * rules table; the action handler + lock row arrive with the scheduler.
 *
 * Rules reference `family_phone_devices(id)`, so this app's schema must
 * run after family-phone's in `API_APPS` order.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  target_device_id  INTEGER NOT NULL REFERENCES family_phone_devices(id) ON DELETE CASCADE,
  kind              TEXT    NOT NULL CHECK (kind IN ('place_call','voice_message')),
  body              TEXT,
  system_prompt     TEXT,
  next_fire_at      TEXT    NOT NULL,
  interval_sec      INTEGER,
  cooldown_sec      INTEGER NOT NULL DEFAULT 0,
  last_fired_at     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (body IS NOT NULL OR system_prompt IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_agent_rules_due
  ON agent_rules (enabled, next_fire_at);
`;

export const agentApp: ApiApp = {
  id: 'agent',
  schema: SCHEMA,
  routes: (ctx) =>
    agentRulesHttpRoutes({
      db: ctx.db,
      getPrincipal: ctx.getPrincipal,
    }),
};
