import { Badge, Button, Layout, Modal, Text } from '@fairfox/polly/ui';
import { $currentUser, $navOpen } from './stores.ts';
import { $route } from './router.ts';
import { SignOut } from './auth/sign-out.tsx';
import { CLI_PAIR_PATH } from './auth/cli-pair.tsx';
import { WEB_APPS, appForPath } from '../apps/registry.ts';

/**
 * The shell's navigation — a left-edge drawer overlay. Opened by the top bar's
 * Menu button, dismissed by Escape, the backdrop, or picking a destination.
 * Lists Home + every installed app, plus the shell-global device/session
 * utilities. The same drawer at every width; see `shell.css`.
 */
export function NavDrawer() {
  const activeApp = appForPath($route.value);

  return (
    <Modal.Root
      when={$navOpen}
      onClose={() => {
        $navOpen.value = false;
      }}
      aria-label="Navigation"
    >
      <Modal.Backdrop />
      <Modal.Content className="shell-drawer">
        <nav data-app-nav>
          <Layout gap="var(--polly-space-lg)" padding="var(--polly-space-lg)">
            <Layout gap="var(--polly-space-xs)">
              <strong>eal</strong>
              <Text tone="muted">Elisa, Alex and Leo.</Text>
              {$currentUser.value !== null ? (
                <span data-current-user>
                  <Badge variant="success">{$currentUser.value.displayName}</Badge>
                </span>
              ) : null}
            </Layout>

            <Layout gap="var(--polly-space-xs)">
              <Button
                tier={activeApp === null ? 'primary' : 'tertiary'}
                data-action="shell:navigate"
                data-action-path="/"
                label="Home"
              />
              {WEB_APPS.map((a) => (
                <Button
                  key={a.id}
                  tier={activeApp?.id === a.id ? 'primary' : 'tertiary'}
                  data-action="shell:navigate"
                  data-action-path={a.path}
                  label={a.label}
                />
              ))}
            </Layout>

            <Layout gap="var(--polly-space-xs)">
              <Button
                tier="tertiary"
                data-action="shell:navigate"
                data-action-path={CLI_PAIR_PATH}
                label="Pair a CLI device"
              />
              <SignOut />
            </Layout>
          </Layout>
        </nav>
      </Modal.Content>
    </Modal.Root>
  );
}
