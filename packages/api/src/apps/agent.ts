import { agentRulesHttpRoutes } from '../handlers/agent-rules.http.ts';
import type { ApiApp } from './types.ts';

/**
 * The agent app — proactivity rules, action audit, and the phone lock
 * that serialises outbound calls from the agent's WS.
 *
 * Every table here references `family_phone_devices(id)`, so this app's
 * schema must run after family-phone's in `API_APPS` order. The action
 * handler that uses these tables arrives in a later commit.
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

-- One row per intended user-visible action. The scheduler and the MCP
-- tool both POST to /api/agent/actions/* which inserts a row here, claims
-- the agent_phone_lock, drives the family-phone WS, and updates the row
-- with the outcome. The history of attempts and their results is the
-- audit log the admin UI shows.
CREATE TABLE IF NOT EXISTS agent_actions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id           INTEGER REFERENCES agent_rules(id) ON DELETE SET NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('place_call','voice_message')),
  target_device_id  INTEGER NOT NULL REFERENCES family_phone_devices(id) ON DELETE CASCADE,
  trigger           TEXT    NOT NULL CHECK (trigger IN ('scheduled','tool')),
  result            TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (result IN ('pending','answered','unanswered','rejected','failed','sent')),
  call_id           TEXT,
  error             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_rule_id  ON agent_actions (rule_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_pending
  ON agent_actions (result) WHERE result = 'pending';

-- Serialises outbound calls placed by the agent. A row exists for at
-- most one in-flight call per agent device; the action handler claims
-- the row with INSERT OR FAIL, releases it on the outcome event, and
-- the next scheduler tick sweeps expired claims for crash safety.
CREATE TABLE IF NOT EXISTS agent_phone_lock (
  device_id    INTEGER PRIMARY KEY REFERENCES family_phone_devices(id) ON DELETE CASCADE,
  call_id      TEXT    NOT NULL,
  action_id    INTEGER NOT NULL REFERENCES agent_actions(id) ON DELETE CASCADE,
  expires_at   TEXT    NOT NULL
);
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
