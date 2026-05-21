import { $state } from '@fairfox/polly/state';
import type { HouseholdMember, Task } from '@eal/client';
import { freshFilter, type TaskFilter } from './filter.ts';

/** Reactive state owned by the tasks app. */

/**
 * The canonical local mirror of the server's task set. Mutations flow through
 * action handlers that apply optimistic updates, then the server's broadcast
 * overwrites the local entry — last broadcast wins.
 */
export const $tasksById = $state<Map<number, Task>>(new Map());
export const $tasksError = $state<string | null>(null);
/** Drives the quick-add input at the top of every view. */
export const $quickAddTitle = $state<string>('');

/**
 * The composable filter. Source of truth is the URL query string; this signal
 * mirrors it (see url-sync.ts). Components render `visibleFor($taskFilter)`.
 */
export const $taskFilter = $state<TaskFilter>(freshFilter());
/**
 * Tasks the user has ticked since the last navigation. They linger in the
 * list — visible with a strike-through — instead of vanishing the instant
 * they're completed. Cleared whenever the filter changes.
 */
export const $recentlyCompleted = $state<Set<number>>(new Set());
/** Tasks whose inline detail editor is open. A set so a parent and a nested
 *  subtask can both be expanded at once. */
export const $expandedTaskIds = $state<Set<number>>(new Set());
/** The household roster — populates the assignee picker in the task editor. */
export const $householdUsers = $state<HouseholdMember[]>([]);

export interface TasksStores {
  $tasksById: typeof $tasksById;
  $tasksError: typeof $tasksError;
  $quickAddTitle: typeof $quickAddTitle;
  $taskFilter: typeof $taskFilter;
  $recentlyCompleted: typeof $recentlyCompleted;
  $expandedTaskIds: typeof $expandedTaskIds;
  $householdUsers: typeof $householdUsers;
}

export function createTasksStores(): TasksStores {
  return {
    $tasksById,
    $tasksError,
    $quickAddTitle,
    $taskFilter,
    $recentlyCompleted,
    $expandedTaskIds,
    $householdUsers,
  };
}

export function resetTasksStores(): void {
  $tasksById.value = new Map();
  $tasksError.value = null;
  $quickAddTitle.value = '';
  $taskFilter.value = freshFilter();
  $recentlyCompleted.value = new Set();
  $expandedTaskIds.value = new Set();
  $householdUsers.value = [];
}
