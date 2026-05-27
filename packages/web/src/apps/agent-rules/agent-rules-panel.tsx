import {
  ActionInput,
  ActionSelect,
  Badge,
  Button,
  Cluster,
  Layout,
  Surface,
  Text,
} from '@fairfox/polly/ui';
import { Show } from '@preact/signals/utils';
import type {
  AgentAction,
  AgentRule,
  AgentRuleKind,
  FamilyPhoneDevice,
} from '@eal/client';
import { $devices } from '../devices/stores.ts';
import {
  $agentActions,
  $agentRules,
  $agentRulesError,
  $rulesDraftBody,
  $rulesDraftCooldownMinutes,
  $rulesDraftIntervalUnit,
  $rulesDraftIntervalValue,
  $rulesDraftKind,
  $rulesDraftName,
  $rulesDraftNextFireAt,
  $rulesDraftSystemPrompt,
  $rulesDraftTargetDeviceId,
  type IntervalUnit,
} from './stores.ts';

const KIND_OPTIONS: { value: AgentRuleKind; label: string }[] = [
  { value: 'place_call', label: 'Place a call' },
  { value: 'voice_message', label: 'Leave a voice message (not yet implemented)' },
];

const INTERVAL_UNIT_OPTIONS: { value: IntervalUnit; label: string }[] = [
  { value: 'none', label: 'One-shot' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
];

function formatLocal(iso: string): string {
  // Render the ISO timestamp in the user's local timezone, short
  // form. Used in both the rule list and the audit log so an admin
  // can compare "fired at" to "expected next" at a glance.
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function ErrorBanner(props: { error: string }) {
  return (
    <Surface variant="callout" padding="var(--polly-space-sm)">
      <Cluster gap="var(--polly-space-sm)" justify="space-between">
        <Badge variant="danger">{props.error}</Badge>
        <Button
          tier="tertiary"
          label="Dismiss"
          data-action="agent-rules:dismiss-error"
        />
      </Cluster>
    </Surface>
  );
}

function NewRuleCard(props: { devices: FamilyPhoneDevice[] }) {
  const deviceOptions: { value: string; label: string }[] = [
    { value: '', label: 'Pick a contact…' },
    ...props.devices
      .filter((d) => d.kind !== 'agent')
      .map((d) => ({
        value: String(d.id),
        label: `${d.label} (${d.ownerDisplayName})`,
      })),
  ];
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-md)">
        <Text as="h2" weight="bold">New proactivity rule</Text>
        <Text tone="muted">
          The agent fires this rule on its next tick at-or-after the
          scheduled time. Set a one-shot for a single ring, or pick an
          interval to repeat.
        </Text>

        <Layout gap="var(--polly-space-sm)">
          <ActionInput
            saveOn="input"
            value={$rulesDraftName.value}
            action="agent-rules:set-name"
            placeholder="Name (e.g. Ring Leo at bedtime)"
            ariaLabel="Rule name"
          />

          <ActionSelect
            value={$rulesDraftTargetDeviceId.value}
            action="agent-rules:set-target-device"
            options={deviceOptions}
          />

          <ActionSelect
            value={$rulesDraftKind.value}
            action="agent-rules:set-kind"
            options={KIND_OPTIONS}
          />

          <ActionInput
            saveOn="input"
            variant="multi"
            value={$rulesDraftBody.value}
            action="agent-rules:set-body"
            placeholder="Spoken body (the literal message the agent should say)"
            ariaLabel="Spoken body"
          />

          <ActionInput
            saveOn="input"
            variant="multi"
            value={$rulesDraftSystemPrompt.value}
            action="agent-rules:set-system-prompt"
            placeholder="…or a system prompt the agent generates the message from"
            ariaLabel="System prompt"
          />

          <ActionInput
            inputType="datetime-local"
            saveOn="input"
            value={$rulesDraftNextFireAt.value}
            action="agent-rules:set-next-fire-at"
            ariaLabel="First fire time"
          />

          <Cluster gap="var(--polly-space-sm)">
            <ActionSelect
              value={$rulesDraftIntervalUnit.value}
              action="agent-rules:set-interval-unit"
              options={INTERVAL_UNIT_OPTIONS}
            />
            <Show when={() => $rulesDraftIntervalUnit.value !== 'none'}>
              <ActionInput
                inputType="number"
                saveOn="input"
                value={$rulesDraftIntervalValue.value}
                action="agent-rules:set-interval-value"
                placeholder="Interval"
                ariaLabel="Interval value"
              />
            </Show>
          </Cluster>

          <ActionInput
            inputType="number"
            saveOn="input"
            value={$rulesDraftCooldownMinutes.value}
            action="agent-rules:set-cooldown-minutes"
            placeholder="Cooldown (minutes)"
            ariaLabel="Cooldown in minutes"
          />

          <Cluster gap="var(--polly-space-sm)">
            <Button
              tier="primary"
              label="Create rule"
              data-action="agent-rules:create"
            />
          </Cluster>
        </Layout>
      </Layout>
    </Surface>
  );
}

