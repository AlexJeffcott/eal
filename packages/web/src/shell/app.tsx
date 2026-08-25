import { Badge, Button, Layout, OverlayRoot, Surface, Text } from '@fairfox/polly/ui';
import { $currentUser, $wsError, $wsState } from './stores.ts';
import { $route } from './router.ts';
import { SignIn } from './auth/sign-in.tsx';
import { CliPair, CLI_PAIR_PATH } from './auth/cli-pair.tsx';
import { ChatPanel } from './chat/chat-panel.tsx';
import { NavDrawer } from './nav-drawer.tsx';
import { Landing } from './landing.tsx';
import { NotFound } from './not-found.tsx';
import { ErrorBoundary, AppErrorFallback } from './error-boundary.tsx';
import { appForPath } from '../apps/registry.ts';

/**
 * The shell — a sticky top bar wrapping whichever app the router has mounted,
 * with the nav and the assistant as overlays reachable from the bar at every
 * width. Apps come and go; the shell is always here. See `shell.css`.
 */
export function App() {
  const user = $currentUser.value;
  const wsState = $wsState.value;
  const wsError = $wsError.value;
  const route = $route.value;

  const activeApp = appForPath(route);
  // cli-pair is a shell route — it carries its own sign-in prompt, so it
  // renders even when signed out. Otherwise the router mounts the active app,
  // the landing launcher for `/`, or the not-found page for any other path —
  // a dead link the user can recover from. This ternary is the slot where
  // future shell-level pages (an error page, say) would also plug in.
  const onCliPair = route === CLI_PAIR_PATH;
  // A `public` app is a pure client-side route with no API/DB — it renders for
  // anyone, signed in or not, alongside cli-pair as the second sign-in carve-out.
  const onPublicApp = activeApp?.access === 'public';
  const Body = onCliPair
    ? CliPair
    : (activeApp?.root ?? (route === '/' ? Landing : NotFound));

  return (
    <Layout gap="0">
      <Surface
        variant="raised"
        padding="var(--polly-space-md) var(--polly-space-lg)"
        className="shell-topbar"
        data-topbar
      >
        <Layout maxInlineSize="var(--polly-measure-page)">
          <Layout columns="auto 1fr auto" gap="var(--polly-space-sm)" alignItems="center">
            {user ? (
              <Button
                tier="tertiary"
                size="small"
                data-action="shell:nav-toggle"
                label="Menu"
              />
            ) : (
              <span />
            )}
            <span />
            {user ? (
              <Button
                tier="tertiary"
                size="small"
                data-action="chat:toggle"
                label="Assistant"
              />
            ) : (
              <span />
            )}
          </Layout>
        </Layout>
      </Surface>

      <Layout
        maxInlineSize="var(--polly-measure-page)"
        padding="clamp(var(--polly-space-md), 4vw, var(--polly-space-xl))"
        gap="var(--polly-space-lg)"
      >
        {wsState === 'error' ? (
          <Surface
            variant="callout"
            padding="var(--polly-space-md) var(--polly-space-lg)"
            className="shell-callout-danger"
          >
            <Layout columns="auto 1fr" gap="var(--polly-space-sm)" alignItems="center">
              <span data-ws-error>
                <Badge variant="danger">Live updates offline</Badge>
              </span>
              <span data-ws-error-detail>
                <Text tone="muted">{wsError ?? 'connection failed'}</Text>
              </span>
            </Layout>
          </Surface>
        ) : null}

        {/* A dropped socket is silent: the page keeps rendering the last state
            it heard. Say so, or the list looks current when it is not. The
            client is already retrying — see installWsResync in main.tsx. */}
        {wsState === 'reconnecting' ? (
          <Surface
            variant="callout"
            padding="var(--polly-space-md) var(--polly-space-lg)"
          >
            <Layout columns="auto 1fr" gap="var(--polly-space-sm)" alignItems="center">
              <span data-ws-reconnecting>
                <Badge variant="warning">Reconnecting</Badge>
              </span>
              <span data-ws-reconnecting-detail>
                <Text tone="muted">
                  Changes made on your other devices will appear when the connection returns.
                </Text>
              </span>
            </Layout>
          </Surface>
        ) : null}

        {user || onCliPair || onPublicApp ? (
          // Keyed by route so navigating away re-mounts the boundary and
          // clears a caught error — a crashed app never outlives its page.
          <ErrorBoundary key={route} fallback={<AppErrorFallback />}>
            <Body />
          </ErrorBoundary>
        ) : (
          <SignIn />
        )}
      </Layout>

      {user ? <NavDrawer /> : null}
      {user ? <ChatPanel /> : null}
      <OverlayRoot />
    </Layout>
  );
}
