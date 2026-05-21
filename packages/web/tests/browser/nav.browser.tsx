// Browser tier — component test against MockEalClient. NOT real-api coverage.
// See ./README.md for tier scope and where real-api coverage lives.
import { describe, test, expect, waitFor, done } from '@fairfox/polly/test/browser';
import { installEventDelegation } from '@fairfox/polly/actions';
import { render } from 'preact';
import { createMockEalClient } from '@eal/client-mock';
import { App } from '../../src/shell/app.tsx';
import { createStores, resetStoresForTest } from '../../src/stores.ts';
import { $currentUser } from '../../src/shell/stores.ts';
import { $route } from '../../src/shell/router.ts';
import { CLI_PAIR_PATH } from '../../src/shell/auth/cli-pair.tsx';
import { ACTION_REGISTRY } from '../../src/actions/registry.ts';

import '@fairfox/polly/ui/theme.css';
import '@fairfox/polly/ui/styles.css';
import '@fairfox/polly/ui/components.css';
import '../../src/shell/shell.css';

const root =
  document.getElementById('app') ??
  (() => {
    const el = document.createElement('div');
    el.id = 'app';
    document.body.appendChild(el);
    return el;
  })();

const mock = createMockEalClient();
const stores = createStores(mock);
installEventDelegation((dispatch) => {
  const handler = ACTION_REGISTRY[dispatch.action];
  if (handler) void handler({ ...dispatch, stores });
});

function signedIn(path: string): void {
  resetStoresForTest();
  mock.reset();
  $currentUser.value = { userId: 1, displayName: 'Alex' };
  $route.value = path;
  render(<App />, root);
}

/** Open the nav drawer, then click the destination inside it. */
async function navViaDrawer(path: string): Promise<void> {
  document.querySelector<HTMLElement>('[data-action="shell:nav-toggle"]')?.click();
  await waitFor(() => document.querySelector('[data-app-nav]') !== null);
  const btns = Array.from(
    document.querySelectorAll<HTMLElement>('[data-app-nav] [data-action="shell:navigate"]'),
  );
  const btn = btns.find((b) => b.getAttribute('data-action-path') === path);
  if (!btn) throw new Error(`no nav button for ${path}`);
  btn.click();
}

describe('shell navigation', () => {
  test('the landing launcher shows at / and lists the apps', () => {
    signedIn('/');
    expect(document.querySelector('[data-landing]')).not.toBeNull();
    expect(document.querySelector('[data-landing-app="tasks"]')).not.toBeNull();
    expect(document.querySelector('[data-tasks-panel]')).toBeNull();
  });

  test('clicking a launcher card navigates into that app', async () => {
    signedIn('/');
    const card = document.querySelector<HTMLElement>(
      '[data-landing-app="tasks"] [data-action="shell:navigate"]',
    );
    if (!card) throw new Error('no launcher card for tasks');
    card.click();

    await waitFor(() => document.querySelector('[data-tasks-panel]') !== null);
    expect($route.value).toBe('/tasks');
    expect(document.querySelector('[data-landing]')).toBeNull();
  });

  test('the nav drawer opens from the top bar and the backdrop closes it', async () => {
    signedIn('/');
    expect(document.querySelector('[data-app-nav]')).toBeNull();

    document.querySelector<HTMLElement>('[data-action="shell:nav-toggle"]')?.click();
    await waitFor(() => document.querySelector('[data-app-nav]') !== null);

    document.querySelector<HTMLElement>('[data-polly-modal-backdrop]')?.click();
    await waitFor(() => document.querySelector('[data-app-nav]') === null);
  });

  test('an unknown route shows the not-found page, with a way back', async () => {
    signedIn('/no-such-page');
    expect(document.querySelector('[data-not-found]')).not.toBeNull();
    expect(document.querySelector('[data-landing]')).toBeNull();

    // The recovery action returns to the launcher — a dead link is not a trap.
    document
      .querySelector<HTMLElement>('[data-not-found] [data-action="shell:navigate"]')
      ?.click();
    await waitFor(() => document.querySelector('[data-landing]') !== null);
    expect($route.value).toBe('/');
  });

  test('the cli-pair page renders inside the shell, with the nav reachable', async () => {
    signedIn(CLI_PAIR_PATH);
    expect(document.querySelector('[data-cli-pair-page]')).not.toBeNull();

    // The shell chrome is present — the top bar's Menu opens the nav drawer,
    // so the pairing page is no longer a dead end.
    document.querySelector<HTMLElement>('[data-action="shell:nav-toggle"]')?.click();
    await waitFor(() => document.querySelector('[data-app-nav]') !== null);
  });

  test('the drawer nav switches apps, and Home returns to the launcher', async () => {
    signedIn('/tasks');
    expect(document.querySelector('[data-tasks-panel]')).not.toBeNull();

    await navViaDrawer('/');
    await waitFor(() => document.querySelector('[data-landing]') !== null);
    expect(document.querySelector('[data-tasks-panel]')).toBeNull();

    await navViaDrawer('/tasks');
    await waitFor(() => document.querySelector('[data-tasks-panel]') !== null);
    expect($route.value).toBe('/tasks');
  });
});

done();
