import { Button, Layout, Surface, Text } from '@fairfox/polly/ui';

/**
 * Shown for any path no app claims that isn't the landing launcher or a shell
 * route. A dead end with a way out — the launcher is one click away, so a
 * mistyped or stale link never strands the user.
 */
export function NotFound() {
  return (
    <Surface variant="raised" padding="var(--polly-space-xl)" data-not-found>
      <Layout gap="var(--polly-space-lg)">
        <Layout gap="var(--polly-space-xs)">
          <h2>Page not found</h2>
          <Text tone="muted">
            There's nothing at this address. The link may be mistyped, or the page may have moved.
          </Text>
        </Layout>
        <Button
          tier="primary"
          color="info"
          data-action="shell:navigate"
          data-action-path="/"
          label="Back to home"
        />
      </Layout>
    </Surface>
  );
}
