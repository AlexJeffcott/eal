// Browser tier — component test against MockEalClient. NOT real-api coverage.
// See ./README.md for tier scope and where real-api coverage lives.
import { describe, test, expect, waitFor, done } from '@fairfox/polly/test/browser';
import { installEventDelegation } from '@fairfox/polly/actions';
import { render } from 'preact';
import { createMockEalClient } from '@eal/client-mock';
import { App } from '../../src/shell/app.tsx';
import { createStores, resetStoresForTest } from '../../src/stores.ts';
import { $signInDisplayName } from '../../src/shell/stores.ts';
import { ACTION_REGISTRY } from '../../src/actions/registry.ts';

import '@fairfox/polly/ui/theme.css';
import '@fairfox/polly/ui/styles.css';
import '@fairfox/polly/ui/components.css';

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

describe('SignIn (browser)', () => {
  test('initial render shows the SignIn surface, no current-user, no sign-out', () => {
    resetStoresForTest();
    render(<App />, root);
    expect(document.querySelector('[data-sign-in]')).not.toBeNull();
    expect(document.querySelector('[data-current-user]')).toBeNull();
    expect(document.querySelector('[data-sign-out]')).toBeNull();
  });

  test('clicking "Register passkey" with a display name authenticates and updates the DOM', async () => {
    resetStoresForTest();
    render(<App />, root);

    $signInDisplayName.value = 'Leo';

    const registerBtn = document.querySelector<HTMLButtonElement>('[data-action="auth:register"]');
    expect(registerBtn).not.toBeNull();
    registerBtn?.click();

    await waitFor(() => stores.$currentUser.value !== null);
    expect(stores.$currentUser.value?.displayName).toBe('Leo');

    await waitFor(() => document.querySelector('[data-current-user]')?.textContent === 'Leo');
    expect(document.querySelector('[data-current-user]')?.textContent).toBe('Leo');
    expect(document.querySelector('[data-sign-in]')).toBeNull();

    // Sign-out lives in the nav drawer — open it to confirm it's reachable.
    document.querySelector<HTMLElement>('[data-action="shell:nav-toggle"]')?.click();
    await waitFor(() => document.querySelector('[data-sign-out]') !== null);
    expect(document.querySelector('[data-sign-out]')).not.toBeNull();
  });

  test('sign-out returns to the SignIn view', async () => {
    resetStoresForTest();
    stores.$currentUser.value = { userId: 1, displayName: 'Leo' };
    render(<App />, root);

    expect(document.querySelector('[data-current-user]')?.textContent).toBe('Leo');

    // Sign-out lives in the nav drawer — open it, then click through.
    document.querySelector<HTMLElement>('[data-action="shell:nav-toggle"]')?.click();
    await waitFor(() => document.querySelector('[data-action="auth:sign-out"]') !== null);
    const signOutBtn = document.querySelector<HTMLButtonElement>('[data-action="auth:sign-out"]');
    expect(signOutBtn).not.toBeNull();
    signOutBtn?.click();

    await waitFor(() => stores.$currentUser.value === null);
    await waitFor(() => document.querySelector('[data-sign-in]') !== null);
    expect(document.querySelector('[data-current-user]')).toBeNull();
  });

  test('sign-in failure renders the friendly mapped message and stays on SignIn', async () => {
    resetStoresForTest();
    mock.reset();
    render(<App />, root);

    // Arm the next signInWithPasskey() to reject with the EXACT raw server
    // error the wire-contract test pins down. The friendly mapper in
    // actions/registry.ts must convert this to a copy that mentions the
    // recovery action ("Register"), not the implementation phrase.
    mock.mockSignInError(new Error('webauthn: credential not found'));

    const signInBtn = document.querySelector<HTMLButtonElement>('[data-action="auth:sign-in"]');
    expect(signInBtn).not.toBeNull();
    signInBtn?.click();

    await waitFor(() => stores.$signInError.value !== null);

    // Surface stays — user can retry.
    expect(document.querySelector('[data-sign-in]')).not.toBeNull();
    expect(document.querySelector('[data-current-user]')).toBeNull();

    // The rendered badge must reflect the friendly mapping, NOT the raw
    // wire string. This is the integration check across:
    //   mock throws → registry catches → friendlySignInError maps →
    //   store updated → preact re-renders → DOM shows badge.
    const badgeText = document.querySelector('[data-sign-in]')?.textContent ?? '';
    expect(badgeText).toContain("don't recognise");
    expect(badgeText).not.toContain('webauthn:');
    expect(badgeText).not.toContain('credential not found');
  });

  test('register failure renders the friendly mapped message', async () => {
    resetStoresForTest();
    mock.reset();
    $signInDisplayName.value = 'Leo';
    render(<App />, root);

    mock.mockRegisterError(new Error('NotAllowedError: user cancelled'));

    const registerBtn = document.querySelector<HTMLButtonElement>('[data-action="auth:register"]');
    expect(registerBtn).not.toBeNull();
    registerBtn?.click();

    await waitFor(() => stores.$signInError.value !== null);

    expect(document.querySelector('[data-sign-in]')).not.toBeNull();
    expect(document.querySelector('[data-current-user]')).toBeNull();
    const badgeText = document.querySelector('[data-sign-in]')?.textContent ?? '';
    expect(badgeText).toContain('Registration cancelled');
    expect(badgeText).not.toContain('NotAllowedError');
  });

  test('unmapped failure surfaces the raw message verbatim (triage signal preserved)', async () => {
    resetStoresForTest();
    mock.reset();
    render(<App />, root);

    const unmapped = 'some surprise we have not seen before (id=42)';
    mock.mockSignInError(new Error(unmapped));

    document.querySelector<HTMLButtonElement>('[data-action="auth:sign-in"]')?.click();
    await waitFor(() => stores.$signInError.value !== null);

    expect(stores.$signInError.value).toBe(unmapped);
    expect(document.querySelector('[data-sign-in]')?.textContent ?? '').toContain(unmapped);
  });

  test('arming a sign-in error is single-shot: a second sign-in succeeds normally', async () => {
    resetStoresForTest();
    mock.reset();
    mock.setCurrentUser({ userId: 7, displayName: 'Elisa' });
    mock.mockSignInError(new Error('webauthn: credential not found'));
    render(<App />, root);

    // First click: error.
    document.querySelector<HTMLButtonElement>('[data-action="auth:sign-in"]')?.click();
    await waitFor(() => stores.$signInError.value !== null);
    expect(document.querySelector('[data-sign-in]')).not.toBeNull();

    // Second click: success — the armed error was consumed by the first call.
    document.querySelector<HTMLButtonElement>('[data-action="auth:sign-in"]')?.click();
    await waitFor(() => stores.$currentUser.value !== null);
    expect(stores.$currentUser.value?.displayName).toBe('Elisa');
  });
});

done();
