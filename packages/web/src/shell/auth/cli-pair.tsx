import { Badge, Button, Code, Layout, Surface, Text, TextInput } from '@fairfox/polly/ui';
import type { ComponentChildren } from 'preact';
import {
  $cliPairCode,
  $cliPairLabel,
  $cliPairError,
  $cliPairStatus,
  $currentUser,
} from '../stores.ts';
import { SignIn } from './sign-in.tsx';

/** The route for device pairing — the path the CLI prints in its verification
 *  link. The shell renders `CliPair` here with its full chrome (top bar, nav
 *  drawer); see `shell/app.tsx`. */
export const CLI_PAIR_PATH = '/public/auth/cli-pair';

/** Stacks the page's surfaces. Padding/width come from the shell content
 *  region — this only owns the inter-surface gap. */
function PageShell({ children }: { children: ComponentChildren }) {
  return <Layout gap="var(--polly-space-lg)">{children}</Layout>;
}

function Heading({ subtitle }: { subtitle: string }) {
  return (
    <Surface variant="raised" padding="var(--polly-space-xl)">
      <Layout gap="var(--polly-space-xs)">
        <h1 data-cli-pair-page>Pair a CLI device</h1>
        <Text as="p" tone="muted">{subtitle}</Text>
      </Layout>
    </Surface>
  );
}

export function CliPair() {
  const status = $cliPairStatus.value;
  const error = $cliPairError.value;
  const user = $currentUser.value;

  if (!user) {
    return (
      <PageShell>
        <Heading subtitle="Sign in below to authorize the device that printed the code." />
        <SignIn />
      </PageShell>
    );
  }

  if (status === 'success') {
    return (
      <PageShell>
        <Surface variant="raised" padding="var(--polly-space-xl)">
          <Layout gap="var(--polly-space-md)">
            <h1 data-cli-pair-page>Pair a CLI device</h1>
            <span data-cli-pair-success>
              <Badge variant="success">Device paired</Badge>
            </span>
            <Text as="p" tone="muted">
              You can close this tab and return to your terminal — the CLI has its token.
            </Text>
          </Layout>
        </Surface>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <Heading subtitle="Enter the code your terminal printed and a label for this device." />
      <Surface
        variant="callout"
        padding="var(--polly-space-lg)"
      >
        <Layout gap="var(--polly-space-xs)">
          <Text as="strong" size="sm" weight="bold">
            Don't have a code yet?
          </Text>
          <Text as="p" tone="muted">
            In a terminal on the device you want to pair, run:
          </Text>
          <Code block>eal auth pair --label "this device"</Code>
          <Text as="p" tone="muted">
            The CLI will print a URL and a code — open the URL or paste the code into the field
            below.
          </Text>
        </Layout>
      </Surface>
      <Surface
        variant="raised"
        padding="var(--polly-space-xl)"
        data-cli-pair-form
      >
        <Surface variant="plain" maxInlineSize="var(--polly-measure-prose)">
          <Layout gap="var(--polly-space-md)">
            <Layout gap="var(--polly-space-xs)">
              <Text as="label" size="sm" htmlFor="cli-pair-code">
                Pairing code
              </Text>
              <TextInput
                id="cli-pair-code"
                name="user_code"
                value={$cliPairCode}
                placeholder="XXXX-XXXX"
              />
            </Layout>

            <Layout gap="var(--polly-space-xs)">
              <Text as="label" size="sm" htmlFor="cli-pair-label">
                Device label
              </Text>
              <TextInput
                id="cli-pair-label"
                name="label"
                value={$cliPairLabel}
                placeholder="e.g. Alex's laptop"
              />
            </Layout>

            {error ? (
              <span data-cli-pair-error>
                <Badge variant="danger">{error}</Badge>
              </span>
            ) : null}

            <Layout columns="auto" justifyContent="start">
              <Button
                tier="primary"
                color="info"
                disabled={status === 'claiming'}
                data-action="cli-pair:claim"
                label={status === 'claiming' ? 'Pairing…' : 'Pair device'}
              />
            </Layout>
          </Layout>
        </Surface>
      </Surface>
    </PageShell>
  );
}
