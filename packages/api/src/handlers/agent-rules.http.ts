import { Elysia, t } from 'elysia';
import { assertNever } from '@eal/shared';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import {
  createAgentRulesRepo,
  type AgentRuleKind,
  type AgentRuleRow,
} from '../db/repos/agent-rules.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import { AuthError } from './auth.shared.ts';

export interface AgentRulesRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
}

/**
 * Wire-shape rule (camelCase, matching the rest of the client). The wire
 * carries `enabled` as a boolean, even though SQLite stores 0/1.
 */
export interface AgentRule {
  id: number;
  name: string;
  enabled: boolean;
  targetDeviceId: number;
  kind: AgentRuleKind;
  body: string | null;
  systemPrompt: string | null;
  nextFireAt: string;
  intervalSec: number | null;
  cooldownSec: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAgentRule(row: AgentRuleRow): AgentRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    targetDeviceId: row.target_device_id,
    kind: row.kind,
    body: row.body,
    systemPrompt: row.system_prompt,
    nextFireAt: row.next_fire_at,
    intervalSec: row.interval_sec,
    cooldownSec: row.cooldown_sec,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requirePrincipal(
  ctx: AgentRulesRoutesContext,
  request: Request,
): Principal {
  const p = ctx.getPrincipal(request);
  if (!p) throw new AuthError(401, 'unauthenticated');
  return p;
}

function parseKind(value: string): AgentRuleKind {
  if (value === 'place_call' || value === 'voice_message') return value;
  throw new AuthError(400, `kind must be "place_call" or "voice_message", got "${value}"`);
}

/**
 * Map a wire-shape `kind` to a sentinel so an exhaustive switch can
 * `assertNever` the impossible branch — keeps the union honest if a
 * third kind is ever added.
 */
function kindForStorage(kind: AgentRuleKind): AgentRuleKind {
  switch (kind) {
    case 'place_call':
      return 'place_call';
    case 'voice_message':
      return 'voice_message';
    default:
      return assertNever(kind);
  }
}

export function agentRulesHttpRoutes(ctx: AgentRulesRoutesContext) {
  const rules = createAgentRulesRepo(ctx.db);
  const devices = createFamilyPhoneDevicesRepo(ctx.db);

  return new Elysia({ prefix: '/api/agent' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .get('/rules', ({ request }) => {
      requirePrincipal(ctx, request);
      return { rules: rules.listAll().map(toAgentRule) };
    })
    .post(
      '/rules',
      ({ body, request, set }) => {
        requirePrincipal(ctx, request);
        const kind = parseKind(body.kind);
        const targetDeviceId = body.target_device_id;
        if (!devices.findById(targetDeviceId)) {
          set.status = 400;
          return { error: `unknown target_device_id ${targetDeviceId}` };
        }
        const trimmedBody = body.body?.trim() || null;
        const trimmedPrompt = body.system_prompt?.trim() || null;
        if (trimmedBody === null && trimmedPrompt === null) {
          set.status = 400;
          return { error: 'one of body or system_prompt is required' };
        }
        const intervalSec =
          body.interval_sec === undefined || body.interval_sec === null
            ? null
            : body.interval_sec;
        if (intervalSec !== null && intervalSec <= 0) {
          set.status = 400;
          return { error: 'interval_sec must be a positive integer when set' };
        }
        const cooldownSec = body.cooldown_sec ?? 0;
        if (cooldownSec < 0) {
          set.status = 400;
          return { error: 'cooldown_sec must be zero or positive' };
        }
        if (body.id !== undefined && body.id !== null) {
          const existing = rules.findById(body.id);
          if (!existing) {
            set.status = 404;
            return { error: `rule ${body.id} not found` };
          }
          const updated = rules.update({
            id: body.id,
            name: body.name,
            enabled: body.enabled,
            targetDeviceId,
            kind: kindForStorage(kind),
            body: trimmedBody,
            systemPrompt: trimmedPrompt,
            nextFireAt: body.next_fire_at,
            intervalSec,
            cooldownSec,
          });
          if (!updated) {
            set.status = 404;
            return { error: `rule ${body.id} not found` };
          }
          return { rule: toAgentRule(updated) };
        }
        const inserted = rules.insert({
          name: body.name,
          enabled: body.enabled,
          targetDeviceId,
          kind: kindForStorage(kind),
          body: trimmedBody,
          systemPrompt: trimmedPrompt,
          nextFireAt: body.next_fire_at,
          intervalSec,
          cooldownSec,
        });
        return { rule: toAgentRule(inserted) };
      },
      {
        body: t.Object({
          id: t.Optional(t.Union([t.Number(), t.Null()])),
          name: t.String(),
          enabled: t.Boolean(),
          target_device_id: t.Number(),
          kind: t.String(),
          body: t.Optional(t.Union([t.String(), t.Null()])),
          system_prompt: t.Optional(t.Union([t.String(), t.Null()])),
          next_fire_at: t.String(),
          interval_sec: t.Optional(t.Union([t.Number(), t.Null()])),
          cooldown_sec: t.Optional(t.Number()),
        }),
      },
    )
    .delete('/rules/:id', ({ params, request, set }) => {
      requirePrincipal(ctx, request);
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        set.status = 400;
        return { error: 'rule id must be a positive integer' };
      }
      const removed = rules.deleteById(id);
      if (!removed) {
        set.status = 404;
        return { error: `rule ${id} not found` };
      }
      return { deleted: true };
    });
}
