import { test, expect } from '@playwright/test';
import { attachVirtualAuthenticator } from './lib/virtual-authenticator.ts';
import { expectSignedInAs, registerPasskey } from './lib/shell.ts';

/**
 * Tasks golden path — the workflow a person actually does, end to end, against
 * a real API and a real browser from cold state (`:memory:` DB, fresh keyring).
 * Registers a passkey, then drives capture → view-switch → edit → subtask →
 * complete entirely through the documented UI entry points.
 *
 * Every lookup is scoped to this test's own task: the e2e suite shares one
 * in-memory database across specs, so other specs' tasks may also be present.
 */
test('tasks golden path: register, capture, organise, complete', async ({ page }) => {
  await attachVirtualAuthenticator(page);

  await test.step('register a passkey and land in the shell', async () => {
    await page.goto('/');
    await registerPasskey(page, 'pat');
    await expectSignedInAs(page, 'pat');
  });

  await test.step('open the Tasks app from the landing launcher', async () => {
    await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
    await expect(page.locator('[data-tasks-panel]')).toBeVisible();
  });

  await test.step('quick-add a task — it lands in the inbox', async () => {
    await page.locator('#tasks-quick-add').fill('Buy groceries');
    await page.locator('[data-action="tasks:quick-add"]').click();
    await expect(page.locator('[data-task-title]', { hasText: 'Buy groceries' })).toBeVisible();
  });

  // The row that owns this test's task — matched by title so the assertions
  // hold regardless of other specs' rows in the shared database.
  const row = page.locator('[data-task-row]', {
    has: page.locator('[data-task-title]', { hasText: 'Buy groceries' }),
  });
  const taskId = await row.getAttribute('data-task-id');
  expect(taskId).not.toBeNull();

  // The subtask added below. It is a row of the main list in its own right —
  // every view but the inbox lists tasks at any depth.
  const subRow = page.locator('[data-task-row]', {
    has: page.locator('[data-task-title]', { hasText: 'Make a list' }),
  });

  await test.step('switch to the All view — the task stays visible', async () => {
    await page.locator('[data-action="tasks:set-view"][data-action-view="all"]').click();
    await expect(row).toBeVisible();
  });

  await test.step('expand the task and edit notes, due date, and assignee', async () => {
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${taskId}"]`).click();
    await expect(row.locator('[data-task-detail]')).toBeVisible();

    // Notes — an ActionInput: click the view to edit, type, blur to commit.
    await row.locator('div[aria-label="Task notes"]').click();
    const notes = row.locator('textarea[aria-label="Task notes"]');
    await notes.fill('Milk, eggs, bread');
    await notes.blur();

    // Due date — an ActionInput with a native date input, commits on blur.
    await row.locator('div[aria-label="Due date"]').click();
    const due = row.locator('input[aria-label="Due date"]');
    await due.fill('2026-07-01');
    await due.blur();
    await expect(row.locator('[data-task-due]')).toContainText('2026-07-01');

    // Assignee — an ActionSelect: open the dropdown, pick the option. Scoped
    // to its own wrapper: the Level picker above it is an ActionSelect too.
    const assignee = row.locator('[data-task-assignee-picker]');
    await assignee.getByRole('button').click();
    await assignee.getByRole('option', { name: 'pat' }).click();
    await expect(row.locator('[data-task-assignee]')).toContainText('pat');
  });

  await test.step('promote it to a project — that is what earns the subtask field', async () => {
    // A plain task's allowed parents are none, a project or an epic, so it can
    // never hold one. The Level picker is the documented way to change that,
    // and the field below appears only once it has.
    await expect(row.locator('div[aria-label="Add a subtask"]')).toHaveCount(0);
    const level = row.locator('[data-task-level]');
    await level.getByRole('button').click();
    await level.getByRole('option', { name: 'Project' }).click();
    await expect(row.locator('[data-task-kind]')).toContainText('project');
  });

  await test.step('add a subtask — it lists on its own and names its parent', async () => {
    // The subtask field is an ActionInput (commits on Enter).
    await row.locator('div[aria-label="Add a subtask"]').click();
    const subInput = row.locator('input[aria-label="Add a subtask"]');
    await subInput.fill('Make a list');
    await subInput.press('Enter');

    await expect(subRow).toBeVisible();
    await expect(subRow.locator('[data-task-parent]')).toContainText('Buy groceries');
    await expect(row.locator('[data-task-progress]')).toContainText('0/1');
  });

  await test.step('complete the subtask — the parent progress ticks to 1/1', async () => {
    const subtaskId = await subRow.getAttribute('data-task-id');
    expect(subtaskId).not.toBeNull();
    await page.locator(`[data-action="tasks:toggle"][data-action-task-id="${subtaskId}"]`).click();
    await expect(row.locator('[data-task-progress]')).toContainText('1/1');
  });

  await test.step('complete the parent task', async () => {
    await page.locator(`[data-action="tasks:toggle"][data-action-task-id="${taskId}"]`).click();
    await expect(row).toHaveAttribute('data-task-status', 'done');
  });

  // No field commit surfaced an error anywhere in the flow.
  await expect(page.locator('[data-tasks-error]')).toHaveCount(0);
});


