import {
  Badge,
  Button,
  Cluster,
  Layout,
  Surface,
  Text,
} from '@fairfox/polly/ui';
import type { FamilyPhoneDevice } from '@eal/client';
import { $activeCall, $callNote, $incomingCall } from './stores.ts';
import { $deviceConnection, $devices, $pairedThisSession } from '../devices/stores.ts';

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

function ActiveCallSurface(props: {
  role: 'caller' | 'callee';
  state: 'pending' | 'connected' | 'closing';
  peerDeviceId: number;
  devices: FamilyPhoneDevice[];
}) {
  const peer = deviceLabel(props.devices, props.peerDeviceId);
  const stateLabel =
    props.state === 'pending'
      ? props.role === 'caller'
        ? `Ringing ${peer}…`
        : `Connecting to ${peer}…`
      : props.state === 'connected'
        ? `In call with ${peer}`
        : 'Ending call…';
  const hangupLabel =
    props.state === 'pending' && props.role === 'caller' ? 'Cancel' : 'Hang up';
  return (
    <Surface variant="callout" padding="var(--polly-space-md)" className="family-phone-active-call">
      <Cluster gap="var(--polly-space-md)" justify="space-between">
        <Layout gap="var(--polly-space-xs)">
          <Text as="h2" weight="bold">{stateLabel}</Text>
          <Text tone="muted">
            {props.state === 'connected'
              ? 'Microphone live — speak into the device.'
              : 'Connecting audio…'}
          </Text>
        </Layout>
        <Button
          tier="primary"
          color="danger"
          label={hangupLabel}
          data-action="family-phone:hangup"
          disabled={props.state === 'closing'}
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

export function FamilyPhonePanel() {
  const devices = $devices.value;
  const paired = $pairedThisSession.value;
  const connection = $deviceConnection.value;
  const incoming = $incomingCall.value;
  const active = $activeCall.value;
  const note = $callNote.value;

  return (
    <Layout gap="var(--polly-space-lg)" className="family-phone-panel">
      <Surface variant="plain" padding="var(--polly-space-md)">
        <Text as="h1" weight="bold">Phone</Text>
      </Surface>

      {note !== null && <CallNoteStrip note={note} />}
      {incoming !== null && (
        <IncomingCallBanner
          callId={incoming.callId}
          fromDeviceId={incoming.fromDeviceId}
          devices={devices}
        />
      )}
      {active !== null && (
        <ActiveCallSurface
          role={active.role}
          state={active.state}
          peerDeviceId={active.peerDeviceId}
          devices={devices}
        />
      )}

      {paired === null && <PairFirstNotice />}

      <Surface variant="callout" padding="var(--polly-space-md)">
        <Layout gap="var(--polly-space-sm)">
          <Text as="h2" weight="bold">Call</Text>
          {devices.length === 0 ? (
            <Text tone="muted">No devices in the household yet.</Text>
          ) : (
            <Layout gap="var(--polly-space-xs)">
              {devices.map((d) => {
                const isSelf = paired !== null && paired.deviceId === d.id;
                const canCall = connection !== null && !isSelf && active === null && d.online;
                const reason = isSelf
                  ? 'This is your own device.'
                  : connection === null
                    ? 'Pair this browser in Devices to place a call.'
                    : active !== null
                      ? 'Already in a call.'
                      : !d.online
                        ? 'That device is offline.'
                        : undefined;
                return (
                  <Cluster
                    key={d.id}
                    gap="var(--polly-space-sm)"
                    justify="space-between"
                    className="family-phone-device-row"
                  >
                    <Cluster gap="var(--polly-space-sm)">
                      <Text weight="medium">{d.label}</Text>
                      <Text tone="muted">({d.ownerDisplayName})</Text>
                      {isSelf && <Badge variant="info">this device</Badge>}
                    </Cluster>
                    <Cluster gap="var(--polly-space-xs)">
                      <Badge variant={d.online ? 'success' : 'default'}>
                        {d.online ? 'online' : 'offline'}
                      </Badge>
                      <Button
                        tier="primary"
                        label="Call"
                        disabled={!canCall}
                        {...(reason ? { title: reason } : {})}
                        data-action="family-phone:place-call"
                        data-action-target-device-id={String(d.id)}
                      />
                    </Cluster>
                  </Cluster>
                );
              })}
            </Layout>
          )}
        </Layout>
      </Surface>
    </Layout>
  );
}
