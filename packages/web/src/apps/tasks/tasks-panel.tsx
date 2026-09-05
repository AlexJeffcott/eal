import {
  ActionInput,
  ActionSelect,
  Badge,
  Button,
  Cluster,
  Layout,
  Surface,
  Text,
  TextInput,
} from '@fairfox/polly/ui';
import type { HouseholdMember, Task } from '@eal/client';
import { $currentUser } from '../../shell/stores.ts';
import {
  $expandedTaskIds,
  $householdUsers,
  $quickAddTitle,
  $recentlyCompleted,
  $tasksById,
  $tasksError,
  $taskFilter,
} from './stores.ts';
import {
  type Condition,
  type ConditionField,
  DATE_OPS,
  FILTER_FIELDS,
  hasActiveRefinements,
  type SelectOptionSpec,
  STATUS_OPTIONS,
  SUBTASK_OPTIONS,
  type TaskView,
  TEXT_OPS,
  visibleFor,
} from './filter.ts';
import { type ChildIndex, indexChildren, progressOf } from './tree.ts';

const VIEW_OPTIONS: ReadonlyArray<{ value: TaskView; label: string }> = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'today', label: 'Today' },
  { value: 'all', label: 'All' },
  { value: 'trash', label: 'Trash' },
];

function FilterField(props: { label: string; children: preact.ComponentChildren }) {
  return (
    <Layout gap="var(--polly-space-xs)">
      <Text size="xs" tone="muted">{props.label}</Text>
      {props.children}
    </Layout>
  );
}

/** ISO timestamp → the `YYYY-MM-DD` a native date input expects. */
function dateValue(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10);
}

function memberName(users: readonly HouseholdMember[], id: number): string {
  return users.find((u) => u.id === id)?.displayName ?? `user ${id}`;
}

interface TaskRowProps {
  task: Task;
  tasksById: ReadonlyMap<number, Task>;
  index: ChildIndex;
  expandedIds: ReadonlySet<number>;
  users: readonly HouseholdMember[];
}

interface TaskDetailProps {
  task: Task;
  users: readonly HouseholdMember[];
}

/** The inline detail editor — every field commits the moment it changes.
 *  Subtasks are not listed here. The main list carries them in tree order,
 *  directly beneath this task, so a task has exactly one row on screen. */
function TaskDetail({ task, users }: TaskDetailProps) {
  const taskId = String(task.id);
  return (
    <div data-task-detail class="tasks-detail">
      <Surface variant="callout" padding="var(--polly-space-md)">
        <Layout gap="var(--polly-space-md)">
          <FilterField label="Notes">
            <ActionInput
              variant="multi"
              saveOn="blur"
              value={task.notes}
              action="tasks:edit-notes"
              actionData={{ taskId }}
              placeholder="Add notes…"
              ariaLabel="Task notes"
            />
          </FilterField>
          <Layout columns="1fr 1fr" gap="var(--polly-space-md)" stackOnMobile>
            <FilterField label="Due">
              <ActionInput
                inputType="date"
                saveOn="blur"
                value={dateValue(task.dueAt)}
                action="tasks:edit-due"
                actionData={{ taskId }}
                ariaLabel="Due date"
              />
            </FilterField>
            <FilterField label="Hide until">
              <ActionInput
                inputType="date"
                saveOn="blur"
                value={dateValue(task.deferUntil)}
                action="tasks:edit-defer"
                actionData={{ taskId }}
                ariaLabel="Hide until date"
              />
            </FilterField>
          </Layout>
          <FilterField label="Assignee">
            <ActionSelect
              value={task.assignedTo === null ? '' : String(task.assignedTo)}
              options={[
                { value: '', label: 'Unassigned' },
                ...users.map((u) => ({ value: String(u.id), label: u.displayName })),
              ]}
              action="tasks:edit-assignee"
              actionData={{ taskId }}
            />
          </FilterField>
          <FilterField label="Subtasks">
            <ActionInput
              value=""
              action="tasks:add-subtask"
              actionData={{ taskId }}
              saveOn="enter"
              ariaLabel="Add a subtask"
              renderView={() => '+ Add a subtask'}
            />
          </FilterField>
        </Layout>
      </Surface>
    </div>
  );
}

