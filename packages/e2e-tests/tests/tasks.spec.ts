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

    // Assignee — an ActionSelect: open the dropdown, pick the option.
    const assignee = row.locator('[data-polly-action-select]');
    await assignee.getByRole('button').click();
    await assignee.getByRole('option', { name: 'pat' }).click();
    await expect(row.locator('[data-task-assignee]')).toContainText('pat');
  });

  await test.step('add a subtask — the parent shows a 0/1 progress badge', async () => {
    // The subtask field is an ActionInput (commits on Enter).
    await row.locator('div[aria-label="Add a subtask"]').click();
    const subInput = row.locator('input[aria-label="Add a subtask"]');
    await subInput.fill('Make a list');
    await subInput.press('Enter');
    await expect(row.locator('[data-task-subtasks] [data-task-title]')).toHaveText('Make a list');
    await expect(row.locator('[data-task-progress]')).toContainText('0/1');
  });

  await test.step('complete the subtask — progress ticks to 1/1', async () => {
    const subtaskId = await row
      .locator('[data-task-subtasks] [data-task-row]')
      .getAttribute('data-task-id');
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

  test('the filter builder fits with two conditions added', async ({ page }) => {
    await page.locator('[data-action="tasks:add-condition"][data-action-field="status"]').click();
    await page.locator('[data-action="tasks:add-condition"][data-action-field="due"]').click();
    await expect(page.locator('[data-condition-row]')).toHaveCount(2);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
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

    const targets: ReadonlyArray<[label: string, selector: string]> = [
      ['complete', `[data-action="tasks:toggle"][data-action-task-id="${taskId}"]`],
      ['expand', `[data-action="tasks:expand"][data-action-task-id="${taskId}"]`],
      ['quick-add submit', '[data-action="tasks:quick-add"]'],
    ];
    const measured: Array<[string, number, number]> = [];
    for (const [label, selector] of targets) {
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

  test('the assistant sheet fits over the tasks panel', async ({ page }) => {
    await page.locator('[data-action="chat:toggle"]').click();
    await expect(page.locator('[data-chat-panel]')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
