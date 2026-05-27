import { $state } from '@fairfox/polly/state';
import type { AgentAction, AgentRule, AgentRuleKind } from '@eal/client';

/**
 * Reactive state for the agent rules panel — the list of configured
 * proactivity rules, the running audit log of actions the agent has
 * taken, the draft for a new rule, and any error the last load/save
 * threw. Audit-log entries are read-only — the worker writes them.
 */

export const $agentRules = $state<AgentRule[]>([]);
export const $agentActions = $state<AgentAction[]>([]);
export const $agentRulesError = $state<string | null>(null);

export type IntervalUnit = 'none' | 'minutes' | 'hours' | 'days';

/**
 * Draft state for the "new rule" form. One form on the page at a
 * time; the panel resets it after a successful insert.
 */
export const $rulesDraftName = $state<string>('');
export const $rulesDraftTargetDeviceId = $state<string>(''); // string so the <select> binds cleanly
export const $rulesDraftKind = $state<AgentRuleKind>('place_call');
export const $rulesDraftBody = $state<string>('');
export const $rulesDraftSystemPrompt = $state<string>('');
export const $rulesDraftNextFireAt = $state<string>(''); // datetime-local format: YYYY-MM-DDTHH:mm
export const $rulesDraftIntervalUnit = $state<IntervalUnit>('none');
export const $rulesDraftIntervalValue = $state<string>('');
export const $rulesDraftCooldownMinutes = $state<string>('0');

export interface AgentRulesStores {
  $agentRules: typeof $agentRules;
  $agentActions: typeof $agentActions;
  $agentRulesError: typeof $agentRulesError;
  $rulesDraftName: typeof $rulesDraftName;
  $rulesDraftTargetDeviceId: typeof $rulesDraftTargetDeviceId;
  $rulesDraftKind: typeof $rulesDraftKind;
  $rulesDraftBody: typeof $rulesDraftBody;
  $rulesDraftSystemPrompt: typeof $rulesDraftSystemPrompt;
  $rulesDraftNextFireAt: typeof $rulesDraftNextFireAt;
  $rulesDraftIntervalUnit: typeof $rulesDraftIntervalUnit;
  $rulesDraftIntervalValue: typeof $rulesDraftIntervalValue;
  $rulesDraftCooldownMinutes: typeof $rulesDraftCooldownMinutes;
}

export function createAgentRulesStores(): AgentRulesStores {
  return {
    $agentRules,
    $agentActions,
    $agentRulesError,
    $rulesDraftName,
    $rulesDraftTargetDeviceId,
    $rulesDraftKind,
    $rulesDraftBody,
    $rulesDraftSystemPrompt,
    $rulesDraftNextFireAt,
    $rulesDraftIntervalUnit,
    $rulesDraftIntervalValue,
    $rulesDraftCooldownMinutes,
  };
}

export function resetAgentRulesDraft(): void {
  $rulesDraftName.value = '';
  $rulesDraftTargetDeviceId.value = '';
  $rulesDraftKind.value = 'place_call';
  $rulesDraftBody.value = '';
  $rulesDraftSystemPrompt.value = '';
  $rulesDraftNextFireAt.value = '';
  $rulesDraftIntervalUnit.value = 'none';
  $rulesDraftIntervalValue.value = '';
  $rulesDraftCooldownMinutes.value = '0';
}

export function resetAgentRulesStores(): void {
  $agentRules.value = [];
  $agentActions.value = [];
  $agentRulesError.value = null;
  resetAgentRulesDraft();
}
