import type { ActionRegistry } from '@fairfox/polly/actions';
import type { AgentRuleKind, UpsertAgentRuleInput } from '@eal/client';
import type { AppStores } from '../../stores.ts';
import { resetAgentRulesDraft, type IntervalUnit } from './stores.ts';

/**
 * Convert a `datetime-local` form value (YYYY-MM-DDTHH:mm in the
 * browser's local time) to a wire-shaped ISO string with the local
 * offset baked in. The server stamps `created_at`/`updated_at` itself,
 * but `next_fire_at` is user-chosen, so we send the moment the user
 * clearly meant rather than the UTC string interpretation.
 */
export function fromDatetimeLocalInput(raw: string): string {
  if (raw.length === 0) return '';
  // The Date constructor parses "YYYY-MM-DDTHH:mm" as local time. That
  // is exactly what the field represented, so toISOString() yields the
  // correct UTC instant.
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function intervalUnitToSeconds(unit: IntervalUnit): number {
  switch (unit) {
    case 'none': return 0;
    case 'minutes': return 60;
    case 'hours': return 3600;
    case 'days': return 86_400;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isKind(value: unknown): value is AgentRuleKind {
  return value === 'place_call' || value === 'voice_message';
}

function isIntervalUnit(value: unknown): value is IntervalUnit {
  return value === 'none' || value === 'minutes' || value === 'hours' || value === 'days';
}

/**
 * Reload the rules list and the recent action log. Best-effort; an
 * error during one of the two requests still surfaces but never
 * blocks the panel from rendering.
 */
export async function refreshAgentRules(stores: AppStores): Promise<void> {
  stores.$agentRulesError.value = null;
  try {
    stores.$agentRules.value = await stores.client.listAgentRules();
  } catch (err) {
    stores.$agentRulesError.value = describeError(err);
  }
  try {
    stores.$agentActions.value = await stores.client.listAgentActions({ limit: 50 });
  } catch (err) {
    if (stores.$agentRulesError.value === null) {
      stores.$agentRulesError.value = describeError(err);
    }
  }
}

export const AGENT_RULES_ACTIONS: ActionRegistry<AppStores> = {
  'agent-rules:set-name': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$rulesDraftName.value = value;
  },

  'agent-rules:set-target-device': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$rulesDraftTargetDeviceId.value = value;
  },

  'agent-rules:set-kind': ({ data, stores }) => {
    const value = data['value'];
    if (!isKind(value)) return;
    stores.$rulesDraftKind.value = value;
  },

  'agent-rules:set-body': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$rulesDraftBody.value = value;
  },

  'agent-rules:set-system-prompt': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$rulesDraftSystemPrompt.value = value;
  },

  'agent-rules:set-next-fire-at': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$rulesDraftNextFireAt.value = value;
  },

  'agent-rules:set-interval-unit': ({ data, stores }) => {
    const value = data['value'];
    if (!isIntervalUnit(value)) return;
    stores.$rulesDraftIntervalUnit.value = value;
  },

  'agent-rules:set-interval-value': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$rulesDraftIntervalValue.value = value;
  },

  'agent-rules:set-cooldown-minutes': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$rulesDraftCooldownMinutes.value = value;
  },

  'agent-rules:refresh': async ({ stores }) => {
    await refreshAgentRules(stores);
  },

  'agent-rules:create': async ({ event, stores }) => {
    event.preventDefault();
    stores.$agentRulesError.value = null;
    const name = stores.$rulesDraftName.value.trim();
    if (name.length === 0) {
      stores.$agentRulesError.value = 'Name is required.';
      return;
    }
    const targetDeviceId = Number(stores.$rulesDraftTargetDeviceId.value);
    if (!Number.isInteger(targetDeviceId) || targetDeviceId <= 0) {
      stores.$agentRulesError.value = 'Pick a target device.';
      return;
    }
    const body = stores.$rulesDraftBody.value.trim();
    const systemPrompt = stores.$rulesDraftSystemPrompt.value.trim();
    if (body.length === 0 && systemPrompt.length === 0) {
      stores.$agentRulesError.value = 'Set either a body or a system prompt.';
      return;
    }
    const nextFireAt = fromDatetimeLocalInput(stores.$rulesDraftNextFireAt.value);
    if (nextFireAt.length === 0) {
      stores.$agentRulesError.value = 'Pick a date and time for the first fire.';
      return;
    }
    const unit = stores.$rulesDraftIntervalUnit.value;
    let intervalSec: number | null = null;
    if (unit !== 'none') {
      const n = Number(stores.$rulesDraftIntervalValue.value);
      if (!Number.isInteger(n) || n <= 0) {
        stores.$agentRulesError.value = 'Interval must be a positive whole number.';
        return;
      }
      intervalSec = n * intervalUnitToSeconds(unit);
    }
    const cooldownMin = Number(stores.$rulesDraftCooldownMinutes.value);
    if (!Number.isFinite(cooldownMin) || cooldownMin < 0) {
      stores.$agentRulesError.value = 'Cooldown must be zero or a positive number of minutes.';
      return;
    }
    const input: UpsertAgentRuleInput = {
      name,
      enabled: true,
      targetDeviceId,
      kind: stores.$rulesDraftKind.value,
      body: body.length === 0 ? null : body,
      systemPrompt: systemPrompt.length === 0 ? null : systemPrompt,
      nextFireAt,
      intervalSec,
      cooldownSec: Math.round(cooldownMin * 60),
    };
    try {
      await stores.client.upsertAgentRule(input);
      resetAgentRulesDraft();
    } catch (err) {
      stores.$agentRulesError.value = describeError(err);
      return;
    }
    await refreshAgentRules(stores);
  },

  'agent-rules:toggle-enabled': async ({ data, stores }) => {
    const raw = data['ruleId'];
    if (typeof raw !== 'string') return;
    const id = Number(raw);
    const rule = stores.$agentRules.value.find((r) => r.id === id);
    if (!rule) return;
    stores.$agentRulesError.value = null;
    try {
      await stores.client.upsertAgentRule({
        id: rule.id,
        name: rule.name,
        enabled: !rule.enabled,
        targetDeviceId: rule.targetDeviceId,
        kind: rule.kind,
        body: rule.body,
        systemPrompt: rule.systemPrompt,
        nextFireAt: rule.nextFireAt,
        intervalSec: rule.intervalSec,
        cooldownSec: rule.cooldownSec,
      });
    } catch (err) {
      stores.$agentRulesError.value = describeError(err);
      return;
    }
    await refreshAgentRules(stores);
  },

  'agent-rules:delete': async ({ data, stores }) => {
    const raw = data['ruleId'];
    if (typeof raw !== 'string') return;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    stores.$agentRulesError.value = null;
    try {
      await stores.client.deleteAgentRule(id);
    } catch (err) {
      stores.$agentRulesError.value = describeError(err);
      return;
    }
    await refreshAgentRules(stores);
  },

  'agent-rules:dismiss-error': ({ stores }) => {
    stores.$agentRulesError.value = null;
  },
};
