import { beforeEach, describe, expect, test } from 'bun:test';
import { runAction } from '@fairfox/polly/actions';
import { createMockEalClient, type MockEalClient } from '@eal/client-mock';
import { createStores, resetStoresForTest, type AppStores } from '../../stores.ts';
import { PSTN_CONTACTS_ACTIONS } from './actions.ts';

let stores: AppStores;
let mock: MockEalClient;

beforeEach(() => {
  resetStoresForTest();
  mock = createMockEalClient();
  mock.setCurrentUser({ userId: 1, displayName: 'alex' });
  stores = createStores(mock);
});

function fakeEvent(): Event {
  return new Event('submit');
}

async function run(
  action: string,
  data: Record<string, string> = {},
  event: Event = fakeEvent(),
): Promise<void> {
  await runAction(PSTN_CONTACTS_ACTIONS, action, { stores, data, event });
}

describe('pstn-contacts:create validation', () => {
  test('rejects an empty e164', async () => {
    await run('pstn-contacts:create');
    expect(stores.$pstnContactsError.value).toMatch(/phone number/);
  });

  test('rejects an empty label', async () => {
    stores.$pstnDraftE164.value = '+441234567890';
    await run('pstn-contacts:create');
    expect(stores.$pstnContactsError.value).toMatch(/label/);
  });

  test('happy path resets the draft and clears the error', async () => {
    stores.$pstnDraftE164.value = '  +441234567890  ';
    stores.$pstnDraftLabel.value = '  Nonna  ';
    stores.$pstnDraftAllowIn.value = true;
    stores.$pstnDraftAllowOut.value = false;
    await run('pstn-contacts:create');
    expect(stores.$pstnContactsError.value).toBeNull();
    expect(stores.$pstnDraftE164.value).toBe('');
    expect(stores.$pstnDraftLabel.value).toBe('');
    expect(stores.$pstnDraftAllowIn.value).toBe(true);
    expect(stores.$pstnDraftAllowOut.value).toBe(true);
  });
});

