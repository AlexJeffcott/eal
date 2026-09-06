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
import type { HouseholdMember, Task, TaskKind, TaskStatus } from '@eal/client';
import { $currentUser } from '../../shell/stores.ts';
import {
  $boardLane,
  $expandedTaskIds,
  $householdUsers,
  $quickAddTitle,
  $recentlyCompleted,
  $reminderState,
  $tasksById,
  $tasksError,
  $taskFilter,
  type ReminderState,
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
  type TaskLayout,
  type TaskView,
  TEXT_OPS,
  visibleFor,
} from './filter.ts';
import { BOARD_LANES, type Lane, lanesFor } from './board.ts';
import { ancestorsOf, type ChildIndex, indexChildren, progressOf } from './tree.ts';

/**
 * The presets, in the order the day runs: what came in, what is on today, what
 * is actually startable, everything, and the bin.
 *
 * "Next" and not "Available": both name the same set, and "Next" is the word
 * the question is asked in — "what do I do next". It is also four characters
 * against nine, which is what keeps the row to two lines at the 350px floor:
 * measured there, the five presets wrap after "All", leaving "Trash" alone on
 * the second line. The row wraps rather than overflows because it is a Cluster
 * (see below); the e2e floor case measures the document either way.
 */
const VIEW_OPTIONS: ReadonlyArray<{ value: TaskView; label: string }> = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'today', label: 'Today' },
  { value: 'next', label: 'Next' },
  { value: 'all', label: 'All' },
  { value: 'trash', label: 'Trash' },
];

/** Three fixed levels, offered in outer-to-inner order — the level picker. */
const LEVEL_OPTIONS: ReadonlyArray<{ value: TaskKind; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'epic', label: 'Epic' },
  { value: 'task', label: 'Task' },
];

const LAYOUT_OPTIONS: ReadonlyArray<{ value: TaskLayout; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'board', label: 'Board' },
];

/**
 * How a container hands out the work filed inside it. Offered on a container
 * only — the flag governs children and a leaf has none, the same rule stage 1
 * applied to "+ Add a subtask" and stage 2 to the trashed card's lane picker.
 */
const ORDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'parallel', label: 'Parallel' },
  { value: 'sequential', label: 'Sequential' },
];

/** The lane picker's options — the same four lanes, in the same order. */
const STATUS_PICKER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = BOARD_LANES.map(
  (lane) => ({ value: lane.status, label: lane.label }),
);

/**
 * The word a row wears when its state is worth saying. `todo` is the resting
 * state every task starts in, so badging it would put a badge on nearly every
 * row and say nothing; `done` already shows as a struck-through title and a
 * ticked box. What is left is the pair the household actually asked for.
 */
function statusBadge(status: TaskStatus): string | null {
  if (status === 'doing') return 'doing';
  if (status === 'blocked') return 'blocked';
  return null;
}

