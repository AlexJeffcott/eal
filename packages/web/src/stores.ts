import type { EalClient } from '@eal/client';
import { createShellStores, resetShellStores, type ShellStores } from './shell/stores.ts';
import {
  createTasksStores,
  resetTasksStores,
  type TasksStores,
} from './apps/tasks/stores.ts';
import {
  createDevicesStores,
  resetDevicesStores,
  type DevicesStores,
} from './apps/devices/stores.ts';
import {
  createFamilyPhoneStores,
  resetFamilyPhoneStores,
  type FamilyPhoneStores,
} from './apps/family-phone/stores.ts';
import {
  createAgentRulesStores,
  resetAgentRulesStores,
  type AgentRulesStores,
} from './apps/agent-rules/stores.ts';
import {
  createPstnContactsStores,
  resetPstnContactsStores,
  type PstnContactsStores,
} from './apps/pstn-contacts/stores.ts';

/**
 * The composed store bundle handed to every action handler — the shell's
 * global state plus each app's state, plus the live `EalClient`. Defined here,
 * at the composition root, because it spans the shell and the apps; the signals
 * themselves are owned by `shell/stores.ts` and each app's `stores.ts`.
 */
import type { TaskOutbox } from './apps/tasks/outbox.ts';
import { createBrowserTaskOutbox } from './apps/tasks/outbox-idb.ts';

export interface AppStores
  extends ShellStores,
    TasksStores,
    DevicesStores,
    FamilyPhoneStores,
    AgentRulesStores,
    PstnContactsStores {
  client: EalClient;
  /** The capture outbox and the offline list copy — apps/tasks/outbox.ts. */
  outbox: TaskOutbox;
}

export function createStores(client: EalClient): AppStores {
  const shell = createShellStores();
  const tasks = createTasksStores();
  return {
    client,
    outbox: createBrowserTaskOutbox(client, { ...tasks, $currentUser: shell.$currentUser }),
    ...shell,
    ...tasks,
    ...createDevicesStores(),
    ...createFamilyPhoneStores(),
    ...createAgentRulesStores(),
    ...createPstnContactsStores(),
  };
}

/** Reset every store to its initial value — for test isolation. */
export function resetStoresForTest(): void {
  resetShellStores();
  resetTasksStores();
  resetDevicesStores();
  resetFamilyPhoneStores();
  resetAgentRulesStores();
  resetPstnContactsStores();
}
