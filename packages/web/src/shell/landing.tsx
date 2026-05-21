import { Button, Layout, Surface, Text } from '@fairfox/polly/ui';
import { WEB_APPS } from '../apps/registry.ts';

/**
 * The shell's home page — a launcher with a card per installed app. Shown at
 * `/` and any route that no app claims.
 */
export function Landing() {
  return (
    <Surface variant="raised" padding="var(--polly-space-xl)" data-landing>
      <Layout gap="var(--polly-space-lg)">
        <Layout gap="var(--polly-space-xs)">
          <h2>Welcome</h2>
          <Text tone="muted">Choose an app to get started.</Text>
        </Layout>
        <Layout gap="var(--polly-space-md)">
          {WEB_APPS.map((app) => (
            <div key={app.id} data-landing-app={app.id}>
              <Surface variant="callout" padding="var(--polly-space-lg)">
                <Layout columns="1fr auto" gap="var(--polly-space-md)" alignItems="center">
                  <Layout gap="var(--polly-space-xs)">
                    <strong>{app.label}</strong>
                    <Text tone="muted">{app.description}</Text>
                  </Layout>
                  <Button
                    tier="primary"
                    color="info"
                    data-action="shell:navigate"
                    data-action-path={app.path}
                    label={`Open ${app.label}`}
                  />
                </Layout>
              </Surface>
            </div>
          ))}
        </Layout>
      </Layout>
    </Surface>
  );
}
