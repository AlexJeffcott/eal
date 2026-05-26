import {
  Badge,
  Button,
  Cluster,
  Layout,
  Surface,
  Text,
} from '@fairfox/polly/ui';
import { Show } from '@preact/signals/utils';
import type { FamilyPhoneDevice } from '@eal/client';
import { $activeCall, $callNote, $incomingCall, type ActiveCall } from './stores.ts';
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
    <Layout gap="var(--polly-space-lg)" className="family-phone-panel">
      <Surface variant="plain" padding="var(--polly-space-md)">
        <Text as="h1" weight="bold">Phone</Text>
      </Surface>

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

      <Show when={() => $pairedThisSession.value === null}>
        <PairFirstNotice />
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
