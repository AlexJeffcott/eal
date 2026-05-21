import { tasksApp } from './tasks.ts';
import type { ApiApp } from './types.ts';

/**
 * Every installed API app. server-factory composes their routes and schema;
 * `applySchema` appends each app's tables. Add an app by adding it here.
 */
export const API_APPS: readonly ApiApp[] = [tasksApp];
