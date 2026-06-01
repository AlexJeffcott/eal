import type { ActionRegistry } from '@fairfox/polly/actions';
import type { AppStores } from '../../stores.ts';
import { resetPstnContactsDraft } from './stores.ts';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function refreshPstnContacts(stores: AppStores): Promise<void> {
  stores.$pstnContactsError.value = null;
  try {
    stores.$pstnContacts.value = await stores.client.listPstnContacts();
  } catch (err) {
    stores.$pstnContactsError.value = describeError(err);
  }
}

export const PSTN_CONTACTS_ACTIONS: ActionRegistry<AppStores> = {
  'pstn-contacts:set-e164': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$pstnDraftE164.value = value;
  },

  'pstn-contacts:set-label': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$pstnDraftLabel.value = value;
  },

  'pstn-contacts:toggle-allow-in': ({ stores }) => {
    stores.$pstnDraftAllowIn.value = !stores.$pstnDraftAllowIn.value;
  },

  'pstn-contacts:toggle-allow-out': ({ stores }) => {
    stores.$pstnDraftAllowOut.value = !stores.$pstnDraftAllowOut.value;
  },

  'pstn-contacts:refresh': async ({ stores }) => {
    await refreshPstnContacts(stores);
  },

  'pstn-contacts:start-edit': ({ data, stores }) => {
    const raw = data['contactId'];
    if (typeof raw !== 'string') return;
    const id = Number(raw);
    const contact = stores.$pstnContacts.value.find((c) => c.id === id);
    if (!contact) return;
    stores.$pstnEditingId.value = contact.id;
    stores.$pstnDraftE164.value = contact.e164;
    stores.$pstnDraftLabel.value = contact.label;
    stores.$pstnDraftAllowIn.value = contact.allowIn;
    stores.$pstnDraftAllowOut.value = contact.allowOut;
    stores.$pstnContactsError.value = null;
  },

  'pstn-contacts:cancel-edit': ({ stores }) => {
    resetPstnContactsDraft();
    stores.$pstnContactsError.value = null;
  },

  'pstn-contacts:create': async ({ event, stores }) => {
    event.preventDefault();
    stores.$pstnContactsError.value = null;
    const e164 = stores.$pstnDraftE164.value.trim();
    const label = stores.$pstnDraftLabel.value.trim();
    if (e164.length === 0) {
      stores.$pstnContactsError.value = 'A phone number is required.';
      return;
    }
    if (label.length === 0) {
      stores.$pstnContactsError.value = 'A label is required.';
      return;
    }
    try {
      await stores.client.createPstnContact({
        e164,
        label,
        allowIn: stores.$pstnDraftAllowIn.value,
        allowOut: stores.$pstnDraftAllowOut.value,
      });
      resetPstnContactsDraft();
    } catch (err) {
      stores.$pstnContactsError.value = describeError(err);
      return;
    }
    await refreshPstnContacts(stores);
  },

  'pstn-contacts:save-edit': async ({ event, stores }) => {
    event.preventDefault();
    stores.$pstnContactsError.value = null;
    const id = stores.$pstnEditingId.value;
    if (id === null) return;
    const label = stores.$pstnDraftLabel.value.trim();
    if (label.length === 0) {
      stores.$pstnContactsError.value = 'A label is required.';
      return;
    }
    try {
      await stores.client.updatePstnContact({
        id,
        label,
        allowIn: stores.$pstnDraftAllowIn.value,
        allowOut: stores.$pstnDraftAllowOut.value,
      });
      resetPstnContactsDraft();
    } catch (err) {
      stores.$pstnContactsError.value = describeError(err);
      return;
    }
    await refreshPstnContacts(stores);
  },

  'pstn-contacts:delete': async ({ data, stores }) => {
    const raw = data['contactId'];
    if (typeof raw !== 'string') return;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    stores.$pstnContactsError.value = null;
    try {
      await stores.client.deletePstnContact(id);
    } catch (err) {
      stores.$pstnContactsError.value = describeError(err);
      return;
    }
    // If the deleted row was being edited, drop the draft.
    if (stores.$pstnEditingId.value === id) resetPstnContactsDraft();
    await refreshPstnContacts(stores);
  },

  'pstn-contacts:dismiss-error': ({ stores }) => {
    stores.$pstnContactsError.value = null;
  },
};
