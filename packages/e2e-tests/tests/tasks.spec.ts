import { test, expect } from '@playwright/test';
import { attachVirtualAuthenticator } from './lib/virtual-authenticator.ts';
import { expectSignedInAs } from './lib/shell.ts';

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
    await page.locator('input[name="displayName"]').fill('pat');
    await page.locator('[data-action="auth:register"]').click();
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