/**
 * Filing, end to end: a project, an epic under it, tasks under both, scoping
 * in and back out by the breadcrumb, and a captured task promoted to a project.
 *
 * This is the workflow the level column exists for, driven through the real UI
 * against a real API from a cold `:memory:` database — a green unit tier proves
 * the rule, not that a person can reach it.
 *
 * Every title carries a per-run stamp: the e2e suite shares one in-memory
 * database across specs and both Playwright projects, so an unstamped title
 * would match another run's rows.
 */
test('tasks hierarchy: file a project, an epic and tasks, then scope in and out', async ({ page }) => {
  const stamp = `h${Date.now()}`;
  const PROJECT = `Renovate the kitchen ${stamp}`;
  const EPIC = `Tiling ${stamp}`;
  const UNDER_PROJECT = `Call the plumber ${stamp}`;
  const UNDER_EPIC = `Buy tiles ${stamp}`;
  const CAPTURED = `Fix the gate ${stamp}`;

  const rowFor = (title: string) =>
    page.locator('[data-task-row]', {
      has: page.locator('[data-task-title]', { hasText: title }),
    });

  /** Drive the Level ActionSelect on one row. */
  async function setLevel(title: string, level: 'Project' | 'Epic' | 'Task'): Promise<void> {
    const row = rowFor(title);
    const id = await row.getAttribute('data-task-id');
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${id}"]`).click();
    const picker = row.locator('[data-task-level]');
    await picker.getByRole('button').click();
    await picker.getByRole('option', { name: level }).click();
    await expect(row.locator('[data-task-kind]')).toContainText(level.toLowerCase());
    // Collapse again so the next row's controls are the only ones on screen.
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${id}"]`).click();
  }

  async function quickAdd(title: string): Promise<void> {
    await page.locator('#tasks-quick-add').fill(title);
    await page.locator('[data-action="tasks:quick-add"]').click();
    await expect(rowFor(title)).toBeVisible();
  }

  await attachVirtualAuthenticator(page);
  await page.goto('/');
  await registerPasskey(page, `filer-${stamp}`);
  await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
  await expect(page.locator('[data-tasks-panel]')).toBeVisible();

  await test.step('capture a task and promote it to a project', async () => {
    await quickAdd(PROJECT);
    await setLevel(PROJECT, 'Project');
  });

  await test.step('enter the project — the list shows what is inside it', async () => {
    await rowFor(PROJECT).locator('[data-action="tasks:enter-scope"]').click();
    await expect(page.locator('[data-tasks-breadcrumb]')).toBeVisible();
    await expect(page.locator('[data-tasks-scope]')).toContainText(PROJECT);
    // The container is not one of its own rows — the breadcrumb names it.
    await expect(rowFor(PROJECT)).toHaveCount(0);
  });

  await test.step('capture inside the project: an epic, and a task beside it', async () => {
    // Quick-add files into the container you are standing in.
    await quickAdd(EPIC);
    await setLevel(EPIC, 'Epic');
    await quickAdd(UNDER_PROJECT);
    await expect(rowFor(UNDER_PROJECT).locator('[data-task-parent]')).toContainText(PROJECT);
  });

  await test.step('enter the epic and put a task under it', async () => {
    await rowFor(EPIC).locator('[data-action="tasks:enter-scope"]').click();
    await expect(page.locator('[data-tasks-scope]')).toContainText(EPIC);
    await quickAdd(UNDER_EPIC);
    await expect(rowFor(UNDER_EPIC).locator('[data-task-parent]')).toContainText(EPIC);
    // Two levels deep, so the project above is a crumb of its own.
    const projectId = await page
      .locator('[data-tasks-breadcrumb] [data-action="tasks:enter-scope"]')
      .first()
      .getAttribute('data-action-task-id');
    expect(projectId).not.toBeNull();
  });

  await test.step('step back to the project by its crumb — the whole subtree lists', async () => {
    await page.locator('[data-tasks-breadcrumb] [data-action="tasks:enter-scope"]').first().click();
    await expect(page.locator('[data-tasks-scope]')).toContainText(PROJECT);
    for (const title of [EPIC, UNDER_EPIC, UNDER_PROJECT]) {
      await expect(rowFor(title)).toBeVisible();
    }
    // Progress counts the whole subtree, so the project's own row (once we are
    // back out) reports three.
  });

  await test.step('leave the scope entirely', async () => {
    await page.locator('[data-action="tasks:leave-scope"]').click();
    await expect(page.locator('[data-tasks-breadcrumb]')).toHaveCount(0);
    await expect(rowFor(PROJECT)).toBeVisible();
    await expect(rowFor(PROJECT).locator('[data-task-progress]')).toContainText('0/3');
  });

  await test.step('a plain task is refused a subtask, and promoting it lifts the refusal', async () => {
    await quickAdd(CAPTURED);
    const row = rowFor(CAPTURED);
    const id = await row.getAttribute('data-task-id');
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${id}"]`).click();
    await expect(row.locator('div[aria-label="Add a subtask"]')).toHaveCount(0);
    await expect(row.locator('[data-action="tasks:enter-scope"]')).toHaveCount(0);
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${id}"]`).click();

    await setLevel(CAPTURED, 'Project');
    await expect(row.locator('[data-action="tasks:enter-scope"]')).toBeVisible();
  });

  // Nothing in the flow was refused by the server.
  await expect(page.locator('[data-tasks-error]')).toHaveCount(0);
});