function TaskRow({ task, tasksById, index, expandedIds, users }: TaskRowProps) {
  const done = task.status === 'done';
  const trashed = task.deletedAt !== null;
  const expanded = expandedIds.has(task.id);
  const due = task.dueAt === null ? null : dateValue(task.dueAt);
  const progress = progressOf(index, task.id);
  // The container badge. `undefined` covers both a root task and one whose
  // parent has not reached this mirror yet — neither gets a badge, and neither
  // is named with a placeholder.
  const parent = task.parentId === null ? undefined : tasksById.get(task.parentId);
  const hasBadges =
    parent !== undefined || progress.total > 0 || task.assignedTo !== null || due !== null;
  let titleClass = 'tasks-title';
  if (done) titleClass += ' tasks-title--done';
  if (done || trashed) titleClass += ' eal-muted';
  return (
    <div data-task-row data-task-id={String(task.id)} data-task-status={task.status}>
      {/* `minmax(0, 1fr)` lets the title column shrink below its content so long
       *  titles wrap instead of forcing horizontal overflow at 350px. */}
      <Layout columns="auto minmax(0, 1fr) auto" gap="var(--polly-space-sm)" alignItems="start">
        {trashed ? (
          <Button
            tier="tertiary"
            size="small"
            data-action="tasks:restore"
            data-action-task-id={String(task.id)}
            label="Restore"
          />
        ) : (
          <Button
            tier="tertiary"
            size="small"
            data-action="tasks:toggle"
            data-action-task-id={String(task.id)}
            aria-label={done ? 'Reopen task' : 'Complete task'}
            label={done ? '☑' : '☐'}
          />
        )}
        <Layout gap="var(--polly-space-xs)">
          <span
            data-action={trashed ? undefined : 'tasks:expand'}
            data-action-task-id={String(task.id)}
            class={trashed ? undefined : 'eal-clickable'}
          >
            {trashed ? null : (
              <Text tone="muted" aria-hidden>
                {expanded ? '▾ ' : '▸ '}
              </Text>
            )}
            <span data-task-title class={titleClass}>
              {task.title}
            </span>
          </span>
          {/* Badges wrap — at 350px they flow onto a second line rather than
           *  squeezing the title or overflowing the row. */}
          {hasBadges ? (
            <Cluster gap="var(--polly-space-xs)">
              {parent !== undefined ? (
                <span data-task-parent>
                  <Badge variant="default">
                    {'in '}
                    <span class="tasks-parent" title={parent.title}>
                      {parent.title}
                    </span>
                  </Badge>
                </span>
              ) : null}
              {progress.total > 0 ? (
                <span data-task-progress>
                  <Badge variant="default">{`${progress.done}/${progress.total}`}</Badge>
                </span>
              ) : null}
              {task.assignedTo !== null ? (
                <span data-task-assignee>
                  <Badge variant="info">{memberName(users, task.assignedTo)}</Badge>
                </span>
              ) : null}
              {due !== null ? (
                <span data-task-due>
                  <Badge variant="default">{due}</Badge>
                </span>
              ) : null}
            </Cluster>
          ) : null}
        </Layout>
        {trashed ? null : (
          <Button
            tier="tertiary"
            size="small"
            data-action="tasks:delete"
            data-action-task-id={String(task.id)}
            aria-label="Move to trash"
            label="✕"
          />
        )}
      </Layout>
      {expanded && !trashed ? <TaskDetail task={task} users={users} /> : null}
    </div>
  );
}

function emptyCopy(view: TaskView, refined: boolean): string {
  if (refined) return 'No tasks match these filters.';
  switch (view) {
    case 'inbox':
      return 'Nothing in the inbox. Capture a thought above.';
    case 'today':
      return "Nothing on today's list. Either everything's deferred or you're done.";
    case 'trash':
      return 'Trash is empty.';
    case 'all':
      return 'No tasks yet.';
  }
}

function fieldLabel(field: ConditionField): string {
  return FILTER_FIELDS.find((f) => f.field === field)?.label ?? field;
}

/** The value control(s) for one filter condition — shape varies by kind. */
function ConditionValue(props: {
  condition: Condition;
  users: readonly HouseholdMember[];
  currentUserId: number | null;
}) {
  const { condition } = props;

  if (condition.kind === 'select') {
    const options: SelectOptionSpec[] =
      condition.field === 'status'
        ? [...STATUS_OPTIONS]
        : condition.field === 'subtasks'
          ? [...SUBTASK_OPTIONS]
          : [
              ...props.users.map((u) => ({
                value: String(u.id),
                label: u.id === props.currentUserId ? `${u.displayName} (me)` : u.displayName,
              })),
              { value: 'unassigned', label: 'Unassigned' },
            ];
    return (
      <Cluster gap="var(--polly-space-xs)">
        {options.map((opt) => (
          <Button
            key={opt.value}
            size="small"
            tier={condition.values.includes(opt.value) ? 'primary' : 'tertiary'}
            label={opt.label}
            data-action="tasks:toggle-condition-value"
            data-action-condition-id={condition.id}
            data-action-value={opt.value}
          />
        ))}
      </Cluster>
    );
  }

  if (condition.kind === 'date') {
    return (
      <Layout columns="auto minmax(0, 1fr)" gap="var(--polly-space-xs)" alignItems="center">
        <ActionSelect
          value={condition.op}
          options={DATE_OPS.map((op) => ({ value: op, label: op }))}
          action="tasks:set-condition-op"
          actionData={{ conditionId: condition.id }}
        />
        <ActionInput
          inputType="date"
          saveOn="input"
          value={condition.date}
          action="tasks:set-condition-date"
          actionData={{ conditionId: condition.id }}
          ariaLabel="Filter date"
        />
      </Layout>
    );
  }

  return (
    <Layout columns="auto minmax(0, 1fr)" gap="var(--polly-space-xs)" alignItems="center">
      <ActionSelect
        value={condition.op}
        options={TEXT_OPS.map((op) => ({ value: op, label: op }))}
        action="tasks:set-condition-text-op"
        actionData={{ conditionId: condition.id }}
      />
      <ActionInput
        saveOn="input"
        value={condition.query}
        action="tasks:set-condition-text"
        actionData={{ conditionId: condition.id }}
        placeholder="Search title and notes"
        ariaLabel="Filter text"
      />
    </Layout>
  );
}