function RuleRow(props: { rule: AgentRule; devices: FamilyPhoneDevice[] }) {
  const target = props.devices.find((d) => d.id === props.rule.targetDeviceId);
  const targetLabel = target
    ? `${target.label} (${target.ownerDisplayName})`
    : `device #${props.rule.targetDeviceId}`;
  return (
    <Surface variant="plain" padding="var(--polly-space-sm)">
      <Layout gap="var(--polly-space-xs)">
        <Cluster gap="var(--polly-space-sm)" justify="space-between">
          <Cluster gap="var(--polly-space-sm)">
            <Text weight="medium">{props.rule.name}</Text>
            <Badge variant={props.rule.enabled ? 'success' : 'default'}>
              {props.rule.enabled ? 'enabled' : 'disabled'}
            </Badge>
            <Badge variant="default">{props.rule.kind}</Badge>
          </Cluster>
          <Cluster gap="var(--polly-space-xs)">
            <Button
              tier="tertiary"
              label={props.rule.enabled ? 'Disable' : 'Enable'}
              data-action="agent-rules:toggle-enabled"
              data-action-rule-id={String(props.rule.id)}
            />
            <Button
              tier="tertiary"
              color="danger"
              label="Delete"
              data-action="agent-rules:delete"
              data-action-rule-id={String(props.rule.id)}
            />
          </Cluster>
        </Cluster>
        <Text tone="muted">
          Rings {targetLabel} • next at {formatLocal(props.rule.nextFireAt)}
          {props.rule.intervalSec !== null
            ? ` • every ${props.rule.intervalSec}s`
            : ' • one-shot'}
          {props.rule.cooldownSec > 0
            ? ` • cooldown ${props.rule.cooldownSec}s`
            : ''}
        </Text>
        {props.rule.body !== null && (
          <Text tone="muted">Body: {props.rule.body}</Text>
        )}
        {props.rule.systemPrompt !== null && (
          <Text tone="muted">Prompt: {props.rule.systemPrompt}</Text>
        )}
      </Layout>
    </Surface>
  );
}

function RulesListCard(props: { rules: AgentRule[]; devices: FamilyPhoneDevice[] }) {
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-sm)">
        <Cluster gap="var(--polly-space-sm)" justify="space-between">
          <Text as="h2" weight="bold">Rules</Text>
          <Button tier="tertiary" label="Refresh" data-action="agent-rules:refresh" />
        </Cluster>
        <Show
          when={() => props.rules.length > 0}
          fallback={<Text tone="muted">No rules yet. Create one above.</Text>}
        >
          <Layout gap="var(--polly-space-xs)">
            {props.rules.map((r) => (
              <RuleRow key={r.id} rule={r} devices={props.devices} />
            ))}
          </Layout>
        </Show>
      </Layout>
    </Surface>
  );
}

function ActionRow(props: { action: AgentAction; devices: FamilyPhoneDevice[] }) {
  const target = props.devices.find((d) => d.id === props.action.targetDeviceId);
  const targetLabel = target
    ? `${target.label} (${target.ownerDisplayName})`
    : `device #${props.action.targetDeviceId}`;
  const tone =
    props.action.result === 'answered' || props.action.result === 'sent'
      ? 'success'
      : props.action.result === 'failed' || props.action.result === 'rejected'
        ? 'danger'
        : props.action.result === 'unanswered'
          ? 'warning'
          : 'info';
  return (
    <Cluster gap="var(--polly-space-sm)" justify="space-between">
      <Cluster gap="var(--polly-space-sm)">
        <Badge variant={tone}>{props.action.result}</Badge>
        <Text weight="medium">#{props.action.id}</Text>
        <Text tone="muted">{props.action.kind} → {targetLabel}</Text>
      </Cluster>
      <Text tone="muted">
        {formatLocal(props.action.createdAt)}
        {props.action.trigger === 'scheduled' ? ' • scheduled' : ' • tool'}
        {props.action.error !== null ? ` • ${props.action.error}` : ''}
      </Text>
    </Cluster>
  );
}

function ActionsLogCard(props: {
  actions: AgentAction[];
  devices: FamilyPhoneDevice[];
}) {
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-sm)">
        <Text as="h2" weight="bold">Recent activity</Text>
        <Show
          when={() => props.actions.length > 0}
          fallback={<Text tone="muted">No actions recorded yet.</Text>}
        >
          <Layout gap="var(--polly-space-xs)">
            {props.actions.map((a) => (
              <ActionRow key={a.id} action={a} devices={props.devices} />
            ))}
          </Layout>
        </Show>
      </Layout>
    </Surface>
  );
}

export function AgentRulesPanel() {
  return (
    <Layout gap="var(--polly-space-lg)">
      <Surface variant="plain" padding="var(--polly-space-md)">
        <Text as="h1" weight="bold">Agent proactivity</Text>
      </Surface>

      <Show when={$agentRulesError}>
        {(err) => <ErrorBanner error={err} />}
      </Show>

      <NewRuleCard devices={$devices.value} />
      <RulesListCard rules={$agentRules.value} devices={$devices.value} />
      <ActionsLogCard actions={$agentActions.value} devices={$devices.value} />
    </Layout>
  );
}
