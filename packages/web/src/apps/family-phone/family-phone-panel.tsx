import {
  Badge,
  Button,
  Cluster,
  Layout,
  Surface,
  Text,
} from '@fairfox/polly/ui';
import { Show } from '@preact/signals/utils';
import type { FamilyPhoneDevice, VoiceMessage } from '@eal/client';
import {
  $activeCall,
  $callNote,
  $callTranscript,
  $diagnosticsResult,
  $incomingCall,
  $leaveMessage,
  $playingVoiceMessageId,
  $voiceMessageAudioUrl,
  $voiceMessages,
  $voiceMessagesError,
  type ActiveCall,
  type CallTranscriptEntry,
  type DiagnosticsResult,
  type LeaveMessage,
} from './stores.ts';
import {
  $deviceConnection,
  $devices,
  $pairedThisSession,
  type PairedThisSession,
} from '../devices/stores.ts';

function deviceLabel(devices: FamilyPhoneDevice[], id: number): string {
  return devices.find((d) => d.id === id)?.label ?? `device #${id}`;
}

function IncomingCallBanner(props: {
  callId: string;
  fromDeviceId: number;
  devices: FamilyPhoneDevice[];
}) {
  const from = deviceLabel(props.devices, props.fromDeviceId);
  return (
    <Surface variant="callout" padding="var(--polly-space-md)" className="family-phone-incoming">
      <Cluster gap="var(--polly-space-md)" justify="space-between">
        <Layout gap="var(--polly-space-xs)">
          <Text as="h2" weight="bold">Ringing</Text>
          <Text>{from} is calling.</Text>
        </Layout>
        <Cluster gap="var(--polly-space-sm)">
          <Button
            tier="primary"
            color="success"
            label="Accept"
            data-action="family-phone:accept-call"
            data-action-call-id={props.callId}
          />
          <Button
            tier="secondary"
            color="danger"
            label="Reject"
            data-action="family-phone:reject-call"
            data-action-call-id={props.callId}
          />
        </Cluster>
      </Cluster>
    </Surface>
  );
}

function CallTranscript(props: { entries: CallTranscriptEntry[] }) {
  return (
    <Layout gap="var(--polly-space-xs)" className="family-phone-transcript">
      {props.entries.map((entry) => (
        <Text key={entry.id}>{entry.text}</Text>
      ))}
    </Layout>
  );
}

function ActiveCallSurface(props: { call: ActiveCall; devices: FamilyPhoneDevice[] }) {
  const { call } = props;
  const peer = deviceLabel(props.devices, call.peerDeviceId);
  const stateLabel =
    call.state === 'pending'
      ? call.role === 'caller'
        ? `Ringing ${peer}…`
        : `Connecting to ${peer}…`
      : call.state === 'connected'
        ? `In call with ${peer}`
        : 'Ending call…';
  const hangupLabel =
    call.state === 'pending' && call.role === 'caller' ? 'Cancel' : 'Hang up';
  return (
    <Surface variant="callout" padding="var(--polly-space-md)" className="family-phone-active-call">
      <Cluster gap="var(--polly-space-md)" justify="space-between">
        <Layout gap="var(--polly-space-xs)">
          <Text as="h2" weight="bold">{stateLabel}</Text>
          <Text tone="muted">
            {call.state === 'connected'
              ? 'Microphone live — speak into the device.'
              : 'Connecting audio…'}
          </Text>
        </Layout>
        <Button
          tier="primary"
          color="danger"
          label={hangupLabel}
          data-action="family-phone:hangup"
          disabled={call.state === 'closing'}
        />
      </Cluster>
      <Show when={() => $callTranscript.value.length > 0}>
        <CallTranscript entries={$callTranscript.value} />
      </Show>
    </Surface>
  );
}