/** One row of the filter builder: a field label, its value control, remove. */
function ConditionRow(props: {
  condition: Condition;
  users: readonly HouseholdMember[];
  currentUserId: number | null;
}) {
  const { condition } = props;
  return (
    <div data-condition-row data-condition-field={condition.field}>
      <Layout columns="auto minmax(0, 1fr) auto" gap="var(--polly-space-sm)" alignItems="center">
        <Text size="sm" tone="muted">{fieldLabel(condition.field)}</Text>
        <ConditionValue
          condition={condition}
          users={props.users}
          currentUserId={props.currentUserId}
        />
        <Button
          tier="tertiary"
          size="small"
          data-action="tasks:remove-condition"
          data-action-condition-id={condition.id}
          aria-label="Remove filter"
          label="✕"
        />
      </Layout>
    </div>
  );
}

export function TasksPanel() {
  const filter = $taskFilter.value;
  const tasks = $tasksById.value;
  const error = $tasksError.value;
  const user = $currentUser.value;
  const recentlyCompleted = $recentlyCompleted.value;
  const expandedIds = $expandedTaskIds.value;
  const users = $householdUsers.value;

  const now = new Date();
  const index = indexChildren(tasks);
  const visible = visibleFor(filter, tasks, recentlyCompleted, { now });
  // The denominator for the live count — how many rows the view holds before
  // any conditions narrow it.
  const viewTotal = visibleFor(
    { view: filter.view, conditions: [] },
    tasks,
    recentlyCompleted,
    { now },
  ).length;
  const refined = hasActiveRefinements(filter);

  return (
    <Surface
      variant="raised"
      padding="clamp(var(--polly-space-sm), 3vw, var(--polly-space-xl))"
      data-tasks-panel
    >
      <Layout gap="var(--polly-space-md)">
        {/* Preset scope — one tap, the common case */}
        <Layout
          columns={VIEW_OPTIONS.map(() => 'auto').join(' ')}
          gap="var(--polly-space-xs)"
          justifyContent="start"
        >
          {VIEW_OPTIONS.map((v) => (
            <Button
              key={v.value}
              tier={v.value === filter.view ? 'primary' : 'tertiary'}
              size="small"
              label={v.label}
              data-action="tasks:set-view"
              data-action-view={v.value}
            />
          ))}
        </Layout>

        {/* Composable condition builder — AND-ed refinements, instant-apply */}
        <div data-tasks-filter-bar>
          <Layout gap="var(--polly-space-sm)">
            {filter.conditions.map((c) => (
              <ConditionRow
                key={c.id}
                condition={c}
                users={users}
                currentUserId={user ? user.userId : null}
              />
            ))}
            <Cluster gap="var(--polly-space-xs)">
              <Text size="sm" tone="muted">Add filter:</Text>
              {FILTER_FIELDS.map((f) => (
                <Button
                  key={f.field}
                  tier="tertiary"
                  size="small"
                  label={f.label}
                  data-action="tasks:add-condition"
                  data-action-field={f.field}
                />
              ))}
            </Cluster>
            <Layout columns="1fr auto" gap="var(--polly-space-sm)" alignItems="center">
              <Text size="sm" tone="muted">{`${visible.length} of ${viewTotal}`}</Text>
              {refined ? (
                <Button
                  tier="tertiary"
                  size="small"
                  data-action="tasks:clear-filters"
                  label="Clear all"
                />
              ) : (
                <span />
              )}
            </Layout>
          </Layout>
        </div>

        {/* Quick capture — hidden in Trash, where adding makes no sense. */}
        {filter.view === 'trash' ? null : (
          <div data-tasks-quick-add-form>
            <Layout columns="1fr auto" gap="var(--polly-space-sm)" alignItems="center">
              <TextInput
                id="tasks-quick-add"
                name="title"
                value={$quickAddTitle}
                placeholder="Add a task and press Enter"
              />
              <Button tier="primary" color="info" data-action="tasks:quick-add" label="Add" />
            </Layout>
          </div>
        )}

        {error ? (
          <span data-tasks-error>
            <Badge variant="danger">{error}</Badge>
          </span>
        ) : null}

        {visible.length === 0 ? (
          <p data-tasks-empty>
            <Text tone="muted">{emptyCopy(filter.view, refined)}</Text>
          </p>
        ) : (
          <div data-tasks-list>
            <Layout gap="var(--polly-space-xs)">
              {visible.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  tasksById={tasks}
                  index={index}
                  expandedIds={expandedIds}
                  users={users}
                />
              ))}
            </Layout>
          </div>
        )}
      </Layout>
    </Surface>
  );
}