/**
 * The workflow axis, end to end: three states set through the real controls,
 * then the same rows read back as a board.
 *
 * The board is the stage's user-facing claim — "everything is open and nothing
 * distinguishes started from not-started from blocked" was the complaint — so
 * it is driven here through the documented UI against a real API from a cold
 * `:memory:` database, not asserted from inside a component test.
 *
 * Every title carries a per-run stamp: the e2e suite shares one in-memory
 * database across specs and both Playwright projects.
 */
test('tasks board: set three states, then read them back as four lanes', async ({ page }) => {
  const stamp = `b${Date.now()}`;
  const STARTED = `Strip the wallpaper ${stamp}`;
  const STUCK = `Wait for the plasterer ${stamp}`;
  const FINISHED = `Buy dust sheets ${stamp}`;
  const UNTOUCHED = `Choose a colour ${stamp}`;

  const rowFor = (title: string) =>
    page.locator('[data-task-row]', {
      has: page.locator('[data-task-title]', { hasText: title }),
    });
  const cardFor = (title: string) =>
    page.locator('[data-board-card]', {
      has: page.locator('[data-task-title]', { hasText: title }),
    });
  const lane = (status: string) => page.locator(`[data-board-lane-column][data-lane="${status}"]`);

  async function quickAdd(title: string): Promise<void> {
    await page.locator('#tasks-quick-add').fill(title);
    await page.locator('[data-action="tasks:quick-add"]').click();
    await expect(rowFor(title)).toBeVisible();
  }

  /** Drive the Status ActionSelect inside one expanded row's detail editor. */
  async function setStatusFromTheList(title: string, label: string): Promise<void> {
    const row = rowFor(title);
    const id = await row.getAttribute('data-task-id');
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${id}"]`).click();
    const picker = row.locator('[data-task-status-picker]');
    await picker.getByRole('button').click();
    await picker.getByRole('option', { name: label, exact: true }).click();
    await expect(row).toHaveAttribute('data-task-status', label.toLowerCase().replace(' ', ''));
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${id}"]`).click();
  }

  await attachVirtualAuthenticator(page);
  await page.goto('/');
  await registerPasskey(page, `boarder-${stamp}`);
  await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
  await expect(page.locator('[data-tasks-panel]')).toBeVisible();

  await test.step('capture four tasks — every one starts in To do', async () => {
    for (const title of [STARTED, STUCK, FINISHED, UNTOUCHED]) await quickAdd(title);
    await expect(rowFor(UNTOUCHED)).toHaveAttribute('data-task-status', 'todo');
  });

  await test.step('say what is started and what is stuck, from the list', async () => {
    await setStatusFromTheList(STARTED, 'Doing');
    await setStatusFromTheList(STUCK, 'Blocked');
    // The row wears the word, which is the complaint this stage answers: a
    // started task and a stuck one no longer look identical.
    await expect(rowFor(STARTED).locator('[data-task-state]')).toContainText('doing');
    await expect(rowFor(STUCK).locator('[data-task-state]')).toContainText('blocked');
    await expect(rowFor(UNTOUCHED).locator('[data-task-state]')).toHaveCount(0);
  });

  await test.step('tick one off — completing works straight from To do', async () => {
    const id = await rowFor(FINISHED).getAttribute('data-task-id');
    await page.locator(`[data-action="tasks:toggle"][data-action-task-id="${id}"]`).click();
    await expect(rowFor(FINISHED)).toHaveAttribute('data-task-status', 'done');
  });

  await test.step('switch to the board — four lanes, side by side at 1200px', async () => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator('[data-action="tasks:set-layout"][data-action-layout="board"]').click();
    await expect(page.locator('[data-tasks-board]')).toBeVisible();
    // The switch says which arrangement is showing. Two buttons that look the
    // same while one is already active is a small thing that makes a person
    // tap the one they are already on.
    await expect(
      page.locator('[data-action="tasks:set-layout"][data-action-layout="board"]'),
    ).toHaveClass(/tierPrimary/);
    await expect(
      page.locator('[data-action="tasks:set-layout"][data-action-layout="list"]'),
    ).not.toHaveClass(/tierPrimary/);
    // Above the 900px breakpoint every lane is on screen at once.
    await expect(page.locator('[data-board-lane-column]:visible')).toHaveCount(4);
    // …and the lane picker, which only pages a one-lane board, is not.
    await expect(page.locator('[data-board-lane-picker]')).toBeHidden();

    for (const [status, title] of [
      ['todo', UNTOUCHED],
      ['doing', STARTED],
      ['blocked', STUCK],
      ['done', FINISHED],
    ] as const) {
      await expect(lane(status).locator('[data-task-title]', { hasText: title })).toBeVisible();
    }

    // The artefact: what the whole board looks like on the laptop.
    await page.screenshot({
      path: test.info().outputPath('tasks-1200-board.png'),
      fullPage: true,
      // Settle the tier transitions first. Measured on the layout switch: a
      // shot taken straight after the click caught the selected button at
      // 0.12 alpha and the unselected one at 0.81, so the artefact showed the
      // toggle backwards. This finishes every transition rather than waiting a
      // fixed time for one.
      animations: 'disabled',
    });
  });

  await test.step('move a card between lanes from the board itself', async () => {
    const picker = cardFor(STUCK).locator('[data-task-status-picker]');
    await picker.getByRole('button').click();
    await picker.getByRole('option', { name: 'Doing', exact: true }).click();
    await expect(lane('doing').locator('[data-task-title]', { hasText: STUCK })).toBeVisible();
    await expect(lane('blocked').locator('[data-task-title]', { hasText: STUCK })).toHaveCount(0);
  });

  await test.step('the layout is in the URL, so the board survives a reload', async () => {
    await expect(page).toHaveURL(/layout=board/);
    await page.reload();
    await expect(page.locator('[data-tasks-board]')).toBeVisible();
  });

  // Nothing in the flow was refused by the server.
  await expect(page.locator('[data-tasks-error]')).toHaveCount(0);
});

