import { $state } from '@fairfox/polly/state';
import type { PstnContact } from '@eal/client';

/**
 * Reactive state for the PSTN contacts admin panel — the loaded
 * phonebook, the draft for a new contact, the id of a row currently
 * being edited (null when the form is in "create" mode), and any
 * error the last load/save threw.
 */
export const $pstnContacts = $state<PstnContact[]>([]);
export const $pstnContactsError = $state<string | null>(null);

export const $pstnDraftE164 = $state<string>('');
export const $pstnDraftLabel = $state<string>('');
export const $pstnDraftAllowIn = $state<boolean>(true);
export const $pstnDraftAllowOut = $state<boolean>(true);
/** Phase 7D — the user this contact is calling for; null means
 *  fall through to the DTMF IVR. */
export const $pstnDraftIntendedUserId = $state<number | null>(null);
/** null = the form is creating; a number = the form is editing that row. */
export const $pstnEditingId = $state<number | null>(null);

export interface PstnContactsStores {
  $pstnContacts: typeof $pstnContacts;
  $pstnContactsError: typeof $pstnContactsError;
  $pstnDraftE164: typeof $pstnDraftE164;
  $pstnDraftLabel: typeof $pstnDraftLabel;
  $pstnDraftAllowIn: typeof $pstnDraftAllowIn;
  $pstnDraftAllowOut: typeof $pstnDraftAllowOut;
  $pstnDraftIntendedUserId: typeof $pstnDraftIntendedUserId;
  $pstnEditingId: typeof $pstnEditingId;
}

export function createPstnContactsStores(): PstnContactsStores {
  return {
    $pstnContacts,
    $pstnContactsError,
    $pstnDraftE164,
    $pstnDraftLabel,
    $pstnDraftAllowIn,
    $pstnDraftAllowOut,
    $pstnDraftIntendedUserId,
    $pstnEditingId,
  };
}

export function resetPstnContactsDraft(): void {
  $pstnDraftE164.value = '';
  $pstnDraftLabel.value = '';
  $pstnDraftAllowIn.value = true;
  $pstnDraftAllowOut.value = true;
  $pstnDraftIntendedUserId.value = null;
  $pstnEditingId.value = null;
}

export function resetPstnContactsStores(): void {
  $pstnContacts.value = [];
  $pstnContactsError.value = null;
  resetPstnContactsDraft();
}
