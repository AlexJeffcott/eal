import { agentApp } from './agent.ts';
import { familyPhoneApp } from './family-phone.ts';
import { pushApp } from './push.ts';
import { tasksApp } from './tasks.ts';
import type { ApiApp } from './types.ts';

/**
 * Every installed API app. server-factory composes their routes and schema;
 * `applySchema` appends each app's tables. Add an app by adding it here.
 *
 * Order matters for schema FK targets: `agentApp` references
 * `family_phone_devices(id)`, so it must come after `familyPhoneApp`.
 * `pushApp` references only the global `users` table, so it may sit anywhere
 * after the global schema — which every app fragment does.
 */
export const API_APPS: readonly ApiApp[] = [tasksApp, familyPhoneApp, agentApp, pushApp];