/** The lane picker, as it appears on a board card and in the detail editor. */
function StatusPicker({ task }: { task: Task }) {
  return (
    <span data-task-status-picker>
      <ActionSelect
        value={task.status}
        options={[...STATUS_PICKER_OPTIONS]}
        action="tasks:set-status"
        actionData={{ taskId: String(task.id) }}
      />
    </span>
  );
}

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
          {/* Level leads: it is what the row *is*, and promoting a captured
            * task to a project is the move that makes the field below it
            * appear. The picker offers all three levels whatever the row's
            * parent — the server names the reason a move is refused, and that
            * reason is more use than a greyed-out option. */}
          <FilterField label="Level">
            <span data-task-level>
              <ActionSelect
                value={task.kind}
                options={LEVEL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                action="tasks:set-kind"
                actionData={{ taskId }}
              />
            </span>
          </FilterField>
          {/* The workflow axis, reachable without leaving the list. The board
            * is the same picker arranged as lanes; someone who never opens it
            * still needs to be able to say "started" or "stuck". */}
          <FilterField label="Status">
            <StatusPicker task={task} />
          </FilterField>
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
            <span data-task-assignee-picker>
              <ActionSelect
                value={task.assignedTo === null ? '' : String(task.assignedTo)}
                options={[
                  { value: '', label: 'Unassigned' },
                  ...users.map((u) => ({ value: String(u.id), label: u.displayName })),
                ]}
                action="tasks:edit-assignee"
                actionData={{ taskId }}
              />
            </span>
          </FilterField>
          {/* Both of these belong to a container and only a container: a task's
            * allowed parents are none, a project or an epic, so a plain task can
            * never hold anything. The subtask field would offer a move the
            * server refuses every time, and the order picker would set a flag
            * governing children that cannot exist. The Level picker above is
            * the way to earn both. Sequential is what makes the Next view show
            * one step instead of all of them. */}
          {task.kind === 'task' ? null : (
            <>
              <FilterField label="Order">
                <span data-task-order-picker>
                  <ActionSelect
                    value={task.sequential ? 'sequential' : 'parallel'}
                    options={[...ORDER_OPTIONS]}
                    action="tasks:set-sequential"
                    actionData={{ taskId }}
                  />
                </span>
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
            </>
          )}
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
  // A container is a project or an epic — the two levels that can hold
  // anything, and so the two that are worth standing inside.
  const container = task.kind !== 'task';
  // Which of the four states this row wears as a word. `null` for the two that
  // are already legible without one — see statusBadge.
  const state = statusBadge(task.status);
  const hasBadges =
    container ||
    state !== null ||
    parent !== undefined ||
    progress.total > 0 ||
    task.assignedTo !== null ||
    due !== null;
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
              {/* The state leads the badge line. "Everything is open and
                * nothing distinguishes started from not-started from blocked"
                * was the complaint the whole stage exists to answer, so the
                * answer goes first and is coloured: blocked reads as a warning
                * because it is one — something is waiting on a person. */}
              {state === null ? null : (
                <span data-task-state>
                  <Badge variant={task.status === 'blocked' ? 'warning' : 'info'}>{state}</Badge>
                </span>
              )}
              {/* The level is named on the row, not only in the editor: a
                * project and a task look identical otherwise, and the rule
                * about what may hold what is the level's rule. */}
              {container ? (
                <span data-task-kind>
                  <Badge variant="default">{task.kind}</Badge>
                </span>
              ) : null}
              {/* Why is only one step of this project in Next? Because this row
                * says so. Without the badge the rule is invisible and the view
                * reads as losing tasks rather than ordering them. Only shown
                * when the flag is on — parallel is the default, and badging it
                * would put a word on every container meaning "nothing unusual",
                * crowding out the ones that mean something. */}
              {container && task.sequential ? (
                <span data-task-sequential>
                  <Badge variant="default">sequential</Badge>
                </span>
              ) : null}
              {/* Standing inside a container. Not offered on a trashed row —
                * there is nothing to enter but more trash, and Trash already
                * lists it flat. */}
              {container && !trashed ? (
                <Button
                  tier="tertiary"
                  size="small"
                  data-action="tasks:enter-scope"
                  data-action-task-id={String(task.id)}
                  aria-label={`Open ${task.title}`}
                  label="Open"
                />
              ) : null}
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

/**
 * One card. Deliberately thinner than a list row: on a phone the board shows
 * one lane filling the screen, and a card that repeated every badge would fit
 * two to a screen. What survives is the title, where it is filed, when it is
 * due, and the control that moves it — which is the whole point of the board.
 */
function BoardCard({
  task,
  tasksById,
}: {
  task: Task;
  tasksById: ReadonlyMap<number, Task>;
}) {
  const parent = task.parentId === null ? undefined : tasksById.get(task.parentId);
  const due = task.dueAt === null ? null : dateValue(task.dueAt);
  const trashed = task.deletedAt !== null;
  return (
    <div data-board-card data-task-id={String(task.id)} data-task-status={task.status}>
      <Layout gap="var(--polly-space-xs)">
        {/* The title is text here, not a control. The list row opens an inline
          * editor on tap; a card cannot, because at 1200px a lane is about
          * 250px wide and the editor's two-column date row does not fit one. A
          * title that looked tappable and did nothing would be worse than one
          * that does not. Editing is the list's job, one tap away on the
          * switch above. */}
        <span
          data-task-title
          class={task.status === 'done' ? 'tasks-title tasks-title--done eal-muted' : 'tasks-title'}
        >
          {task.title}
        </span>
        <Cluster gap="var(--polly-space-xs)">
          {parent === undefined ? null : (
            <span data-task-parent>
              <Badge variant="default">
                {'in '}
                <span class="tasks-parent" title={parent.title}>
                  {parent.title}
                </span>
              </Badge>
            </span>
          )}
          {due === null ? null : (
            <span data-task-due>
              <Badge variant="default">{due}</Badge>
            </span>
          )}
        </Cluster>
        {/* Moving the card. A picker, not a drag: a drag needs a pointer that
          * can hover, and this board is used from a phone first. One tap opens
          * it, a second lands the card.
          *
          * A trashed card gets Restore instead. Trash is a view over the same
          * tree, so the board renders it too — but a lane move on a trashed row
          * is a 404 every time, and the same rule stage 1 applied to the
          * subtask field applies here: no button beats a button that always
          * fails. */}
        {trashed ? (
          <Button
            tier="tertiary"
            size="small"
            data-action="tasks:restore"
            data-action-task-id={String(task.id)}
            label="Restore"
          />
        ) : (
          <StatusPicker task={task} />
        )}
      </Layout>
    </div>
  );
}

function BoardLane({
  lane,
  tasksById,
}: {
  lane: Lane;
  tasksById: ReadonlyMap<number, Task>;
}) {
  return (
    <section data-board-lane-column data-lane={lane.status} class="tasks-lane">
      <Surface variant="sunken" padding="var(--polly-space-sm)">
        <Layout gap="var(--polly-space-sm)">
          <Cluster gap="var(--polly-space-xs)">
            <Text size="sm" weight="bold">{lane.label}</Text>
            <span data-board-lane-count>
              <Badge variant="default">{String(lane.tasks.length)}</Badge>
            </span>
          </Cluster>
          {lane.tasks.length === 0 ? (
            <p data-board-lane-empty>
              <Text size="sm" tone="muted">Nothing in this lane.</Text>
            </p>
          ) : (
            <Layout gap="var(--polly-space-xs)">
              {lane.tasks.map((task) => (
                <BoardCard key={task.id} task={task} tasksById={tasksById} />
              ))}
            </Layout>
          )}
        </Layout>
      </Surface>
    </section>
  );
}

/**
 * The board.
 *
 * Every lane is in the DOM at every width; which of them you can see is a media
 * query in tasks.css, not a width measured here. Four lanes at the 350px floor
 * would be about 80px each, which fits neither a title nor a thumb, so below
 * 900px the stylesheet shows one and the arrows below page between them.
 *
 * Rows come from `visibleFor`, the same call the list makes — the board is an
 * arrangement, not a second query.
 */
function TaskBoard({
  visible,
  tasksById,
  lane,
}: {
  visible: readonly Task[];
  tasksById: ReadonlyMap<number, Task>;
  lane: TaskStatus;
}) {
  const lanes = lanesFor(visible);
  const current = lanes.find((l) => l.status === lane);
  return (
    <div data-tasks-board data-board-lane={lane}>
      <Layout gap="var(--polly-space-sm)">
        {/* The narrow-screen lane control. Hidden above 900px by the
          * stylesheet, where all four lanes are on screen together and paging
          * would be a control that does nothing visible. */}
        <div data-board-lane-picker>
          <Layout columns="auto minmax(0, 1fr) auto" gap="var(--polly-space-sm)" alignItems="center">
            <Button
              tier="tertiary"
              size="small"
              data-action="tasks:board-lane-step"
              data-action-step="prev"
              aria-label="Previous lane"
              label={'\u25C2'}
            />
            <span data-board-lane-name class="tasks-lane-name">
              <Text size="sm">
                {current === undefined ? lane : `${current.label} · ${current.tasks.length}`}
              </Text>
            </span>
            <Button
              tier="tertiary"
              size="small"
              data-action="tasks:board-lane-step"
              data-action-step="next"
              aria-label="Next lane"
              label={'\u25B8'}
            />
          </Layout>
        </div>
        <div class="tasks-board-lanes">
          {lanes.map((l) => (
            <BoardLane key={l.status} lane={l} tasksById={tasksById} />
          ))}
        </div>
      </Layout>
    </div>
  );
}

function emptyCopy(view: TaskView, refined: boolean, scoped: boolean): string {
  if (refined) return 'No tasks match these filters.';
  // Scoped and empty is its own sentence. "Nothing in the inbox" would be a
  // lie inside a project — and the inbox is unfiled capture, so it is the one
  // view a scope can never satisfy.
  if (scoped) return 'Nothing filed under this one yet.';
  switch (view) {
    case 'inbox':
      return 'Nothing in the inbox. Capture a thought above.';
    case 'today':
      return "Nothing on today's list. Either everything's deferred or you're done.";
    case 'next':
      // Three different reasons, and the person needs to know which, because
      // the fix differs: unblock something, wait for a defer date, or tick the
      // step above off.
      return 'Nothing is available. Everything left is blocked, deferred, or waiting on a step before it.';
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

/**
 * Where you are, and the way back out. The trail is built from the mirror's
 * own parent links, so an epic scope shows the project above it and each crumb
 * is itself a scope to enter.
 *
 * A scope naming a row this mirror has not seen renders as `#<id>` rather than
 * a guessed name: the list is empty and saying so honestly beats inventing a
 * title. The leave button is present either way, so the state is never a trap.
 */
function Breadcrumb(props: { scope: number; tasksById: ReadonlyMap<number, Task> }) {
  const container = props.tasksById.get(props.scope);
  const trail = ancestorsOf(props.tasksById, props.scope);
  return (
    <div data-tasks-breadcrumb>
      <Cluster gap="var(--polly-space-xs)">
        <Button
          tier="tertiary"
          size="small"
          data-action="tasks:leave-scope"
          label="All tasks"
        />
        {/* The separator travels with the crumb it precedes, so a wrap breaks
          * between crumbs and never leaves an arrow stranded at a line start. */}
        {trail.map((crumb) => (
          <span key={crumb.id} class="tasks-crumb">
            <Text tone="muted" aria-hidden>{'\u25B8 '}</Text>
            <Button
              tier="tertiary"
              size="small"
              data-action="tasks:enter-scope"
              data-action-task-id={String(crumb.id)}
              label={crumb.title}
            />
          </span>
        ))}
        <span class="tasks-crumb">
          <Text tone="muted" aria-hidden>{'\u25B8 '}</Text>
          <span data-tasks-scope class="tasks-crumb-current">
            <Text>{container === undefined ? `#${props.scope}` : container.title}</Text>
          </span>
        </span>
      </Cluster>
    </div>
  );
}

/**
 * Reminders — the control that decides whether a deadline reaches the phone.
 *
 * It sits at the top of the panel rather than on each task, because the
 * permission it asks for is per browser, not per task: granting it once arms
 * every deadline the household has. It renders nothing at all on a browser with
 * no PushManager, which is the honest answer there — no button in eal can make
 * that browser buzz.
 *
 * The label is the state, not an instruction. "Reminders on" tells you where
 * you stand and doubles as the way back off; "Remind me" is the only wording
 * that reads as an offer rather than a setting.
 */
function ReminderControl({ state }: { state: ReminderState }) {
  if (state === 'unsupported') return null;
  return (
    <div data-tasks-reminders data-reminder-state={state}>
      <Cluster gap="var(--polly-space-xs)">
        {state === 'denied' ? (
          <Text size="sm" tone="muted">
            Notifications are blocked for this site. Your browser&apos;s site settings are
            the only way back.
          </Text>
        ) : state === 'on' ? (
          <Button
            tier="tertiary"
            size="small"
            label="Reminders on"
            data-action="tasks:disable-reminders"
          />
        ) : (
          <Button
            tier="tertiary"
            size="small"
            label={state === 'working' ? 'Just a moment…' : 'Remind me'}
            data-action="tasks:enable-reminders"
          />
        )}
      </Cluster>
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
  const boardLane = $boardLane.value;
  const users = $householdUsers.value;
  const reminders = $reminderState.value;

  const now = new Date();
  const index = indexChildren(tasks);
  const visible = visibleFor(filter, tasks, recentlyCompleted, { now });
  // The denominator for the live count — how many rows the view holds before
  // any conditions narrow it.
  const viewTotal = visibleFor(
    { view: filter.view, scope: filter.scope, layout: filter.layout, conditions: [] },
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
        {/* Preset scope — one tap, the common case.
          *
          * A wrapping Cluster, not the fixed `auto`-per-view grid this row used
          * to be. A grid track per view cannot wrap, so the fifth preset would
          * push the document sideways at the 350px floor rather than dropping
          * onto a second line; the e2e floor case measures exactly that. */}
        <div data-tasks-view-switch>
          <Cluster gap="var(--polly-space-xs)">
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
          </Cluster>
        </div>

        {/* List or board — a second row rather than two more buttons on the
          * view row, because at 350px six buttons on one line wrap into a
          * shape where the view and the layout are no longer distinguishable
          * as two separate questions. */}
        <div data-tasks-layout-switch>
          <Cluster gap="var(--polly-space-xs)">
            {LAYOUT_OPTIONS.map((l) => (
              <Button
                key={l.value}
                tier={l.value === filter.layout ? 'primary' : 'tertiary'}
                size="small"
                label={l.label}
                data-action="tasks:set-layout"
                data-action-layout={l.value}
              />
            ))}
          </Cluster>
        </div>

        <ReminderControl state={reminders} />

        {filter.scope === null ? null : (
          <Breadcrumb scope={filter.scope} tasksById={tasks} />
        )}

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
                placeholder={
                  filter.scope === null
                    ? 'Add a task and press Enter'
                    : 'Add a task in here and press Enter'
                }
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

        {/* The board renders its four lanes even when every one is empty: the
          * lanes are the answer to "what is blocked", and an empty Blocked lane
          * says "nothing" where a missing one would say "not a thing here". The
          * list keeps its sentence, which has nowhere else to live. */}
        {filter.layout === 'board' ? (
          <TaskBoard visible={visible} tasksById={tasks} lane={boardLane} />
        ) : visible.length === 0 ? (
          <p data-tasks-empty>
            <Text tone="muted">{emptyCopy(filter.view, refined, filter.scope !== null)}</Text>
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