function DiagnosticsCard(props: { result: DiagnosticsResult | null }) {
  const variant: 'success' | 'danger' | 'info' = props.result?.tone ?? 'info';
  return (
    <Surface variant="callout" padding="var(--polly-space-md)" className="family-phone-diagnostics">
      <Layout gap="var(--polly-space-sm)">
        <Text as="h2" weight="bold">Diagnostics</Text>
        <Text tone="muted">
          Verify that this device can hear, speak, and is allowed to ring before placing a call.
        </Text>
        <Cluster gap="var(--polly-space-xs)">
          <Button
            tier="secondary"
            label="Sound check"
            data-action="family-phone:sound-check"
          />
          <Button
            tier="secondary"
            label="Mic check"
            data-action="family-phone:mic-check"
          />
          <Button
            tier="secondary"
            label="Permissions check"
            data-action="family-phone:permissions-check"
          />
        </Cluster>
        <Show when={() => props.result !== null}>
          {() => (
            <Layout
              gap="var(--polly-space-xs)"
              className={`family-phone-diag-result family-phone-diag-result--${variant}`}
            >
              <Text>{props.result?.message ?? ''}</Text>
              <Cluster>
                <Button
                  tier="tertiary"
                  label="Dismiss"
                  data-action="family-phone:dismiss-diagnostics"
                />
              </Cluster>
            </Layout>
          )}
        </Show>
      </Layout>
    </Surface>
  );
}

function LeaveMessageSurface(props: {
  prompt: LeaveMessage;
  devices: FamilyPhoneDevice[];
}) {
  const { prompt } = props;
  const peer = deviceLabel(props.devices, prompt.peerDeviceId);
  const seconds = Math.max(0, Math.round(prompt.durationMs / 100) / 10);
  return (
    <Surface variant="callout" padding="var(--polly-space-md)" className="family-phone-leave-message">
      <Layout gap="var(--polly-space-sm)">
        {prompt.state === 'prompt' && (
          <>
            <Text as="h2" weight="bold">Leave a message for {peer}?</Text>
            <Text tone="muted">Record a voice message they'll see in their voicemails.</Text>
            <Cluster gap="var(--polly-space-sm)">
              <Button
                tier="primary"
                label="Record message"
                data-action="family-phone:leave-message-start"
              />
              <Button
                tier="tertiary"
                label="No thanks"
                data-action="family-phone:leave-message-cancel"
              />
            </Cluster>
          </>
        )}
        {prompt.state === 'recording' && (
          <>
            <Text as="h2" weight="bold">Recording for {peer}…</Text>
            <Text tone="muted">{seconds.toFixed(1)}s — speak, then send.</Text>
            <Cluster gap="var(--polly-space-sm)">
              <Button
                tier="primary"
                color="success"
                label="Send"
                data-action="family-phone:leave-message-send"
              />
              <Button
                tier="secondary"
                color="danger"
                label="Cancel"
                data-action="family-phone:leave-message-cancel"
              />
            </Cluster>
          </>
        )}
        {prompt.state === 'sending' && (
          <>
            <Text as="h2" weight="bold">Sending message…</Text>
            <Text tone="muted">Posting {seconds.toFixed(1)}s of audio to {peer}.</Text>
          </>
        )}
        {prompt.error !== null && (
          <Text tone="muted" className="family-phone-leave-message-error">
            {prompt.error}
          </Text>
        )}
      </Layout>
    </Surface>
  );
}

function CallNoteStrip(props: { note: string }) {
  return (
    <Surface variant="callout" padding="var(--polly-space-sm)" className="family-phone-note">
      <Cluster gap="var(--polly-space-sm)" justify="space-between">
        <Text>{props.note}</Text>
        <Button
          tier="tertiary"
          label="Dismiss"
          data-action="family-phone:dismiss-note"
        />
      </Cluster>
    </Surface>
  );
}

