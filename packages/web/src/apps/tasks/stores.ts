import { $state } from '@fairfox/polly/state';
import type { HouseholdMember, Task, TaskStatus } from '@eal/client';
import { freshFilter, type TaskFilter } from './filter.ts';
import type { OutboxEntry } from './outbox.ts';

/** Reactive state owned by the tasks app. */

/**
 * The canonical local mirror of the server's task set. Mutations flow through
 * action handlers that apply optimistic updates, then the server's broadcast
 * overwrites the local entry — last broadcast wins.
 */
export const $tasksById = $state<Map<number, Task>>(new Map());
export const $tasksError = $state<string | null>(null);
/**
 * Captures the server has not confirmed yet, oldest first — see outbox.ts.
 * Deliberately NOT in `$tasksById`: an entry has no server id, so nothing that
 * acts on a task by id (toggle, edit, delete, move) can be pointed at one.
 */
export const $outbox = $state<OutboxEntry[]>([]);
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
/**
 * Which board lane a narrow screen is showing. Not part of `TaskFilter` and so
 * not in the URL: it is where you are looking, like `$expandedTaskIds`, not
 * what you asked for. Above 900px the board shows all four lanes and this is
 * ignored — by the stylesheet, not by a width read in JavaScript.
 */
export const $boardLane = $state<TaskStatus>('todo');
/** The household roster — populates the assignee picker in the task editor. */
export const $householdUsers = $state<HouseholdMember[]>([]);

/**
 * Whether this browser will buzz when a deadline passes.
 *
 * Five states rather than a boolean, because "off" and "denied" need different
 * words: `off` is a tap away, `denied` is only reachable through the browser's
 * own site settings and no button in eal can undo it. `unsupported` hides the
 * control entirely — a browser with no PushManager will never have one — and
 * `working` covers the permission prompt and the vendor round-trip, which on a
 * cold service worker takes long enough to look stuck.
 */
export type ReminderState = 'unsupported' | 'off' | 'working' | 'on' | 'denied';
export const $reminderState = $state<ReminderState>('off');

export interface TasksStores {
  $tasksById: typeof $tasksById;
  $tasksError: typeof $tasksError;
  $outbox: typeof $outbox;
  $quickAddTitle: typeof $quickAddTitle;
  $taskFilter: typeof $taskFilter;
  $recentlyCompleted: typeof $recentlyCompleted;
  $expandedTaskIds: typeof $expandedTaskIds;
  $boardLane: typeof $boardLane;
  $householdUsers: typeof $householdUsers;
  $reminderState: typeof $reminderState;
}

export function createTasksStores(): TasksStores {
  return {
    $tasksById,
    $tasksError,
    $outbox,
    $quickAddTitle,
    $taskFilter,
    $recentlyCompleted,
    $expandedTaskIds,
    $boardLane,
    $householdUsers,
    $reminderState,
  };
}

export function resetTasksStores(): void {
  $tasksById.value = new Map();
  $tasksError.value = null;
  $outbox.value = [];
  $quickAddTitle.value = '';
  $taskFilter.value = freshFilter();
  $recentlyCompleted.value = new Set();
  $expandedTaskIds.value = new Set();
  $boardLane.value = 'todo';
  $householdUsers.value = [];
  $reminderState.value = 'off';
}