/**
 * The 350px floor.
 *
 * 350px is the smallest phone eal must serve, and the tasks panel plus the
 * assistant sheet are the two surfaces used every day — showcase, family-phone
 * and pstn-contacts each carried a floor test while these two did not. Each
 * case asserts the document itself never scrolls sideways: a panel that
 * overflows pushes the whole page, and a horizontal scrollbar on a phone makes
 * every tap land somewhere else.
 */
test.describe('tasks at the 350px floor', () => {
  /** Pixels the document scrolls beyond its own viewport. Must be ≤ 0. */
  async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
    return page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  }

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 350, height: 900 });
    await attachVirtualAuthenticator(page);
    await page.goto('/');
    await registerPasskey(page, `narrow-${Date.now()}`);
    await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
    await expect(page.locator('[data-tasks-panel]')).toBeVisible();
  });

  test('the task list fits', async ({ page }) => {
    await page.locator('#tasks-quick-add').fill('A title long enough to test wrapping on a narrow phone');
    await page.locator('[data-action="tasks:quick-add"]').click();
    await expect(
      page.locator('[data-task-title]', { hasText: 'long enough to test wrapping' }),
    ).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('the expanded task detail fits — dates and the assignee select included', async ({ page }) => {
    await page.locator('#tasks-quick-add').fill('Detail at the floor');
    await page.locator('[data-action="tasks:quick-add"]').click();
    const row = page.locator('[data-task-row]', {
      has: page.locator('[data-task-title]', { hasText: 'Detail at the floor' }),
    });
    const taskId = await row.getAttribute('data-task-id');
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${taskId}"]`).click();
    await expect(row.locator('[data-task-detail]')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('a subtask row fits — the container badge names a long parent title', async ({ page }) => {
    // The All view lists every spec's rows out of the shared in-memory
    // database, so both titles carry a stamp that only this run can match.
    const stamp = Date.now();
    const parentMark = `p${stamp}`;
    const childMark = `c${stamp}`;
    await page
      .locator('#tasks-quick-add')
      .fill(`A parent title far too long to sit inside a badge unshortened ${parentMark}`);
    await page.locator('[data-action="tasks:quick-add"]').click();
    // A subtask is filed, so it never lists in the inbox. All is where the
    // container badge is read.
    await page.locator('[data-action="tasks:set-view"][data-action-view="all"]').click();
    const row = page.locator('[data-task-row]', {
      has: page.locator('[data-task-title]', { hasText: parentMark }),
    });
    const taskId = await row.getAttribute('data-task-id');
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${taskId}"]`).click();
    // Only a container holds anything, so promote before filing.
    const level = row.locator('[data-task-level]');
    await level.getByRole('button').click();
    await level.getByRole('option', { name: 'Project' }).click();
    await row.locator('div[aria-label="Add a subtask"]').click();
    const subInput = row.locator('input[aria-label="Add a subtask"]');
    await subInput.fill(`The child ${childMark}`);
    await subInput.press('Enter');

    const subRow = page.locator('[data-task-row]', {
      has: page.locator('[data-task-title]', { hasText: childMark }),
    });
    await expect(subRow.locator('[data-task-parent]')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('the reminder control fits, is thumb-sized, and says where this browser stands', async ({
    page,
  }) => {
    // Stage 4's only surface, in both the states this harness can reach.
    //
    // Playwright's Chromium denies notifications unless a test grants them, so
    // the state a fresh context lands in is `denied` — which renders a sentence
    // and no button, because nothing eal draws can undo a site-level block. It
    // is also the longest thing this control ever renders, so it is the case
    // that would push the document sideways.
    await expect(page.locator('[data-tasks-reminders][data-reminder-state="denied"]')).toBeVisible();
    await expect(page.locator('[data-action="tasks:enable-reminders"]')).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // The other state — the one that offers the tap, and so the one worth
    // measuring. `grantPermissions(['notifications'])` does not move
    // `Notification.permission` off 'denied' in this harness (measured: the
    // control still rendered the denied sentence after a grant and a reload),
    // so the permission the page reads is pinned before any page script runs.
    // Nothing else is stubbed: the panel, the boot path and the store are the
    // real ones, and they are what decides what renders.
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', {
        get: () => 'default',
        configurable: true,
      });
    });
    await page.reload();
    await expect(page.locator('[data-tasks-panel]')).toBeVisible();
    await expect(page.locator('[data-tasks-reminders][data-reminder-state="off"]')).toBeVisible();

    const remind = page.locator('[data-action="tasks:enable-reminders"]');
    await expect(remind).toBeVisible();
    await expect(remind).toHaveText('Remind me');
    const box = await remind.boundingBox();
    if (box === null) throw new Error('the reminder control has no bounding box');
    // The same 44px floor every other control in this panel is held to: its two
    // outcomes — the phone buzzes for deadlines, or it does not — are worth a
    // deliberate tap rather than a near miss.
    expect(
      Math.round(box.height),
      `the reminder control measured ${Math.round(box.width)}×${Math.round(box.height)}`,
    ).toBeGreaterThanOrEqual(44);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('the filter builder fits with two conditions added', async ({ page }) => {
    await page.locator('[data-action="tasks:add-condition"][data-action-field="status"]').click();
    await page.locator('[data-action="tasks:add-condition"][data-action-field="due"]').click();
    await expect(page.locator('[data-condition-row]')).toHaveCount(2);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('a scoped project fits — breadcrumb, container row and all', async ({ page }) => {
    // The 350px case for stage 1's two new surfaces: the way into a container
    // and the crumb trail out of it. Both carry a task title, and titles are
    // captured prose, so both are capped in tasks.css rather than left to push
    // the document sideways.
    const stamp = `s${Date.now()}`;
    const project = `A project title far too long to sit in a crumb unshortened ${stamp}`;
    const child = `A child ${stamp}`;

    await page.locator('#tasks-quick-add').fill(project);
    await page.locator('[data-action="tasks:quick-add"]').click();
    const row = page.locator('[data-task-row]', {
      has: page.locator('[data-task-title]', { hasText: stamp }),
    });
    const taskId = await row.getAttribute('data-task-id');
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${taskId}"]`).click();
    const level = row.locator('[data-task-level]');
    await level.getByRole('button').click();
    await level.getByRole('option', { name: 'Project' }).click();
    await expect(row.locator('[data-task-kind]')).toContainText('project');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${taskId}"]`).click();

    await row.locator('[data-action="tasks:enter-scope"]').click();
    await expect(page.locator('[data-tasks-breadcrumb]')).toBeVisible();
    await page.locator('#tasks-quick-add').fill(child);
    await page.locator('[data-action="tasks:quick-add"]').click();
    await expect(
      page.locator('[data-task-row]', {
        has: page.locator('[data-task-title]', { hasText: child }),
      }),
    ).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // The artefact the brief asks for: what the hierarchy looks like on the
    // owner's phone. Lands under packages/e2e-tests/test-results/.
    await page.screenshot({
      path: test.info().outputPath('tasks-350-scoped.png'),
      fullPage: true,
      // Settle the tier transitions first. Measured on the layout switch: a
      // shot taken straight after the click caught the selected button at
      // 0.12 alpha and the unselected one at 0.81, so the artefact showed the
      // toggle backwards. This finishes every transition rather than waiting a
      // fixed time for one.
      animations: 'disabled',
    });

    await page.locator('[data-action="tasks:leave-scope"]').click();
    await expect(page.locator('[data-tasks-breadcrumb]')).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('the board is one lane at a time, and the arrows page through all four', async ({ page }) => {
    // Four lanes at 350px would be about 80px each: too narrow for a task
    // title and far too narrow for a thumb. One lane at a time is not a
    // compromise here, it is the correct phone rendering — and the choice is a
    // media query in tasks.css, not a width read in JavaScript.
    const stamp = `n${Date.now()}`;
    const STARTED = `Sand the door ${stamp}`;
    const STUCK = `Chase the delivery ${stamp}`;

    const rowFor = (title: string) =>
      page.locator('[data-task-row]', {
        has: page.locator('[data-task-title]', { hasText: title }),
      });

    async function setStatus(title: string, label: string): Promise<void> {
      const row = rowFor(title);
      const id = await row.getAttribute('data-task-id');
      await page.locator(`[data-action="tasks:expand"][data-action-task-id="${id}"]`).click();
      const picker = row.locator('[data-task-status-picker]');
      await picker.getByRole('button').click();
      await picker.getByRole('option', { name: label, exact: true }).click();
      await expect(row).toHaveAttribute('data-task-status', label.toLowerCase());
      await page.locator(`[data-action="tasks:expand"][data-action-task-id="${id}"]`).click();
    }

    for (const title of [STARTED, STUCK]) {
      await page.locator('#tasks-quick-add').fill(title);
      await page.locator('[data-action="tasks:quick-add"]').click();
      await expect(rowFor(title)).toBeVisible();
    }
    await setStatus(STARTED, 'Doing');
    await setStatus(STUCK, 'Blocked');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await page.locator('[data-action="tasks:set-layout"][data-action-layout="board"]').click();
    await expect(page.locator('[data-tasks-board]')).toBeVisible();

    // All four lanes are in the DOM; exactly one of them is on screen.
    await expect(page.locator('[data-board-lane-column]')).toHaveCount(4);
    await expect(page.locator('[data-board-lane-column]:visible')).toHaveCount(1);
    await expect(page.locator('[data-board-lane-picker]')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // The artefact the brief asks for: the board as the owner sees it on the
    // phone. Lands under packages/e2e-tests/test-results/.
    await page.screenshot({
      path: test.info().outputPath('tasks-350-board.png'),
      fullPage: true,
      // Settle the tier transitions first. Measured on the layout switch: a
      // shot taken straight after the click caught the selected button at
      // 0.12 alpha and the unselected one at 0.81, so the artefact showed the
      // toggle backwards. This finishes every transition rather than waiting a
      // fixed time for one.
      animations: 'disabled',
    });

    // Page all the way round. Each stop shows exactly one lane and nothing
    // pushes the document sideways — a card carrying a long title included.
    const next = page.locator('[data-action="tasks:board-lane-step"][data-action-step="next"]');
    for (const lane of ['doing', 'blocked', 'done', 'todo']) {
      await next.click();
      await expect(page.locator('[data-tasks-board]')).toHaveAttribute('data-board-lane', lane);
      await expect(page.locator('[data-board-lane-column]:visible')).toHaveCount(1);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    }

    // The two tasks are each in the lane their state names.
    await next.click();
    await expect(
      page.locator('[data-board-lane-column][data-lane="doing"] [data-task-title]', {
        hasText: STARTED,
      }),
    ).toBeVisible();
    await page
      .locator('[data-action="tasks:board-lane-step"][data-action-step="prev"]')
      .click();
    await expect(page.locator('[data-tasks-board]')).toHaveAttribute('data-board-lane', 'todo');

    await expect(page.locator('[data-tasks-error]')).toHaveCount(0);
  });

  test('a board card moves lane at the floor, by tap where there is a touchscreen', async ({
    page,
  }) => {
    // A real tap where the context can produce one. `.tap()` throws on a
    // context without touch, so the `mobile-350` project — touch, mobile UA,
    // device pixel ratio — taps, and the desktop project drives the identical
    // control with the mouse. Both run; only the input differs.
    const touch = test.info().project.use.hasTouch === true;
    const activate = async (target: ReturnType<typeof page.locator>): Promise<void> => {
      if (touch) await target.tap();
      else await target.click();
    };
    // Dragging needs a pointer that can hover; this board is used from a phone
    // first, so the lane picker on the card is the whole move.
    const stamp = `m${Date.now()}`;
    const TITLE = `Move me by tap ${stamp}`;
    await page.locator('#tasks-quick-add').fill(TITLE);
    await page.locator('[data-action="tasks:quick-add"]').click();
    await expect(
      page.locator('[data-task-row]', {
        has: page.locator('[data-task-title]', { hasText: TITLE }),
      }),
    ).toBeVisible();

    await page.locator('[data-action="tasks:set-layout"][data-action-layout="board"]').click();
    const card = page.locator('[data-board-card]', {
      has: page.locator('[data-task-title]', { hasText: TITLE }),
    });
    await expect(card).toBeVisible();

    const picker = card.locator('[data-task-status-picker]');
    await activate(picker.getByRole('button'));
    await activate(picker.getByRole('option', { name: 'Blocked', exact: true }));

    // The card left the visible To do lane for one the phone is not showing.
    // It is still in the DOM — every lane is, and the media query decides which
    // one is on screen — so this is a visibility assertion, not a count.
    await expect(card).toBeHidden();
    await expect(card).toHaveAttribute('data-task-status', 'blocked');
    await page.locator('[data-action="tasks:board-lane-step"][data-action-step="next"]').click();
    await page.locator('[data-action="tasks:board-lane-step"][data-action-step="next"]').click();
    await expect(page.locator('[data-tasks-board]')).toHaveAttribute('data-board-lane', 'blocked');
    await expect(card).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expect(page.locator('[data-tasks-error]')).toHaveCount(0);
  });

  test('the controls a thumb hits are at least 44px', async ({ page }) => {
    // 44 CSS pixels is the smallest reliable touch target (Apple's HIG floor,
    // and close to Material's 48dp). Below it, a tick lands on the row instead
    // of the checkbox and the task opens when the person meant to complete it.
    await page.locator('#tasks-quick-add').fill('Thumb-sized controls');
    await page.locator('[data-action="tasks:quick-add"]').click();
    const row = page.locator('[data-task-row]', {
      has: page.locator('[data-task-title]', { hasText: 'Thumb-sized controls' }),
    });
    const taskId = await row.getAttribute('data-task-id');

    // Promote it so the container controls stage 1 added are on screen too.
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${taskId}"]`).click();
    const level = row.locator('[data-task-level]');
    await level.getByRole('button').click();
    await level.getByRole('option', { name: 'Project' }).click();
    await expect(row.locator('[data-action="tasks:enter-scope"]')).toBeVisible();
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${taskId}"]`).click();
    await row.locator('[data-action="tasks:enter-scope"]').click();
    await expect(page.locator('[data-tasks-breadcrumb]')).toBeVisible();

    const targets: ReadonlyArray<[label: string, selector: string]> = [
      ['quick-add submit', '[data-action="tasks:quick-add"]'],
      ['leave scope', '[data-action="tasks:leave-scope"]'],
      ['layout list', '[data-action="tasks:set-layout"][data-action-layout="list"]'],
      ['layout board', '[data-action="tasks:set-layout"][data-action-layout="board"]'],
      // The five presets. They were never measured through stages 0-2; the
      // fifth is what made the row worth measuring, and they are the controls
      // the phone taps most.
      ['view inbox', '[data-action="tasks:set-view"][data-action-view="inbox"]'],
      ['view today', '[data-action="tasks:set-view"][data-action-view="today"]'],
      ['view next', '[data-action="tasks:set-view"][data-action-view="next"]'],
      ['view all', '[data-action="tasks:set-view"][data-action-view="all"]'],
      ['view trash', '[data-action="tasks:set-view"][data-action-view="trash"]'],
      // Stage 4's control is measured in its own case above, not here: this
      // context denies notifications, so what renders is the denied sentence
      // and there is no button to measure until the permission is granted.
    ];
    const measured: Array<[string, number, number]> = [];
    for (const [label, selector] of targets) {
      const box = await page.locator(selector).first().boundingBox();
      if (box === null) throw new Error(`${label}: no bounding box for ${selector}`);
      measured.push([label, Math.round(box.width), Math.round(box.height)]);
    }
    // Back out, so the row's own controls are measurable in the same run.
    await page.locator('[data-action="tasks:leave-scope"]').click();
    for (const [label, selector] of [
      ['complete', `[data-action="tasks:toggle"][data-action-task-id="${taskId}"]`],
      ['expand', `[data-action="tasks:expand"][data-action-task-id="${taskId}"]`],
      ['enter scope', `[data-action="tasks:enter-scope"][data-action-task-id="${taskId}"]`],
    ] as const) {
      const box = await page.locator(selector).first().boundingBox();
      if (box === null) throw new Error(`${label}: no bounding box for ${selector}`);
      measured.push([label, Math.round(box.width), Math.round(box.height)]);
    }

    // The board's own controls, measured where they live — the lane arrows
    // only exist below the 900px breakpoint, which is where this test runs.
    await page.locator('[data-action="tasks:set-layout"][data-action-layout="board"]').click();
    await expect(page.locator('[data-tasks-board]')).toBeVisible();
    for (const [label, selector] of [
      ['lane prev', '[data-action="tasks:board-lane-step"][data-action-step="prev"]'],
      ['lane next', '[data-action="tasks:board-lane-step"][data-action-step="next"]'],
      ['card lane picker', '[data-board-card] [data-task-status-picker] button'],
    ] as const) {
      const box = await page.locator(selector).first().boundingBox();
      if (box === null) throw new Error(`${label}: no bounding box for ${selector}`);
      measured.push([label, Math.round(box.width), Math.round(box.height)]);
    }

    const tooSmall = measured.filter(([, w, h]) => w < 44 || h < 44);
    expect(
      tooSmall,
      `touch targets below 44px: ${JSON.stringify(measured)}`,
    ).toEqual([]);
  });

  test('a sequential project hands out one step at a time — the whole of stage 3, on the phone', async ({
    page,
  }) => {
    // The stage's user-facing claim, driven through the documented UI against a
    // real api from a cold `:memory:` database at the 350px floor. A green unit
    // tier proves the availability rule; it does not prove the owner can reach
    // it from a phone.
    const stamp = `x${Date.now()}`;
    const PROJECT = `Renovate the kitchen ${stamp}`;
    const STEP_ONE = `Strip the wallpaper ${stamp}`;
    const STEP_TWO = `Plaster the wall ${stamp}`;
    const STEP_THREE = `Paint the ceiling ${stamp}`;

    const rowFor = (title: string) =>
      page.locator('[data-task-row]', {
        has: page.locator('[data-task-title]', { hasText: title }),
      });

    await test.step('capture a project and give it three steps in order', async () => {
      await page.locator('#tasks-quick-add').fill(PROJECT);
      await page.locator('[data-action="tasks:quick-add"]').click();
      await expect(rowFor(PROJECT)).toBeVisible();
      const projectId = await rowFor(PROJECT).getAttribute('data-task-id');
      expect(projectId).not.toBeNull();

      await page.locator(`[data-action="tasks:expand"][data-action-task-id="${projectId}"]`).click();
      const level = rowFor(PROJECT).locator('[data-task-level]');
      await level.getByRole('button').click();
      await level.getByRole('option', { name: 'Project' }).click();
      await expect(rowFor(PROJECT).locator('[data-task-kind]')).toContainText('project');

      // "+ Add a subtask" three times: each lands at the next sibling position,
      // which is the order the sequential rule then hands them out in.
      for (const title of [STEP_ONE, STEP_TWO, STEP_THREE]) {
        await rowFor(PROJECT).locator('div[aria-label="Add a subtask"]').click();
        const input = rowFor(PROJECT).locator('input[aria-label="Add a subtask"]');
        await input.fill(title);
        await input.press('Enter');
      }
      await expect(rowFor(PROJECT).locator('[data-task-progress]')).toContainText('0/3');
    });

    await test.step('mark it sequential — the row says so', async () => {
      // The Order picker only exists on a container, which is what the Level
      // change above earned.
      const order = rowFor(PROJECT).locator('[data-task-order-picker]');
      await expect(order).toBeVisible();
      await order.getByRole('button').click();
      await order.getByRole('option', { name: 'Sequential', exact: true }).click();
      await expect(rowFor(PROJECT).locator('[data-task-sequential]')).toContainText('sequential');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    await test.step('Next shows exactly the first step', async () => {
      await page.locator('[data-action="tasks:set-view"][data-action-view="next"]').click();
      await expect(rowFor(STEP_ONE)).toBeVisible();
      // The other two are behind it, and the container is not an action while
      // it still holds work.
      await expect(rowFor(STEP_TWO)).toHaveCount(0);
      await expect(rowFor(STEP_THREE)).toHaveCount(0);
      await expect(rowFor(PROJECT)).toHaveCount(0);
      // Five presets now share the row. A grid track per view could not wrap
      // and would push the document sideways here.
      await expect(page.locator('[data-tasks-view-switch] [data-action="tasks:set-view"]')).toHaveCount(5);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      // The artefact: what "what do I do next" looks like on the owner's phone.
      // Lands under packages/e2e-tests/test-results/.
      await page.screenshot({
        path: test.info().outputPath('tasks-350-next.png'),
        fullPage: true,
        // Settle the tier transitions first. Measured on the layout switch: a
        // shot taken straight after the click caught the selected button at
        // 0.12 alpha and the unselected one at 0.81, so the artefact showed the
        // toggle backwards. This finishes every transition rather than waiting a
        // fixed time for one.
        animations: 'disabled',
      });
    });

    await test.step('complete the first step and the view moves to the second', async () => {
      const stepOneId = await rowFor(STEP_ONE).getAttribute('data-task-id');
      expect(stepOneId).not.toBeNull();
      await page.locator(`[data-action="tasks:toggle"][data-action-task-id="${stepOneId}"]`).click();
      // The finished step lingers beside the one it unlocked, so the list reads
      // as advancing rather than jumping.
      await expect(rowFor(STEP_ONE)).toHaveAttribute('data-task-status', 'done');
      await expect(rowFor(STEP_TWO)).toBeVisible();
      await expect(rowFor(STEP_THREE)).toHaveCount(0);

      // Navigating away and back clears the linger: the view now holds the
      // second step alone, which is the state a fresh look would find.
      await page.locator('[data-action="tasks:set-view"][data-action-view="all"]').click();
      await expect(rowFor(PROJECT)).toBeVisible();
      await page.locator('[data-action="tasks:set-view"][data-action-view="next"]').click();
      await expect(rowFor(STEP_TWO)).toBeVisible();
      await expect(rowFor(STEP_ONE)).toHaveCount(0);
      await expect(rowFor(STEP_THREE)).toHaveCount(0);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    await test.step('the view is in the URL, so Next survives a reload', async () => {
      await expect(page).toHaveURL(/view=next/);
      await page.reload();
      await expect(rowFor(STEP_TWO)).toBeVisible();
    });

    await expect(page.locator('[data-tasks-error]')).toHaveCount(0);
  });

  test('a recurring task fits — seven day toggles, the longest badge, and the next one after a tick', async ({
    page,
  }) => {
    // Plan 05 at the floor, against the real api. The two things that could
    // overflow are the row of seven weekday toggles and a badge holding a whole
    // sentence; both are pushed to their widest here.
    // Unique per run: both Playwright projects share one server and every
    // member sees every task, so a fixed title finds the other project's rows.
    const title = `Put the bins and the recycling out ${Date.now()}`;
    await page.locator('#tasks-quick-add').fill(title);
    await page.locator('[data-action="tasks:quick-add"]').click();
    const row = page.locator('[data-task-row]', {
      has: page.locator('[data-task-title]', { hasText: title }),
    });
    const taskId = await row.first().getAttribute('data-task-id');
    await page.locator(`[data-action="tasks:expand"][data-action-task-id="${taskId}"]`).click();
    const editor = row.locator('[data-task-recurrence-editor]');
    await expect(editor).toBeVisible();

    const repeats = editor.locator('[data-task-repeats-picker]');
    await repeats.getByRole('button').click();
    await repeats.getByRole('option', { name: 'Weekly, on days' }).click();
    const toggles = editor.locator('[data-action="tasks:toggle-recurrence-day"]');
    await expect(toggles).toHaveCount(7);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // Every toggle is a thumb target, and every one is inside the screen.
    for (let i = 0; i < 7; i++) {
      const box = await toggles.nth(i).boundingBox();
      expect(box, `day toggle ${i} has no box`).not.toBeNull();
      if (box === null) continue;
      expect(box.width, `day toggle ${i} width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `day toggle ${i} height`).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, `day toggle ${i} right edge`).toBeLessThanOrEqual(350);
    }

    // Turn on days until six are on — the longest sentence the badge can hold
    // short of "Every day" — and count from completion, which adds two words.
    const on = editor.locator('[data-recurrence-day-on="true"]');
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      if ((await on.count()) >= 6) break;
      const wrapper = editor.locator(`[data-recurrence-day="${day}"]`);
      if ((await wrapper.getAttribute('data-recurrence-day-on')) === 'true') continue;
      const before = await on.count();
      await wrapper.getByRole('button').tap({ force: true }).catch(() => wrapper.getByRole('button').click());
      await expect(on).toHaveCount(before + 1);
    }
    const basis = editor.locator('[data-task-recurrence-basis]');
    await basis.getByRole('button').click();
    await basis.getByRole('option', { name: 'Counted from when it is done' }).click();
    await expect(row.locator('[data-task-recurrence]')).toContainText('after done');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: test.info().outputPath('tasks-350-recurrence.png'),
      fullPage: true,
    });

    // Tick it: the next occurrence arrives, carries the badge, and still fits.
    await page.locator(`[data-action="tasks:toggle"][data-action-task-id="${taskId}"]`).click();
    await expect(row).toHaveCount(2);
    await expect(row.locator('[data-task-recurrence]')).toHaveCount(1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expect(page.locator('[data-tasks-error]')).toHaveCount(0);
  });

  test('the assistant sheet fits over the tasks panel', async ({ page }) => {
    await page.locator('[data-action="chat:toggle"]').click();
    await expect(page.locator('[data-chat-panel]')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