function PairFirstNotice() {
  return (
    <Surface variant="callout" padding="var(--polly-space-md)" className="family-phone-pair-first">
      <Layout gap="var(--polly-space-sm)">
        <Text as="h2" weight="bold">This browser is not paired</Text>
        <Text tone="muted">
          Open Devices to pair this browser into the household. Once paired,
          you can place and receive calls here.
        </Text>
        <Cluster>
          <Button tier="primary" label="Go to Devices" href="/devices" />
        </Cluster>
      </Layout>
    </Surface>
  );
}

function CallableDeviceRow(props: {
  device: FamilyPhoneDevice;
  paired: PairedThisSession | null;
  hasConnection: boolean;
  hasActiveCall: boolean;
}) {
  const { device, paired, hasConnection, hasActiveCall } = props;
  const isSelf = paired !== null && paired.deviceId === device.id;
  const canCall = hasConnection && !isSelf && !hasActiveCall && device.online;
  const reason = isSelf
    ? 'This is your own device.'
    : !hasConnection
      ? 'Pair this browser in Devices to place a call.'
      : hasActiveCall
        ? 'Already in a call.'
        : !device.online
          ? 'That device is offline.'
          : undefined;
  return (
    <Cluster
      gap="var(--polly-space-sm)"
      justify="space-between"
      className="family-phone-device-row"
    >
      <Cluster gap="var(--polly-space-sm)">
        <Text weight="medium">{device.label}</Text>
        <Text tone="muted">({device.ownerDisplayName})</Text>
        {isSelf && <Badge variant="info">this device</Badge>}
        {device.kind === 'agent' && <Badge variant="info">assistant</Badge>}
      </Cluster>
      <Cluster gap="var(--polly-space-xs)">
        <Badge variant={device.online ? 'success' : 'default'}>
          {device.online ? 'online' : 'offline'}
        </Badge>
        <Button
          tier="primary"
          label="Call"
          disabled={!canCall}
          {...(reason ? { title: reason } : {})}
          data-action="family-phone:place-call"
          data-action-target-device-id={String(device.id)}
        />
      </Cluster>
    </Cluster>
  );
}

function formatLocal(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function voiceMessageFromLabel(
  vm: VoiceMessage,
  devices: FamilyPhoneDevice[],
): string {
  if (vm.fromDeviceId !== null) {
    const from = devices.find((d) => d.id === vm.fromDeviceId);
    if (from) return `${from.label} (${from.ownerDisplayName})`;
    return `device #${vm.fromDeviceId}`;
  }
  if (vm.fromExternal !== null) return vm.fromExternal;
  return 'Unknown';
}

function VoicemailRow(props: { vm: VoiceMessage; devices: FamilyPhoneDevice[] }) {
  const { vm } = props;
  const isPlaying = $playingVoiceMessageId.value === vm.id;
  const audioUrl = $voiceMessageAudioUrl.value;
  return (
    <Surface variant="plain" padding="var(--polly-space-sm)">
      <Layout gap="var(--polly-space-xs)">
        <Cluster gap="var(--polly-space-sm)" justify="space-between">
          <Cluster gap="var(--polly-space-sm)">
            <Text weight="medium">{voiceMessageFromLabel(vm, props.devices)}</Text>
            {vm.readAt === null && <Badge variant="info">new</Badge>}
          </Cluster>
          <Cluster gap="var(--polly-space-xs)">
            <Button
              tier={vm.readAt === null ? 'primary' : 'tertiary'}
              label="Play"
              data-action="family-phone:play-voicemail"
              data-action-voicemail-id={String(vm.id)}
            />
          </Cluster>
        </Cluster>
        <Text tone="muted">{vm.body}</Text>
        <Text tone="muted">
          {formatLocal(vm.createdAt)} • {Math.round(vm.durationMs / 100) / 10}s
        </Text>
        {isPlaying && audioUrl !== null && (
          <audio src={audioUrl} controls autoplay />
        )}
      </Layout>
    </Surface>
  );
}

function VoicemailError(props: { error: string }) {
  return (
    <Layout gap="var(--polly-space-xs)" className="family-phone-diag-result family-phone-diag-result--danger">
      <Text>{props.error}</Text>
      <Cluster>
        <Button
          tier="tertiary"
          label="Dismiss"
          data-action="family-phone:dismiss-voicemail-error"
        />
      </Cluster>
    </Layout>
  );
}

function VoicemailsCard(props: {
  voicemails: VoiceMessage[];
  devices: FamilyPhoneDevice[];
}) {
  const unreadCount = props.voicemails.filter((vm) => vm.readAt === null).length;
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-sm)">
        <Cluster gap="var(--polly-space-sm)" justify="space-between">
          <Cluster gap="var(--polly-space-sm)">
            <Text as="h2" weight="bold">Voicemails</Text>
            {unreadCount > 0 && (
              <Badge variant="info">{unreadCount} new</Badge>
            )}
          </Cluster>
          <Button
            tier="tertiary"
            label="Refresh"
            data-action="family-phone:load-voicemails"
          />
        </Cluster>
        <Show when={$voiceMessagesError}>
          {(err) => <VoicemailError error={err} />}
        </Show>
        <Show
          when={() => props.voicemails.length > 0}
          fallback={<Text tone="muted">No voicemails yet.</Text>}
        >
          <Layout gap="var(--polly-space-xs)">
            {props.voicemails.map((vm) => (
              <VoicemailRow key={vm.id} vm={vm} devices={props.devices} />
            ))}
          </Layout>
        </Show>
      </Layout>
    </Surface>
  );
}

