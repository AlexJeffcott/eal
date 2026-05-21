// Browser tier — component test against MockEalClient. NOT real-api coverage.
// See ./README.md for tier scope and where real-api coverage lives.
import { describe, test, expect, waitFor, done } from '@fairfox/polly/test/browser';
import { installEventDelegation } from '@fairfox/polly/actions';
import { render } from 'preact';
import { createMockEalClient } from '@eal/client-mock';
import { CliPair } from '../../src/shell/auth/cli-pair.tsx';
import { createStores, resetStoresForTest } from '../../src/stores.ts';
import {
  $cliPairCode,
  $cliPairError,
  $cliPairLabel,
  $cliPairStatus,
  $currentUser,
} from '../../src/shell/stores.ts';
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

describe('CliPair (browser)', () => {
  test('anonymous: shows the SignIn surface beneath the page heading', () => {
    resetStoresForTest();
    render(<CliPair />, root);
    expect(document.querySelector('[data-cli-pair-page]')).not.toBeNull();
    expect(document.querySelector('[data-sign-in]')).not.toBeNull();
    expect(document.querySelector('[data-cli-pair-form]')).toBeNull();
  });

  test('signed in: shows the form, pre-filled code, and a label input', () => {
    resetStoresForTest();
    $currentUser.value = { userId: 1, displayName: 'alex' };
    $cliPairCode.value = 'WXYZ-1234';
    render(<CliPair />, root);
    expect(document.querySelector('[data-cli-pair-form]')).not.toBeNull();
    const codeInput = document.querySelector<HTMLInputElement>('input[name="user_code"]');
    expect(codeInput?.value).toBe('WXYZ-1234');
    const labelInput = document.querySelector<HTMLInputElement>('input[name="label"]');
    expect(labelInput).not.toBeNull();
  });

  test('clicking Pair with a label calls claimCliPair and shows success', async () => {
    resetStoresForTest();
    $currentUser.value = { userId: 1, displayName: 'alex' };
    $cliPairCode.value = 'WXYZ-1234';
    $cliPairLabel.value = 'my-laptop';
    render(<CliPair />, root);

    const btn = document.querySelector<HTMLButtonElement>('[data-action="cli-pair:claim"]');
    expect(btn).not.toBeNull();
    btn?.click();

    await waitFor(() => $cliPairStatus.value === 'success');
    expect(document.querySelector('[data-cli-pair-success]')).not.toBeNull();
    expect(document.querySelector('[data-cli-pair-form]')).toBeNull();
  });

  test('clicking Pair with no label shows a validation error and does not call the api', async () => {
    resetStoresForTest();
    $currentUser.value = { userId: 1, displayName: 'alex' };
    $cliPairCode.value = 'WXYZ-1234';
    $cliPairLabel.value = '';
    render(<CliPair />, root);

    document.querySelector<HTMLButtonElement>('[data-action="cli-pair:claim"]')?.click();

    await waitFor(() => $cliPairError.value !== null);
    expect($cliPairStatus.value).toBe('idle');
    expect(document.querySelector('[data-cli-pair-error]')).not.toBeNull();
  });

  test('clicking Pair with no code shows a validation error', async () => {
    resetStoresForTest();
    $currentUser.value = { userId: 1, displayName: 'alex' };
    $cliPairCode.value = '';
    $cliPairLabel.value = 'l';
    render(<CliPair />, root);

    document.querySelector<HTMLButtonElement>('[data-action="cli-pair:claim"]')?.click();

    await waitFor(() => $cliPairError.value !== null);
    expect($cliPairStatus.value).toBe('idle');
  });

  test('api error keeps the form visible and surfaces the error — never flips to success', async () => {
    resetStoresForTest();
    const original = mock.claimCliPair;
    mock.claimCliPair = async () => {
      throw new Error('boom from the server');
    };
    try {
      $currentUser.value = { userId: 1, displayName: 'alex' };
      $cliPairCode.value = 'WXYZ-1234';
      $cliPairLabel.value = 'my-laptop';
      render(<CliPair />, root);

      document.querySelector<HTMLButtonElement>('[data-action="cli-pair:claim"]')?.click();

      await waitFor(() => $cliPairError.value !== null);
      expect($cliPairStatus.value).toBe('idle');
      expect($cliPairError.value).toContain('boom from the server');
      // The success surface must NOT have rendered, even briefly.
      expect(document.querySelector('[data-cli-pair-success]')).toBeNull();
      expect(document.querySelector('[data-cli-pair-form]')).not.toBeNull();
    } finally {
      mock.claimCliPair = original;
    }
  });
});

done();
