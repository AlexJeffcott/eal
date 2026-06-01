// Browser tier — component test against MockEalClient. NOT real-api coverage.
// See ./README.md for tier scope and where real-api coverage lives.
import { describe, test, expect, waitFor, done } from '@fairfox/polly/test/browser';
import { installEventDelegation } from '@fairfox/polly/actions';
import { render } from 'preact';
import { createMockEalClient } from '@eal/client-mock';
import type { PstnContact } from '@eal/client';
import { App } from '../../src/shell/app.tsx';
import { createStores, resetStoresForTest } from '../../src/stores.ts';
import { $currentUser } from '../../src/shell/stores.ts';
import { $route } from '../../src/shell/router.ts';
import {
  $pstnContacts,
  $pstnDraftAllowIn,
  $pstnDraftAllowOut,
  $pstnDraftE164,
  $pstnDraftLabel,
  $pstnEditingId,
} from '../../src/apps/pstn-contacts/stores.ts';
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

function signedInAtPstn(): void {
  resetStoresForTest();
  mock.reset();
  $currentUser.value = { userId: 1, displayName: 'Alex' };
  $route.value = '/pstn-contacts';
  render(<App />, root);
}

function contact(id: number, e164: string, label: string, allowIn = true, allowOut = true): PstnContact {
  return {
    id,
    e164,
    label,
    allowIn,
    allowOut,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  };
}

describe('PstnContactsPanel (browser)', () => {
  test('renders the empty state when no contacts are loaded', () => {
    signedInAtPstn();
    expect(document.querySelector('[data-pstn-contacts-panel]')).not.toBeNull();
    expect(document.querySelector('[data-pstn-empty]')).not.toBeNull();
    expect(document.querySelector('[data-pstn-row]')).toBeNull();
  });

  test('a pre-seeded list renders one row per contact, in the order given', async () => {
    signedInAtPstn();
    $pstnContacts.value = [
      contact(1, '+441234567890', 'Anna'),
      contact(2, '+391234567890', 'Nonno', false, true),
    ];
    await waitFor(
      () => document.querySelectorAll('[data-pstn-row]').length === 2,
    );
    const rows = Array.from(document.querySelectorAll('[data-pstn-row]'));
    expect(rows[0]?.querySelector('[data-pstn-row-label]')?.textContent).toBe('Anna');
    expect(rows[0]?.querySelector('[data-pstn-row-e164]')?.textContent).toBe('+441234567890');
    expect(rows[1]?.querySelector('[data-pstn-row-label]')?.textContent).toBe('Nonno');
  });

  test('the Inbound and Outbound buttons toggle the allow flags', async () => {
    signedInAtPstn();
    expect($pstnDraftAllowIn.value).toBe(true);
    expect($pstnDraftAllowOut.value).toBe(true);

    document
      .querySelector<HTMLElement>('[data-action="pstn-contacts:toggle-allow-in"]')
      ?.click();
    await waitFor(() => $pstnDraftAllowIn.value === false);

    document
      .querySelector<HTMLElement>('[data-action="pstn-contacts:toggle-allow-out"]')
      ?.click();
    await waitFor(() => $pstnDraftAllowOut.value === false);
  });

  test('clicking Edit on a row loads it into the draft and flips the heading', async () => {
    signedInAtPstn();
    $pstnContacts.value = [contact(7, '+391234567890', 'Nonno', false, true)];
    await waitFor(() => document.querySelectorAll('[data-pstn-row]').length === 1);

    document
      .querySelector<HTMLElement>(
        '[data-pstn-row] [data-action="pstn-contacts:start-edit"]',
      )
      ?.click();
    await waitFor(() => $pstnEditingId.value === 7);
    expect($pstnDraftE164.value).toBe('+391234567890');
    expect($pstnDraftLabel.value).toBe('Nonno');
    expect($pstnDraftAllowIn.value).toBe(false);

    await waitFor(
      () =>
        document.querySelector('[data-pstn-contacts-form] h2')?.textContent === 'Edit contact',
    );
    expect(document.querySelector('[data-action="pstn-contacts:save-edit"]')).not.toBeNull();
    expect(document.querySelector('[data-action="pstn-contacts:create"]')).toBeNull();
  });

  test('Cancel returns the form to create mode', async () => {
    signedInAtPstn();
    $pstnContacts.value = [contact(7, '+391234567890', 'Nonno')];
    await waitFor(() => document.querySelectorAll('[data-pstn-row]').length === 1);

    document
      .querySelector<HTMLElement>(
        '[data-pstn-row] [data-action="pstn-contacts:start-edit"]',
      )
      ?.click();
    await waitFor(() => $pstnEditingId.value === 7);

    document
      .querySelector<HTMLElement>('[data-action="pstn-contacts:cancel-edit"]')
      ?.click();
    await waitFor(() => $pstnEditingId.value === null);
    await waitFor(
      () =>
        document.querySelector('[data-pstn-contacts-form] h2')?.textContent === 'New contact',
    );
    expect(document.querySelector('[data-action="pstn-contacts:create"]')).not.toBeNull();
  });

  test('Create with an empty e164 surfaces the inline error', async () => {
    signedInAtPstn();
    document
      .querySelector<HTMLElement>('[data-action="pstn-contacts:create"]')
      ?.click();
    await waitFor(() => stores.$pstnContactsError.value !== null);
    expect(stores.$pstnContactsError.value ?? '').toContain('phone number');
  });

  test('the panel fits a 350px viewport — no row overflows the layout', async () => {
    signedInAtPstn();
    $pstnContacts.value = [
      contact(1, '+441234567890', 'Anna with a moderately long label'),
    ];
    await waitFor(() => document.querySelectorAll('[data-pstn-row]').length === 1);
    const panel = document.querySelector<HTMLElement>('[data-pstn-contacts-panel]');
    expect(panel).not.toBeNull();
    if (!panel) return;
    panel.style.maxWidth = '350px';
    panel.style.boxSizing = 'border-box';
    expect(panel.scrollWidth <= 350).toBe(true);
  });
});

done();
