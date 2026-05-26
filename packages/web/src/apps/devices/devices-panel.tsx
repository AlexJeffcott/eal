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
import type { FamilyPhoneDeviceKind } from '@eal/client';
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
} from './stores.ts';

const KIND_OPTIONS: { value: FamilyPhoneDeviceKind; label: string }[] = [
  { value: 'pwa', label: 'PWA (browser)' },
  { value: 'handset', label: 'Handset' },
  { value: 'agent', label: 'Agent' },
];

export function DevicesPanel() {
  const devices = $devices.value;
  const error = $devicesError.value;
  const startCode = $pairStartCode.value;
  const paired = $pairedThisSession.value;
  const connection = $deviceConnection.value;
  const currentUser = $currentUser.value;

  return (
    <Layout gap="var(--polly-space-lg)" className="devices-panel">
      <Surface variant="plain" padding="var(--polly-space-md)">
        <Text as="h1" weight="bold">Devices</Text>
      </Surface>

      {error !== null && (
        <Surface variant="callout" padding="var(--polly-space-sm)" className="devices-error">
          <Cluster gap="var(--polly-space-sm)" justify="space-between">
            <Badge variant="danger">{error}</Badge>
            <Button
              tier="tertiary"
              label="Dismiss"
              data-action="devices:dismiss-error"
            />
          </Cluster>
        </Surface>
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
              data-action="devices:start-pair"
            />
            {startCode !== null && (
              <Badge variant="info" className="devices-code">
                Code: <strong>{startCode}</strong>{' '}
                <span className="devices-countdown">
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
                <Button
                  tier="primary"
                  label="Join"
                  data-action="devices:complete-pair"
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
                <Badge variant="success" className="devices-paired">
                  Device #{paired.deviceId}
                </Badge>
                {connection !== null ? (
                  <Badge variant="success">connected</Badge>
                ) : (
                  <Badge variant="warning">disconnected</Badge>
                )}
              </Cluster>
              <Cluster gap="var(--polly-space-xs)">
                {$notificationPermission.value !== 'granted' && (
                  <Button
                    tier="tertiary"
                    label="Enable notifications"
                    data-action="devices:request-permissions"
                  />
                )}
                <Button
                  tier="tertiary"
                  color="danger"
                  label="Un-pair"
                  data-action="devices:unpair"
                />
              </Cluster>
            </Cluster>
          </Layout>
        </Surface>
      )}

      <Surface variant="callout" padding="var(--polly-space-md)">
        <Layout gap="var(--polly-space-sm)">
          <Cluster gap="var(--polly-space-sm)" justify="space-between">
            <Text as="h2" weight="bold">Household devices</Text>
            <Button
              tier="tertiary"
              label="Refresh"
              data-action="devices:refresh"
            />
          </Cluster>
          {devices.length === 0 ? (
            <Text tone="muted">No devices paired yet.</Text>
          ) : (
            <Layout gap="var(--polly-space-xs)">
              {devices.map((d) => {
                const isSelf = paired !== null && paired.deviceId === d.id;
                const ownedByMe = currentUser !== null && d.ownerUserId === currentUser.userId;
                return (
                  <Cluster
                    key={d.id}
                    gap="var(--polly-space-sm)"
                    justify="space-between"
                    className="devices-device-row"
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
                      {ownedByMe && (
                        <Button
                          tier="tertiary"
                          color="danger"
                          label="Delete"
                          data-action="devices:delete"
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
