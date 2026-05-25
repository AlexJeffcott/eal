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
import {
  $familyPhoneDevices,
  $familyPhoneError,
  $pairCompleteCode,
  $pairStartCode,
  $pairStartKind,
  $pairStartLabel,
  $pairedThisSession,
} from './stores.ts';

const KIND_OPTIONS: { value: FamilyPhoneDeviceKind; label: string }[] = [
  { value: 'pwa', label: 'PWA (browser)' },
  { value: 'handset', label: 'Handset' },
  { value: 'agent', label: 'Agent' },
];

function fingerprint(b64: string): string {
  // First 12 base64url characters are enough for a sanity-check fingerprint
  // shown next to the issued device id. Real verification happens by
  // challenge/response, not by humans comparing strings.
  return b64.slice(0, 12);
}

export function FamilyPhonePanel() {
  const devices = $familyPhoneDevices.value;
  const error = $familyPhoneError.value;
  const startCode = $pairStartCode.value;
  const paired = $pairedThisSession.value;

  return (
    <Layout gap="var(--polly-space-lg)" className="family-phone-panel">
      <Surface variant="plain" padding="var(--polly-space-md)">
        <Layout gap="var(--polly-space-sm)">
          <Text as="h1" weight="bold">Family phone</Text>
          <Text as="p" tone="muted">
            Pair a device by speaking a short code from a trusted device to a new one.
            The new device generates a keypair locally; only its public half travels
            over the wire.
          </Text>
        </Layout>
      </Surface>

      {error !== null && (
        <Surface variant="callout" padding="var(--polly-space-sm)" className="family-phone-error">
          <Badge variant="danger">{error}</Badge>
        </Surface>
      )}

      <Surface variant="callout" padding="var(--polly-space-md)">
        <Layout gap="var(--polly-space-md)">
          <Text as="h2" weight="bold">From a trusted device — start pairing</Text>
          <form data-action="family-phone:start-pair">
            <Layout gap="var(--polly-space-sm)">
              <ActionInput
                saveOn="input"
                value={$pairStartLabel.value}
                action="family-phone:set-pair-label"
                placeholder="Label for the new device (e.g. Leo's handset)"
                ariaLabel="New device label"
              />
              <ActionSelect
                value={$pairStartKind.value}
                action="family-phone:set-pair-kind"
                options={KIND_OPTIONS}
              />
              <Cluster gap="var(--polly-space-sm)">
                <Button type="submit" tier="primary" label="Mint code" />
                {startCode !== null && (
                  <Badge variant="info" className="family-phone-code">
                    Speak: <strong>{startCode}</strong>
                  </Badge>
                )}
              </Cluster>
            </Layout>
          </form>
        </Layout>
      </Surface>

      <Surface variant="callout" padding="var(--polly-space-md)">
        <Layout gap="var(--polly-space-md)">
          <Text as="h2" weight="bold">On the new device — complete pairing</Text>
          <form data-action="family-phone:complete-pair">
            <Layout gap="var(--polly-space-sm)">
              <ActionInput
                saveOn="input"
                value={$pairCompleteCode.value}
                action="family-phone:set-complete-code"
                placeholder="Spoken code (e.g. ABC-123)"
                ariaLabel="Spoken pair code"
              />
              <Cluster gap="var(--polly-space-sm)">
                <Button type="submit" tier="primary" label="Generate keypair & pair" />
                {paired !== null && (
                  <Badge variant="success" className="family-phone-paired">
                    Paired as device #{paired.deviceId} ({fingerprint(paired.publicKeyB64)}…)
                  </Badge>
                )}
              </Cluster>
              <Text tone="muted">
                The private key stays in this tab's memory and is lost on reload —
                persistence lands in a later phase.
              </Text>
            </Layout>
          </form>
        </Layout>
      </Surface>

      <Surface variant="callout" padding="var(--polly-space-md)">
        <Layout gap="var(--polly-space-sm)">
          <Cluster gap="var(--polly-space-sm)" justify="space-between">
            <Text as="h2" weight="bold">Your devices</Text>
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
              {devices.map((d) => (
                <Cluster
                  key={d.id}
                  gap="var(--polly-space-sm)"
                  justify="space-between"
                  className="family-phone-device-row"
                >
                  <Text weight="medium">{d.label}</Text>
                  <Cluster gap="var(--polly-space-xs)">
                    <Badge variant="default">{d.kind}</Badge>
                    <Text tone="muted">#{d.id}</Text>
                  </Cluster>
                </Cluster>
              ))}
            </Layout>
          )}
        </Layout>
      </Surface>
    </Layout>
  );
}