describe('pstn-contacts:start-edit', () => {
  test('loads the row into the draft and stamps editingId', () => {
    stores.$pstnContacts.value = [
      {
        id: 7,
        e164: '+391234567890',
        label: 'Nonno',
        allowIn: false,
        allowOut: true,
        createdAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    ];
    void run('pstn-contacts:start-edit', { contactId: '7' });
    expect(stores.$pstnEditingId.value).toBe(7);
    expect(stores.$pstnDraftE164.value).toBe('+391234567890');
    expect(stores.$pstnDraftLabel.value).toBe('Nonno');
    expect(stores.$pstnDraftAllowIn.value).toBe(false);
    expect(stores.$pstnDraftAllowOut.value).toBe(true);
  });

  test('unknown contactId is a no-op', () => {
    void run('pstn-contacts:start-edit', { contactId: '9999' });
    expect(stores.$pstnEditingId.value).toBeNull();
  });
});

describe('pstn-contacts:save-edit', () => {
  test('does nothing when no row is being edited', async () => {
    stores.$pstnDraftLabel.value = 'x';
    await run('pstn-contacts:save-edit');
    expect(stores.$pstnContactsError.value).toBeNull();
  });

  test('rejects an empty label', async () => {
    stores.$pstnEditingId.value = 7;
    stores.$pstnDraftLabel.value = '   ';
    await run('pstn-contacts:save-edit');
    expect(stores.$pstnContactsError.value).toMatch(/label/);
  });

  test('happy path resets the draft', async () => {
    stores.$pstnEditingId.value = 7;
    stores.$pstnDraftLabel.value = 'Nonno (Bologna)';
    stores.$pstnDraftAllowIn.value = false;
    stores.$pstnDraftAllowOut.value = true;
    await run('pstn-contacts:save-edit');
    expect(stores.$pstnEditingId.value).toBeNull();
    expect(stores.$pstnDraftLabel.value).toBe('');
  });
});

describe('pstn-contacts:cancel-edit', () => {
  test('resets the draft and clears any error', () => {
    stores.$pstnEditingId.value = 7;
    stores.$pstnDraftE164.value = '+391234567890';
    stores.$pstnDraftLabel.value = 'Nonno';
    stores.$pstnDraftAllowIn.value = false;
    stores.$pstnContactsError.value = 'previous error';
    void run('pstn-contacts:cancel-edit');
    expect(stores.$pstnEditingId.value).toBeNull();
    expect(stores.$pstnDraftE164.value).toBe('');
    expect(stores.$pstnDraftLabel.value).toBe('');
    expect(stores.$pstnDraftAllowIn.value).toBe(true);
    expect(stores.$pstnContactsError.value).toBeNull();
  });
});

describe('pstn-contacts:toggle-allow-*', () => {
  test('toggle-allow-in flips the boolean', () => {
    expect(stores.$pstnDraftAllowIn.value).toBe(true);
    void run('pstn-contacts:toggle-allow-in');
    expect(stores.$pstnDraftAllowIn.value).toBe(false);
    void run('pstn-contacts:toggle-allow-in');
    expect(stores.$pstnDraftAllowIn.value).toBe(true);
  });

  test('toggle-allow-out flips the boolean', () => {
    expect(stores.$pstnDraftAllowOut.value).toBe(true);
    void run('pstn-contacts:toggle-allow-out');
    expect(stores.$pstnDraftAllowOut.value).toBe(false);
  });
});

describe('pstn-contacts:delete', () => {
  test('drops the editing draft when the deleted row was being edited', async () => {
    stores.$pstnEditingId.value = 7;
    stores.$pstnDraftLabel.value = 'midway';
    await run('pstn-contacts:delete', { contactId: '7' });
    expect(stores.$pstnEditingId.value).toBeNull();
    expect(stores.$pstnDraftLabel.value).toBe('');
  });

  test('non-numeric contactId is a no-op', async () => {
    await run('pstn-contacts:delete', { contactId: 'abc' });
    expect(stores.$pstnContactsError.value).toBeNull();
  });
});

describe('pstn-contacts:dismiss-error', () => {
  test('clears the error signal', () => {
    stores.$pstnContactsError.value = 'something blew up';
    void run('pstn-contacts:dismiss-error');
    expect(stores.$pstnContactsError.value).toBeNull();
  });
});

describe('pstn-contacts:set-* writers', () => {
  test('set-e164 stores the typed value, ignores non-string', () => {
    void run('pstn-contacts:set-e164', { value: '+441234567890' });
    expect(stores.$pstnDraftE164.value).toBe('+441234567890');
    void run('pstn-contacts:set-e164', {});
    expect(stores.$pstnDraftE164.value).toBe('+441234567890');
  });

  test('set-label stores the typed value', () => {
    void run('pstn-contacts:set-label', { value: 'Nonna' });
    expect(stores.$pstnDraftLabel.value).toBe('Nonna');
  });
});

describe('pstn-contacts:refresh', () => {
  test('reloads the list from the client', async () => {
    await run('pstn-contacts:refresh');
    // MockEalClient.listPstnContacts returns [] when nothing is seeded.
    expect(stores.$pstnContacts.value).toEqual([]);
    expect(stores.$pstnContactsError.value).toBeNull();
  });
});

describe('pstn-contacts: error reporting from the network path', () => {
  test('create surfaces a non-Error rejection via String()', async () => {
    const failingClient = Object.assign(createMockEalClient(), {
      async createPstnContact(): Promise<never> {
        throw 'boom-as-string';
      },
    });
    failingClient.setCurrentUser({ userId: 1, displayName: 'alex' });
    const failingStores = createStores(failingClient);
    failingStores.$pstnDraftE164.value = '+441234567890';
    failingStores.$pstnDraftLabel.value = 'Nonna';
    await runAction(PSTN_CONTACTS_ACTIONS, 'pstn-contacts:create', {
      stores: failingStores,
      data: {},
      event: fakeEvent(),
    });
    expect(failingStores.$pstnContactsError.value).toBe('boom-as-string');
  });
});
