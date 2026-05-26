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
import type { FamilyPhoneDevice, FamilyPhoneDeviceKind } from '@eal/client';
import { $currentUser } from '../../shell/stores.ts';
import {
  $activeCall,
  $callNote,
  $deviceConnection,
  $familyPhoneDevices,
  $familyPhoneError,
  $incomingCall,
  $pairCompleteCode,
  $pairCompleteKind,
  $pairCompleteLabel,
  $pairStartCode,
  $pairStartSecondsLeft,
  $pairedThisSession,
} from './stores.ts';

const KIND_OPTIONS: { value: FamilyPhoneDeviceKind; label: string }[] = [
  { value: 'pwa', label: 'PWA (browser)' },
  { value: 'handset', label: 'Handset' },
  { value: 'agent', label: 'Agent' },
];

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

export function FamilyPhonePanel() {
  const devices = $familyPhoneDevices.value;
  const error = $familyPhoneError.value;
  const startCode = $pairStartCode.value;
  const paired = $pairedThisSession.value;
  const connection = $deviceConnection.value;
  const incoming = $incomingCall.value;
  const active = $activeCall.value;
  const note = $callNote.value;
  const currentUser = $currentUser.value;

  return (
    <Layout gap="var(--polly-space-lg)" className="family-phone-panel">
      <Surface variant="plain" padding="var(--polly-space-md)">
        <Text as="h1" weight="bold">Family phone</Text>
      </Surface>

      {error !== null && (
        <Surface variant="callout" padding="var(--polly-space-sm)" className="family-phone-error">
          <Badge variant="danger">{error}</Badge>
        </Surface>
      )}
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

      <Surface variant="callout" padding="var(--polly-space-md)">
        <Layout gap="var(--polly-space-md)">
          <Text as="h2" weight="bold">Invite a new device</Text>
          <Text tone="muted">
            Hands a one-time code to another browser that should join the
            household. The device joins under whoever is signed in there —
            sign in as yourself to add another of your own devices, or have
            a family member sign in as themselves on the joining browser.
          </Text>
          <Cluster gap="var(--polly-space-sm)">
            <Button
              tier="primary"
              label="Create invite code"
              data-action="family-phone:start-pair"
            />
            {startCode !== null && (
              <Badge variant="info" className="family-phone-code">
                Code: <strong>{startCode}</strong>{' '}
                <span className="family-phone-countdown">
                  expires in {$pairStartSecondsLeft.value}s
                </span>
              </Badge>
            )}
          </Cluster>
        </Layout>
      </Surface>

      {paired === null ? (
        <Surface variant="callout" padding="var(--polly-space-md)">
          <Layout gap="var(--polly-space-md)">
            <Text as="h2" weight="bold">Join the household</Text>
            <Text tone="muted">
              Add this browser to the household using an invite code from
              a device that is already in. Name the device whatever you
              like.
            </Text>
            <Layout gap="var(--polly-space-sm)">
              <ActionInput
                saveOn="input"
                value={$pairCompleteLabel.value}
                action="family-phone:set-complete-label"
                placeholder="Name (e.g. Alex's phone)"
                ariaLabel="Device name"
              />
              <ActionSelect
                value={$pairCompleteKind.value}
                action="family-phone:set-complete-kind"
                options={KIND_OPTIONS}
              />
              <ActionInput
                saveOn="input"
                value={$pairCompleteCode.value}
                action="family-phone:set-complete-code"
                placeholder="Invite code"
                ariaLabel="Invite code"
              />
              <Cluster gap="var(--polly-space-sm)">
                <Button
                  tier="primary"
                  label="Join"
                  data-action="family-phone:complete-pair"
                />
              </Cluster>
            </Layout>
          </Layout>
        </Surface>
      ) : (
        <Surface variant="callout" padding="var(--polly-space-md)">
          <Layout gap="var(--polly-space-md)">
            <Cluster gap="var(--polly-space-sm)" justify="space-between">
              <Cluster gap="var(--polly-space-sm)">
                <Badge variant="success" className="family-phone-paired">
                  Device #{paired.deviceId}
                </Badge>
                {connection !== null ? (
                  <Badge variant="success">connected</Badge>
                ) : (
                  <Badge variant="warning">disconnected</Badge>
                )}
              </Cluster>
              <Button
                tier="tertiary"
                color="danger"
                label="Un-pair"
                data-action="family-phone:unpair"
              />
            </Cluster>
          </Layout>
        </Surface>
      )}

      <Surface variant="callout" padding="var(--polly-space-md)">
        <Layout gap="var(--polly-space-sm)">
          <Cluster gap="var(--polly-space-sm)" justify="space-between">
            <Text as="h2" weight="bold">Devices</Text>
            <Button
              tier="tertiary"
              label="Refresh"
              data-action="family-phone:refresh-devices"
            />
          </Cluster>
          {devices.length === 0 ? (
            <Text tone="muted">No devices paired yet.</Text>
          ) : (
            <Layout gap="var(--polly-space-xs)">
              {devices.map((d) => {
                const isSelf = paired !== null && paired.deviceId === d.id;
                const ownedByMe = currentUser !== null && d.ownerUserId === currentUser.userId;
                const canCall = connection !== null && !isSelf && active === null && d.online;
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
                      <Badge variant="default">{d.kind}</Badge>
                      <Button
                        tier="secondary"
                        label="Call"
                        disabled={!canCall}
                        data-action="family-phone:place-call"
                        data-action-target-device-id={String(d.id)}
                      />
                      {ownedByMe && (
                        <Button
                          tier="tertiary"
                          color="danger"
                          label="Delete"
                          data-action="family-phone:delete-device"
                          data-action-device-id={String(d.id)}
                        />
                      )}
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
