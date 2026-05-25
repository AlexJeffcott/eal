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
import { ACTION_REGISTRY } from '../../src/actions/registry.ts';
import { SHOWCASE_SECTIONS } from '../../src/apps/showcase/specimens.tsx';
import { bindShowcaseForm, resetShowcaseStores } from '../../src/apps/showcase/stores.ts';

import '@fairfox/polly/ui/theme.css';
import '@fairfox/polly/ui/styles.css';
import '@fairfox/polly/ui/components.css';
import '../../src/shell/shell.css';
import '../../src/apps/showcase/showcase.css';

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
bindShowcaseForm(stores);
installEventDelegation((dispatch) => {
  const handler = ACTION_REGISTRY[dispatch.action];
  if (handler) void handler({ ...dispatch, stores });
});

/** Mount the shell at `path`, signed in or out, from a reset state. */
function visit(path: string, opts: { signedIn: boolean }): void {
  resetStoresForTest();
  resetShowcaseStores();
  mock.reset();
  $currentUser.value = opts.signedIn ? { userId: 1, displayName: 'Alex' } : null;
  $route.value = path;
  render(<App />, root);
}

describe('showcase — a public, web-only app', () => {
  test('renders for a signed-out visitor, with no sign-in gate', () => {
    visit('/showcase', { signedIn: false });
    expect(document.querySelector('[data-showcase-panel]')).not.toBeNull();
    expect(document.querySelector('[data-sign-in]')).toBeNull();
  });

  test('an authed app still gates a signed-out visitor', () => {
    visit('/tasks', { signedIn: false });
    expect(document.querySelector('[data-sign-in]')).not.toBeNull();
    expect(document.querySelector('[data-tasks-panel]')).toBeNull();
  });

  test('a signed-in user can also open the showcase', () => {
    visit('/showcase', { signedIn: true });
    expect(document.querySelector('[data-showcase-panel]')).not.toBeNull();
  });

  test('every component section is catalogued under its own heading', () => {
    visit('/showcase', { signedIn: false });
    for (const section of SHOWCASE_SECTIONS) {
      const el = document.getElementById(section.id);
      expect(el).not.toBeNull();
      expect(el?.getAttribute('aria-labelledby')).toBe(`${section.id}-heading`);
    }
  });

  test('the theme toggle forces data-polly-theme on the panel', async () => {
    visit('/showcase', { signedIn: false });
    const panel = (): Element | null => document.querySelector('[data-showcase-panel]');
    // `system` leaves the attribute unset so prefers-color-scheme wins.
    expect(panel()?.getAttribute('data-polly-theme')).toBeNull();

    const darkButton = document.querySelector<HTMLElement>(
      '[data-action="showcase:set-theme"][data-action-theme="dark"]',
    );
    if (!darkButton) throw new Error('no dark-theme button');
    darkButton.click();
    await waitFor(() => panel()?.getAttribute('data-polly-theme') === 'dark');
  });

  test('an interactive specimen works — opening the Modal', async () => {
    visit('/showcase', { signedIn: false });
    expect(document.querySelector('[data-polly-modal-backdrop]')).toBeNull();

    const openButton = document.querySelector<HTMLElement>(
      '[data-action="showcase:modal-open"]',
    );
    if (!openButton) throw new Error('no modal-open button');
    openButton.click();
    await waitFor(() => document.querySelector('[data-polly-modal-backdrop]') !== null);
  });
});

done();