function CallDirectory(props: {
  devices: FamilyPhoneDevice[];
  paired: PairedThisSession | null;
  hasConnection: boolean;
  hasActiveCall: boolean;
}) {
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-sm)">
        <Text as="h2" weight="bold">Call</Text>
        <Show
          when={() => props.devices.length > 0}
          fallback={<Text tone="muted">No devices in the household yet.</Text>}
        >
          <Layout gap="var(--polly-space-xs)">
            {props.devices.map((d) => (
              <CallableDeviceRow
                key={d.id}
                device={d}
                paired={props.paired}
                hasConnection={props.hasConnection}
                hasActiveCall={props.hasActiveCall}
              />
            ))}
          </Layout>
        </Show>
      </Layout>
    </Surface>
  );
}

export function FamilyPhonePanel() {
  // Reads at the top so the panel re-renders on any of these changing; the
  // Show subtrees subscribe to the same signals for fine-grained updates.
  const devices = $devices.value;
  const paired = $pairedThisSession.value;
  const hasConnection = $deviceConnection.value !== null;
  const hasActiveCall = $activeCall.value !== null;

  return (
    <Layout gap="var(--polly-space-lg)" className="family-phone-panel" data-family-phone-panel>
      <Surface variant="plain" padding="var(--polly-space-md)">
        <Text as="h1" weight="bold">Phone</Text>
      </Surface>

      <DiagnosticsCard result={$diagnosticsResult.value} />

      <Show when={$callNote}>
        {(note) => <CallNoteStrip note={note} />}
      </Show>
      <Show when={$incomingCall}>
        {(incoming) => (
          <IncomingCallBanner
            callId={incoming.callId}
            fromDeviceId={incoming.fromDeviceId}
            devices={devices}
          />
        )}
      </Show>
      <Show when={$activeCall}>
        {(call) => <ActiveCallSurface call={call} devices={devices} />}
      </Show>
      <Show when={$leaveMessage}>
        {(prompt) => <LeaveMessageSurface prompt={prompt} devices={devices} />}
      </Show>

      <Show when={() => $pairedThisSession.value === null}>
        <PairFirstNotice />
      </Show>

      <Show when={() => $pairedThisSession.value !== null}>
        <VoicemailsCard voicemails={$voiceMessages.value} devices={devices} />
      </Show>

      <CallDirectory
        devices={devices}
        paired={paired}
        hasConnection={hasConnection}
        hasActiveCall={hasActiveCall}
      />
    </Layout>
  );
}
