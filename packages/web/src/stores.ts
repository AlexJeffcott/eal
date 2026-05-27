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

/**
 * The composed store bundle handed to every action handler — the shell's
 * global state plus each app's state, plus the live `EalClient`. Defined here,
 * at the composition root, because it spans the shell and the apps; the signals
 * themselves are owned by `shell/stores.ts` and each app's `stores.ts`.
 */
export interface AppStores
  extends ShellStores, TasksStores, DevicesStores, FamilyPhoneStores, AgentRulesStores {
  client: EalClient;
}

export function createStores(client: EalClient): AppStores {
  return {
    client,
    ...createShellStores(),
    ...createTasksStores(),
    ...createDevicesStores(),
    ...createFamilyPhoneStores(),
    ...createAgentRulesStores(),
  };
}

/** Reset every store to its initial value — for test isolation. */
export function resetStoresForTest(): void {
  resetShellStores();
  resetTasksStores();
  resetDevicesStores();
  resetFamilyPhoneStores();
  resetAgentRulesStores();
}
