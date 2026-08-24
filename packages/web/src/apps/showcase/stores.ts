import { $state } from '@fairfox/polly/state';
import { createForm, setError } from '@fairfox/polly/actions';
import type { AppStores } from '../../stores.ts';

/**
 * State owned by the showcase app.
 *
 * Unlike the tasks app, none of this is composed into the shared `AppStores`
 * bundle: the showcase is a public, web-only app with no server state, so its
 * signals stay module-local. Action handlers reach them by import, not through
 * the `stores` context.
 */

export type ShowcaseTheme = 'system' | 'light' | 'dark';

/** Theme override, applied to the panel as `data-polly-theme`. `system` omits
 *  the attribute and lets `prefers-color-scheme` decide. */
export const $showcaseTheme = $state<ShowcaseTheme>('system');
/** Drives the live <Modal> specimen. */
export const $showcaseModalOpen = $state<boolean>(false);
/** Drives the live <Dropdown> specimen. */
export const $showcaseDropdownOpen = $state<boolean>(false);
/** Selection for the single-select <Select> specimen. */
export const $showcaseSelectSingle = $state<Set<string>>(new Set(['comet']));
/** Selection for the multi-select <Select> specimen. */
export const $showcaseSelectMulti = $state<Set<string>>(new Set(['comet', 'nebula']));
/** Selection for the clearable single-select <Select> specimen. Starts empty
 *  so the "Any …" clear option is the active row. */
export const $showcaseSelectClearable = $state<Set<string>>(new Set());
/** The live, signal-bound <Checkbox> specimen. */
export const $showcaseChecked = $state<boolean>(true);
/** The controlled <TextInput> specimen value. */
export const $showcaseText = $state<string>('Controlled value');
/** Last value committed by the <ActionInput> / <ActionSelect> specimens. */
export const $showcaseCommitted = $state<string>('—');
/** Active tab id for the <Tabs> specimen. */
export const $showcaseTab = $state<string>('overview');

/**
 * The form behind the <ActionForm> specimen. Its `.actions` are spread into the
 * global registry (see actions.ts). `createForm` requires `bindStores` before a
 * submit can run; the composition root supplies the real `AppStores` (see
 * `bindShowcaseForm`), since a module-scoped form has no stores to hand.
 */
export const showcaseForm = createForm<{ fullName: string; email: string }, AppStores>({
  name: 'showcase-form',
  initialValues: { fullName: '', email: '' },
  onSubmit: ({ values }) => {
    setError(
      `ActionForm submitted — name "${values.fullName || '(empty)'}", ` +
        `email "${values.email || '(empty)'}".`,
      { severity: 'info' },
    );
  },
});

/** Bind the showcase form to the live store bundle. Call once at app boot. */
export function bindShowcaseForm(stores: AppStores): void {
  showcaseForm.bindStores(() => stores);
}

/** Reset every showcase signal to its initial value — for browser-test isolation. */
export function resetShowcaseStores(): void {
  $showcaseTheme.value = 'system';
  $showcaseModalOpen.value = false;
  $showcaseDropdownOpen.value = false;
  $showcaseSelectSingle.value = new Set(['comet']);
  $showcaseSelectMulti.value = new Set(['comet', 'nebula']);
  $showcaseSelectClearable.value = new Set();
  $showcaseChecked.value = true;
  $showcaseText.value = 'Controlled value';
  $showcaseCommitted.value = '—';
  $showcaseTab.value = 'overview';
  showcaseForm.close();
}
