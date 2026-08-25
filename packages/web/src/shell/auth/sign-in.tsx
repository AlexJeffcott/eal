import { Badge, Button, Layout, Surface, Text, TextInput } from '@fairfox/polly/ui';
import { $signInDisplayName, $signInError, $signInInviteCode } from '../stores.ts';

export function SignIn() {
  const error = $signInError.value;
  return (
    <Surface
      variant="raised"
      padding="var(--polly-space-xl)"
      data-sign-in
    >
      <Surface variant="plain" maxInlineSize="var(--polly-measure-prose)">
        <Layout gap="var(--polly-space-md)">
          <Layout gap="var(--polly-space-xs)">
            <h2>Sign in</h2>
            <Text as="p" tone="muted">
              Register a passkey on this device, or sign in with one you've already created.
            </Text>
          </Layout>

          <Layout gap="var(--polly-space-xs)">
            <Text as="label" size="sm" htmlFor="sign-in-display-name">
              Display name <Text tone="muted">(first-time registration only)</Text>
            </Text>
            <TextInput
              id="sign-in-display-name"
              name="displayName"
              value={$signInDisplayName}
              placeholder="e.g. Alex"
            />
          </Layout>

          <Layout gap="var(--polly-space-xs)">
            <Text as="label" size="sm" htmlFor="sign-in-invite-code">
              Invite code <Text tone="muted">(first-time registration only)</Text>
            </Text>
            <TextInput
              id="sign-in-invite-code"
              name="inviteCode"
              inputType="password"
              value={$signInInviteCode}
              placeholder="from the household owner"
            />
            {error ? <Badge variant="danger">{error}</Badge> : null}
          </Layout>

          <Layout
            columns="auto auto"
            gap="var(--polly-space-sm)"
            alignItems="center"
            justifyContent="start"
          >
            <Button
              tier="primary"
              color="info"
              data-action="auth:register"
              label="Register passkey"
            />
            <Button
              tier="secondary"
              data-action="auth:sign-in"
              label="Sign in with passkey"
            />
          </Layout>
        </Layout>
      </Surface>
    </Surface>
  );
}
