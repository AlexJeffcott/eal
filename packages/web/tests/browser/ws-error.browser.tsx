// Browser tier — component test against MockEalClient. NOT real-api coverage.
// See ./README.md for tier scope and where real-api coverage lives.
import { describe, test, expect, done } from '@fairfox/polly/test/browser';
import { render } from 'preact';
import { createMockEalClient } from '@eal/client-mock';
import { App } from '../../src/shell/app.tsx';
import { createStores, resetStoresForTest } from '../../src/stores.ts';
import { $wsError, $wsState } from '../../src/shell/stores.ts';

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

createStores(createMockEalClient());

describe('WS connection state visibility', () => {
  test('the error banner is absent in idle and connected states', () => {
    resetStoresForTest();
    render(<App />, root);
    expect(document.querySelector('[data-ws-error]')).toBeNull();

    $wsState.value = 'connected';
    render(<App />, root);
    expect(document.querySelector('[data-ws-error]')).toBeNull();

    $wsState.value = 'connecting';
    render(<App />, root);
    expect(document.querySelector('[data-ws-error]')).toBeNull();
  });

  test('the error banner appears with the error detail when state flips to error', () => {
    resetStoresForTest();
    $wsState.value = 'error';
    $wsError.value = 'ws connect failed: ECONNREFUSED';
    render(<App />, root);
    const banner = document.querySelector('[data-ws-error]');
    expect(banner).not.toBeNull();
    const detail = document.querySelector('[data-ws-error-detail]');
    expect(detail?.textContent).toBe('ws connect failed: ECONNREFUSED');
  });

  test('clearing the error state hides the banner again', () => {
    resetStoresForTest();
    $wsState.value = 'error';
    $wsError.value = 'something';
    render(<App />, root);
    expect(document.querySelector('[data-ws-error]')).not.toBeNull();

    $wsState.value = 'idle';
    $wsError.value = null;
    render(<App />, root);
    expect(document.querySelector('[data-ws-error]')).toBeNull();
  });
});

done();
