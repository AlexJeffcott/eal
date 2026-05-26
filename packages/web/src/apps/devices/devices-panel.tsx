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
import type { CurrentUser, FamilyPhoneDevice, FamilyPhoneDeviceKind } from '@eal/client';
import { $currentUser } from '../../shell/stores.ts';
import {
  $deviceConnection,
  $devices,
  $devicesError,
  $notificationPermission,
  $pairCompleteCode,
  $pairCompleteKind,
  $pairCompleteLabel,
  $pairStartCode,
  $pairStartSecondsLeft,
  $pairedThisSession,
  type PairedThisSession,
} from './stores.ts';

const KIND_OPTIONS: { value: FamilyPhoneDeviceKind; label: string }[] = [
  { value: 'pwa', label: 'PWA (browser)' },
  { value: 'handset', label: 'Handset' },
  { value: 'agent', label: 'Agent' },
];

function ErrorBanner(props: { error: string }) {
  return (
    <Surface variant="callout" padding="var(--polly-space-sm)" className="devices-error">
      <Cluster gap="var(--polly-space-sm)" justify="space-between">
        <Badge variant="danger">{props.error}</Badge>
        <Button tier="tertiary" label="Dismiss" data-action="devices:dismiss-error" />
      </Cluster>
    </Surface>
  );
}

function InviteCard() {
  return (
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
            data-action="devices:start-pair"
          />
          <Show when={$pairStartCode}>
            {(code) => (
              <Badge variant="info" className="devices-code">
                Code: <strong>{code}</strong>{' '}
                <span className="devices-countdown">
                  expires in {$pairStartSecondsLeft.value}s
                </span>
              </Badge>
            )}
          </Show>
        </Cluster>
      </Layout>
    </Surface>
  );
}

function JoinCard() {
  return (
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
            action="devices:set-complete-label"
            placeholder="Name (e.g. Alex's phone)"
            ariaLabel="Device name"
          />
          <ActionSelect
            value={$pairCompleteKind.value}
            action="devices:set-complete-kind"
            options={KIND_OPTIONS}
          />
          <ActionInput
            saveOn="input"
            value={$pairCompleteCode.value}
            action="devices:set-complete-code"
            placeholder="Invite code"
            ariaLabel="Invite code"
          />
          <Cluster gap="var(--polly-space-sm)">
            <Button tier="primary" label="Join" data-action="devices:complete-pair" />
          </Cluster>
        </Layout>
      </Layout>
    </Surface>
  );
}

function PairedStatusCard(props: { paired: PairedThisSession }) {
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-md)">
        <Cluster gap="var(--polly-space-sm)" justify="space-between">
          <Cluster gap="var(--polly-space-sm)">
            <Badge variant="success" className="devices-paired">
              Device #{props.paired.deviceId}
            </Badge>
            <Show
              when={$deviceConnection}
              fallback={<Badge variant="warning">WS disconnected</Badge>}
            >
              <Badge variant="success">WS connected</Badge>
            </Show>
            <Badge variant={
              $notificationPermission.value === 'granted' ? 'success'
                : $notificationPermission.value === 'denied' ? 'danger'
                  : 'warning'
            }>
              Notifications: {$notificationPermission.value}
            </Badge>
          </Cluster>
          <Cluster gap="var(--polly-space-xs)">
            <Show when={() => $notificationPermission.value !== 'granted'}>
              <Button
                tier="tertiary"
                label="Enable notifications"
                data-action="devices:request-permissions"
              />
            </Show>
            <Button
              tier="tertiary"
              color="danger"
              label="Un-pair"
              data-action="devices:unpair"
            />
          </Cluster>
        </Cluster>
        <Show when={() => $notificationPermission.value === 'denied'}>
          <Text tone="muted">
            Your browser is blocking notifications. Open this site's
            settings (the lock icon in the address bar on desktop, the
            aA menu on iOS Safari) and switch Notifications to Allow,
            then reload.
          </Text>
        </Show>
      </Layout>
    </Surface>
  );
}

function DirectoryCard(props: {
  devices: FamilyPhoneDevice[];
  paired: PairedThisSession | null;
  currentUser: CurrentUser | null;
}) {
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-sm)">
        <Cluster gap="var(--polly-space-sm)" justify="space-between">
          <Text as="h2" weight="bold">Household devices</Text>
          <Button tier="tertiary" label="Refresh" data-action="devices:refresh" />
        </Cluster>
        <Show
          when={() => props.devices.length > 0}
          fallback={<Text tone="muted">No devices paired yet.</Text>}
        >
          <Layout gap="var(--polly-space-xs)">
            {props.devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                paired={props.paired}
                currentUser={props.currentUser}
              />
            ))}
          </Layout>
        </Show>
      </Layout>
    </Surface>
  );
}

function DeviceRow(props: {
  device: FamilyPhoneDevice;
  paired: PairedThisSession | null;
  currentUser: CurrentUser | null;
}) {
  const { device, paired, currentUser } = props;
  const isSelf = paired !== null && paired.deviceId === device.id;
  const ownedByMe = currentUser !== null && device.ownerUserId === currentUser.userId;
  return (
    <Cluster
      gap="var(--polly-space-sm)"
      justify="space-between"
      className="devices-device-row"
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
        <Badge variant="default">{device.kind}</Badge>
        {ownedByMe && (
          <Button
            tier="tertiary"
            color="danger"
            label="Delete"
            data-action="devices:delete"
            data-action-device-id={String(device.id)}
          />
        )}
      </Cluster>
    </Cluster>
  );
}

export function DevicesPanel() {
  return (
    <Layout gap="var(--polly-space-lg)" className="devices-panel">
      <Surface variant="plain" padding="var(--polly-space-md)">
        <Text as="h1" weight="bold">Devices</Text>
      </Surface>

      <Show when={$devicesError}>
        {(err) => <ErrorBanner error={err} />}
      </Show>

      <InviteCard />

      <Show when={$pairedThisSession} fallback={<JoinCard />}>
        {(paired) => <PairedStatusCard paired={paired} />}
      </Show>

      <DirectoryCard
        devices={$devices.value}
        paired={$pairedThisSession.value}
        currentUser={$currentUser.value}
      />
    </Layout>
  );
}
