import type { ActionRegistry } from '@fairfox/polly/actions';
import type { AppStores } from '../stores.ts';
import { SHELL_ACTIONS } from '../shell/actions.ts';
import { TASKS_ACTIONS } from '../apps/tasks/actions.ts';
import { SHOWCASE_ACTIONS } from '../apps/showcase/actions.ts';

/**
 * The composed action table the event-delegation dispatcher looks up. The
 * shell contributes identity/chat/cli-pair actions; each app contributes its
 * own. Add an app → merge its action set here.
 */
export const ACTION_REGISTRY: ActionRegistry<AppStores> = {
  ...SHELL_ACTIONS,
  ...TASKS_ACTIONS,
  ...SHOWCASE_ACTIONS,
};
