import type { ActionRegistry, ErrorSeverity } from '@fairfox/polly/actions';
import { setError } from '@fairfox/polly/actions';
import { confirm } from '@fairfox/polly/ui';
import type { AppStores } from '../../stores.ts';
import {
  $showcaseCommitted,
  $showcaseModalOpen,
  $showcaseTab,
  $showcaseTheme,
  type ShowcaseTheme,
  showcaseForm,
} from './stores.ts';

const THEMES: readonly ShowcaseTheme[] = ['system', 'light', 'dark'];
const SEVERITIES: readonly ErrorSeverity[] = ['info', 'warning', 'error'];

/**
 * Actions for the showcase app's interactive specimens. Every handler drives a
 * module-local signal or a polly overlay primitive — none touches `stores`, so
 * the showcase stays a web-only public app. `showcaseForm.actions` adds the
 * auto-registered `showcase-form:{open,close,submit}` handlers.
 */
export const SHOWCASE_ACTIONS: ActionRegistry<AppStores> = {
  ...showcaseForm.actions,

  'showcase:set-theme': ({ data }) => {
    const theme = data['theme'];
    if (theme === 'system' || theme === 'light' || theme === 'dark') {
      $showcaseTheme.value = theme;
    }
  },

  'showcase:set-tab': ({ data }) => {
    const id = data['id'];
    if (typeof id === 'string') $showcaseTab.value = id;
  },

  'showcase:modal-open': () => {
    $showcaseModalOpen.value = true;
  },

  'showcase:commit': ({ data }) => {
    const value = data['value'];
    if (typeof value === 'string') $showcaseCommitted.value = value;
  },

  'showcase:toast': ({ data }) => {
    const severity = SEVERITIES.find((s) => s === data['severity']) ?? 'info';
    setError(`This is a ${severity} toast — click it or wait for it to dismiss.`, {
      severity,
    });
  },

  'showcase:confirm': async ({ data }) => {
    const danger = data['danger'] === 'true';
    const ok = await confirm({
      title: danger ? 'Delete this item?' : 'Save your changes?',
      body: danger
        ? 'This cannot be undone. The item will be permanently removed.'
        : 'Your changes will be applied immediately.',
      danger,
      confirmLabel: danger ? 'Delete' : 'Save',
    });
    setError(`ConfirmDialog resolved ${String(ok)}.`, { severity: ok ? 'info' : 'warning' });
  },
};

/** The theme cycle, exposed so the panel can render one button per option. */
export { THEMES };
