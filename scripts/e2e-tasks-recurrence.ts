#!/usr/bin/env bun
/**
 * Verification artefact for recurring tasks — Plan 05,
 * `docs/plans/05-recurring-tasks.md`.
 *
 * Two real browsers, two household members, one real server, a file-backed
 * database. Everything is driven through the controls a person uses — the
 * quick-add, the detail editor's date field and Repeats picker, the tick box —
 * and every count is read from the database file, not inferred from the DOM.
 *
 *   0. The database file starts in the shape production holds today (release
 *      v46: `client_id` present, no recurrence columns) with a row in it. The
 *      api must migrate it on boot and keep that row, NULL in all three.
 *   1. A captures "Put the bins out", dates it THREE WEEKS AGO, and sets it to
 *      repeat weekly. The picker reads the weekday off the due date. B sees
 *      the badge.
 *   2. A ticks it. B receives the successor: exactly one, dated the first such
 *      weekday strictly after today — next week, not three catch-up rows and
 *      not "three weeks ago plus seven days". The rule has moved onto it.
 *   3. THE ACCIDENTAL TICK. A unticks. The untouched successor disappears on
 *      BOTH browsers and from the database — gone, not binned — and the badge
 *      returns to the original.
 *   4. A ticks again; B edits the successor; A unticks. The successor is B's
 *      now: it stays, on both browsers, and the original comes back plain.
 *   5. A recurring PROJECT with two steps, one of them already ticked by B. A
 *      ticks the project. B receives the whole next occurrence — project and
 *      both steps — every row back at `todo`, filed under the NEW project.
 *
 * The expected dates are computed here with plain UTC-midnight arithmetic, on
 * purpose: checking `nextOccurrence` against `nextOccurrence` would pass
 * whatever it returned.
 *
 * Falsified two ways — see the plan's "As built" section.
 */
import { Database } from 'bun:sqlite';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS, waitFor, waitForSignedInAs } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/tasks-recurrence');
const PROFILES = resolve(ARTIFACTS, 'profiles');
const DB_PATH = resolve(ARTIFACTS, 'tasks-recurrence.sqlite');
const FIXED_PORT = '4120';
const BINS = 'Put the bins out';
const CLEAN = 'Weekly clean';
const STEPS = ['Kitchen', 'Bathroom'];
const SYNC_TIMEOUT_MS = 10_000;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `YYYY-MM-DD` moved by whole days. UTC midnight, so no clock change can bend it. */
function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function weekdayName(date: string): string {
  const name = DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()];
  if (name === undefined) throw new Error(`no weekday for ${date}`);
  return name;
}

// ─── The database, read from outside the server ─────────────────────────────

interface DbRow {
  id: number;
  parent_id: number | null;
  title: string;
  status: string;
  due_at: string | null;
  deleted_at: string | null;
  recurrence: string | null;
  spawned_from: number | null;
}

function dbRows(title: string): DbRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare<DbRow, [string]>(
        `SELECT id, parent_id, title, status, due_at, deleted_at, recurrence, spawned_from
           FROM tasks WHERE title = ? ORDER BY id`,
      )
      .all(title);
  } finally {
    db.close();
  }
}

const LEGACY_TITLE = 'Already on the list';
const RECURRENCE_COLUMNS = ['recurrence', 'spawned_from', 'spawn_group'];

function taskColumns(): string[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare<{ name: string }, []>("SELECT name FROM pragma_table_info('tasks')")
      .all()
      .map((c) => c.name);
  } finally {
    db.close();
  }
}

/**
 * Put the file back to the shape release v46 left in production.
 * `seedCliToken` applies today's schema, so the three columns and their two
 * indexes are taken off again — the indexes first, since SQLite refuses to
 * drop a column an index still reads — and a row is left behind to survive.
 */
function downgradeToPreRecurrence(userId: number): void {
  const db = new Database(DB_PATH);
  try {
    db.exec('DROP INDEX idx_tasks_spawn_group');
    db.exec('DROP INDEX idx_tasks_spawned_from');
    for (const column of RECURRENCE_COLUMNS) db.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
    db.query(
      "INSERT INTO tasks (title, status, kind, position, created_by, updated_by) VALUES (?, 'todo', 'task', 0, ?, ?)",
    ).run(LEGACY_TITLE, userId, userId);
  } finally {
    db.close();
  }
}

function expectRows(label: string, title: string, check: (rows: DbRow[]) => string | null): void {
  const rows = dbRows(title);
  const wrong = check(rows);
  if (wrong !== null) {
    throw new Error(`${label}: ${wrong}\n  rows titled ${JSON.stringify(title)}: ${JSON.stringify(rows)}`);
  }
}

// ─── The page, driven the way a person drives it ────────────────────────────

const row = (id: number): string => `[data-task-row][data-task-id="${id}"]`;

interface PageRow {
  id: number;
  status: string;
  due: string | null;
  repeats: string | null;
  parent: string | null;
}

async function pageRows(page: Page, title: string): Promise<PageRow[]> {
  return page.evaluate((needle: string) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-task-row]'));
    return rows
      .filter((r) => (r.querySelector('[data-task-title]')?.textContent ?? '').trim() === needle)
      .map((r) => ({
        id: Number(r.dataset['taskId']),
        status: r.dataset['taskStatus'] ?? '',
        due: r.querySelector('[data-task-due]')?.textContent?.trim() ?? null,
        repeats: r.querySelector('[data-task-recurrence]')?.textContent?.trim() ?? null,
        parent: r.querySelector('[data-task-parent] .tasks-parent')?.textContent?.trim() ?? null,
      }));
  }, title);
}

async function waitForRows(
  page: Page,
  who: string,
  title: string,
  ok: (rows: PageRow[]) => boolean,
  description: string,
): Promise<PageRow[]> {
  try {
    await waitFor(async () => ok(await pageRows(page, title)), {
      timeoutMs: SYNC_TIMEOUT_MS,
      description: `${who}: ${description}`,
    });
  } catch (err) {
    throw new Error(`${String(err)}\n  ${who} shows: ${JSON.stringify(await pageRows(page, title))}`);
  }
  return pageRows(page, title);
}

async function quickAdd(page: Page, title: string): Promise<number> {
  // Focus and type, not click and fill. A locator click scrolls its target to
  // the top edge of the viewport, which is where the shell's sticky top bar
  // sits: once the list is long enough to scroll, the click lands on the bar's
  // Assistant button instead. The keyboard has no such problem, and Enter in
  // the quick-add is the path a person at a keyboard takes anyway.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.focus('#tasks-quick-add');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  const rows = await waitForRows(page, 'A', title, (r) => r.length >= 1, `the row for ${title}`);
  const id = rows[rows.length - 1]?.id;
  if (id === undefined) throw new Error(`no id for ${title}`);
  return id;
}

async function expand(page: Page, id: number): Promise<void> {
  await page.locator(`[data-action="tasks:expand"][data-action-task-id="${id}"]`).click();
  await page.waitForSelector(`${row(id)} [data-task-detail]`, { timeout: NAV_TIMEOUT_MS });
}

/** An ActionInput: click the view to edit, set the value, blur to commit. */
async function fillField(page: Page, id: number, ariaLabel: string, value: string, tag = 'input'): Promise<void> {
  await page.locator(`${row(id)} div[aria-label="${ariaLabel}"]`).click();
  const field = `${row(id)} ${tag}[aria-label="${ariaLabel}"]`;
  await page.waitForSelector(field, { timeout: NAV_TIMEOUT_MS });
  await page.evaluate(
    (selector: string, next: string) => {
      const el = document.querySelector(selector);
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
        throw new Error(`no field at ${selector}`);
      }
      // The native setter, so the framework's own value tracking sees a change.
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, next);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    field,
    value,
  );
  // The blur is its own step. ActionInput commits the draft it last RENDERED
  // with, so a blur in the same tick as the input would commit the old value;
  // a person's finger cannot do that, and a script must not pretend to.
  await page.waitForFunction(
    (selector: string, next: string) => {
      const el = document.querySelector(selector);
      return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value === next;
    },
    { timeout: NAV_TIMEOUT_MS },
    field,
    value,
  );
  await page.evaluate((selector: string) => {
    const el = document.querySelector(selector);
    if (el instanceof HTMLElement) el.blur();
  }, field);
}

/** An ActionSelect: open it, pick the option by its label. */
async function pickOption(page: Page, id: number, wrapper: string, label: string): Promise<void> {
  await page.locator(`${row(id)} ${wrapper} button`).click();
  const options = `${row(id)} ${wrapper} [role="option"]`;
  try {
    await page.waitForFunction(
      (selector: string, wanted: string) =>
        Array.from(document.querySelectorAll(selector)).some((el) => (el.textContent ?? '').trim() === wanted),
      { timeout: NAV_TIMEOUT_MS },
      options,
      label,
    );
  } catch {
    const seen = await page.evaluate(
      (selector: string) => Array.from(document.querySelectorAll(selector)).map((el) => (el.textContent ?? '').trim()),
      options,
    );
    throw new Error(`no option ${JSON.stringify(label)} in ${wrapper}; it offers ${JSON.stringify(seen)}`);
  }
  await page.evaluate(
    (selector: string, wanted: string) => {
      const option = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (el) => (el.textContent ?? '').trim() === wanted,
      );
      option?.click();
    },
    options,
    label,
  );
}

async function tick(page: Page, id: number): Promise<void> {
  await page.locator(`[data-action="tasks:toggle"][data-action-task-id="${id}"]`).click();
}

async function localToday(page: Page): Promise<string> {
  return page.evaluate(() => {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  });
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILES, { recursive: true });

  const users = [
    seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'browser-seed' }),
    seedCliToken({ dbPath: DB_PATH, displayName: 'elisa', label: 'browser-seed' }),
  ];
  // ─── 0. A database from before the columns ───────────────────────────────
  const firstUser = users[0];
  if (!firstUser) throw new Error('no seeded user');
  downgradeToPreRecurrence(firstUser.userId);
  if (taskColumns().some((c) => RECURRENCE_COLUMNS.includes(c))) {
    throw new Error('the pre-migration database already has a recurrence column');
  }

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  const browsers: Browser[] = [];

  try {
    const migrated = taskColumns();
    const missing = RECURRENCE_COLUMNS.filter((c) => !migrated.includes(c));
    if (missing.length > 0) throw new Error(`the api booted and did not add ${missing.join(', ')}`);
    if (!migrated.includes('client_id')) throw new Error('the migration lost client_id');
    expectRows('the legacy row', LEGACY_TITLE, (rows) => {
      if (rows.length !== 1) return `expected the one legacy row, found ${rows.length}`;
      if (rows[0]?.recurrence !== null || rows[0]?.spawned_from !== null) return 'it did not start NULL';
      return null;
    });
    console.log('e2e-tasks-recurrence: 0. the api migrated a v46-shaped database, and kept its row');

    const pages: Page[] = [];
    for (const [i, user] of users.entries()) {
      const browser = await puppeteer.launch({
        userDataDir: resolve(PROFILES, `device-${i}`),
        args: ['--no-sandbox', '--ignore-certificate-errors'],
      });
      browsers.push(browser);
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      pages.push(page);
      await page.evaluateOnNewDocument((seedToken: string) => {
        try { localStorage.setItem('eal-token', seedToken); } catch { /* ignore */ }
      }, user.token);
      await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
      await waitForSignedInAs(page, i === 0 ? 'alex' : 'elisa');
      await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
      await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
      // All: the one view that keeps a finished row on screen for both of them.
      await page.locator('[data-action="tasks:set-view"][data-action-view="all"]').click();
    }
    const [a, b] = pages;
    if (!a || !b) throw new Error('expected two browser pages');

    const today = await localToday(a);
    const threeWeeksAgo = addDays(today, -21);
    const nextWeek = addDays(today, 7);
    const everyDay = `Every ${weekdayName(today)}`;

    // ─── 1. A makes it repeat; B sees that it does ──────────────────────────
    const binsId = await quickAdd(a, BINS);
    await expand(a, binsId);
    await fillField(a, binsId, 'Due date', threeWeeksAgo);
    await waitForRows(a, 'A', BINS, (r) => r[0]?.due === threeWeeksAgo, 'the due badge');
    await pickOption(a, binsId, '[data-task-repeats-picker]', 'Weekly, on days');
    await waitForRows(a, 'A', BINS, (r) => r[0]?.repeats?.includes(everyDay) === true, `the "${everyDay}" badge`);
    await waitForRows(b, 'B', BINS, (r) => r.length === 1 && r[0]?.repeats?.includes(everyDay) === true, `the "${everyDay}" badge`);
    console.log(`e2e-tasks-recurrence: 1. due ${threeWeeksAgo}, "${everyDay}" — the picker read the weekday off the date, and B sees it`);

    // ─── 2. A ticks; B receives exactly one successor, next week ────────────
    await tick(a, binsId);
    const onB = await waitForRows(
      b, 'B', BINS,
      (r) => r.length === 2 && r.some((x) => x.status === 'todo' && x.due === nextWeek),
      `a second row, todo, due ${nextWeek}`,
    );
    const successor = onB.find((x) => x.id !== binsId);
    if (!successor) throw new Error('B has no successor row');
    if (onB.find((x) => x.id === binsId)?.status !== 'done') throw new Error('B does not show the original as done');
    if (successor.repeats === null || onB.find((x) => x.id === binsId)?.repeats !== null) {
      throw new Error(`the rule did not move onto the successor on B: ${JSON.stringify(onB)}`);
    }
    await waitForRows(a, 'A', BINS, (r) => r.length === 2, 'both rows');
    expectRows('after the tick', BINS, (rows) => {
      if (rows.length !== 2) return `expected 2 rows, the database holds ${rows.length}`;
      const [first, second] = rows;
      if (first?.status !== 'done' || first.recurrence !== null) return 'the original is not a plain done row';
      if (second?.status !== 'todo') return 'the successor is not todo';
      if (second.due_at !== nextWeek) return `the successor is due ${second.due_at}, expected ${nextWeek}`;
      if (second.recurrence === null) return 'the successor does not carry the rule';
      if (second.spawned_from !== first.id) return 'the successor does not name the row it succeeded';
      return null;
    });
    console.log(`e2e-tasks-recurrence: 2. three weeks late, ticked once: B received ONE successor, due ${nextWeek}`);

    // ─── 3. The accidental tick ─────────────────────────────────────────────
    await tick(a, binsId);
    for (const [who, page] of [['A', a], ['B', b]] as const) {
      await waitForRows(
        page, who, BINS,
        (r) => r.length === 1 && r[0]?.id === binsId && r[0].status === 'todo' && r[0].repeats !== null,
        'the successor gone and the badge back on the original',
      );
    }
    expectRows('after the untick', BINS, (rows) => {
      if (rows.length !== 1) return `expected the successor to be gone, the database holds ${rows.length} rows`;
      if (rows[0]?.recurrence === null) return 'the rule did not come back to the original';
      if (rows[0]?.deleted_at !== null) return 'the original is in the bin';
      return null;
    });
    console.log('e2e-tasks-recurrence: 3. unticked: the untouched successor is gone on both browsers and from the database');

    // ─── 4. A successor someone has touched is theirs ───────────────────────
    await tick(a, binsId);
    const again = await waitForRows(b, 'B', BINS, (r) => r.length === 2, 'the new successor');
    const kept = again.find((x) => x.id !== binsId);
    if (!kept) throw new Error('B has no second successor');
    if (kept.id === successor.id) throw new Error('the second successor reused the id of the removed one');
    await expand(b, kept.id);
    await fillField(b, kept.id, 'Task notes', 'And the glass this time', 'textarea');
    await waitFor(
      () => {
        const db = new Database(DB_PATH, { readonly: true });
        try {
          return db.prepare<{ notes: string }, [number]>('SELECT notes FROM tasks WHERE id = ?').get(kept.id)?.notes === 'And the glass this time';
        } finally {
          db.close();
        }
      },
      { timeoutMs: SYNC_TIMEOUT_MS, description: "B's edit reaching the database" },
    );
    await tick(a, binsId);
    for (const [who, page] of [['A', a], ['B', b]] as const) {
      await waitForRows(
        page, who, BINS,
        (r) => r.length === 2 && r.find((x) => x.id === binsId)?.status === 'todo' && r.find((x) => x.id === binsId)?.repeats === null,
        'the original reopened, plain, beside the successor',
      );
    }
    expectRows('after unticking past an edited successor', BINS, (rows) => {
      if (rows.length !== 2) return `expected both rows to stay, the database holds ${rows.length}`;
      const [first, second] = rows;
      if (first?.status !== 'todo' || first.recurrence !== null) return 'the original did not come back plain';
      if (second?.id !== kept.id || second.recurrence === null) return 'the edited successor lost the rule';
      return null;
    });
    console.log('e2e-tasks-recurrence: 4. B edited the successor, A unticked: it stayed, and kept the rule');

    // ─── 5. A recurring project ─────────────────────────────────────────────
    const cleanId = await quickAdd(a, CLEAN);
    await expand(a, cleanId);
    await pickOption(a, cleanId, '[data-task-level]', 'Project');
    await a.waitForSelector(`${row(cleanId)} div[aria-label="Add a subtask"]`, { timeout: NAV_TIMEOUT_MS });
    for (const step of STEPS) {
      await a.locator(`${row(cleanId)} div[aria-label="Add a subtask"]`).click();
      const input = `${row(cleanId)} input[aria-label="Add a subtask"]`;
      await a.waitForSelector(input, { timeout: NAV_TIMEOUT_MS });
      await a.locator(input).fill(step);
      await a.keyboard.press('Enter');
      await waitForRows(a, 'A', step, (r) => r.length === 1, `the step ${step}`);
    }
    await fillField(a, cleanId, 'Due date', today);
    await pickOption(a, cleanId, '[data-task-repeats-picker]', 'Every few days');
    await waitForRows(b, 'B', CLEAN, (r) => r[0]?.repeats?.includes('Every day') === true, 'the project badge');
    // B finishes one step first, so "reset to todo" has something to reset.
    const kitchenOnB = (await waitForRows(b, 'B', 'Kitchen', (r) => r.length === 1, 'the Kitchen step'))[0];
    if (!kitchenOnB) throw new Error('B has no Kitchen row');
    await tick(b, kitchenOnB.id);
    await waitForRows(a, 'A', 'Kitchen', (r) => r[0]?.status === 'done', 'Kitchen done');

    await tick(a, cleanId);
    const tomorrow = addDays(today, 1);
    const projects = await waitForRows(
      b, 'B', CLEAN,
      (r) => r.length === 2 && r.some((x) => x.status === 'todo' && x.due === tomorrow),
      `the next project, due ${tomorrow}`,
    );
    const nextProject = projects.find((x) => x.id !== cleanId);
    if (!nextProject) throw new Error('B has no successor project');
    for (const step of STEPS) {
      await waitForRows(
        b, 'B', step,
        (r) => r.length === 2 && r.filter((x) => x.status === 'todo' && x.parent === CLEAN).length >= 1,
        `a fresh "${step}" under the new project`,
      );
    }
    for (const step of STEPS) {
      expectRows(`the recurring project's step "${step}"`, step, (rows) => {
        if (rows.length !== 2) return `expected 2 rows, the database holds ${rows.length}`;
        const fresh = rows.find((r) => r.parent_id === nextProject.id);
        if (!fresh) return `no copy is filed under the new project #${nextProject.id}`;
        if (fresh.status !== 'todo') return `the copy is ${fresh.status}, not todo`;
        const old = rows.find((r) => r.parent_id === cleanId);
        if (!old) return 'the original step is no longer under the original project';
        if (step === 'Kitchen' && old.status !== 'done') return 'the original Kitchen lost its tick';
        return null;
      });
    }
    expectRows('the recurring project', CLEAN, (rows) => {
      if (rows.length !== 2) return `expected 2 projects, the database holds ${rows.length}`;
      const next = rows.find((r) => r.id === nextProject.id);
      if (next?.due_at !== tomorrow) return `the next project is due ${next?.due_at}, expected ${tomorrow}`;
      if (next.recurrence === null || rows.find((r) => r.id === cleanId)?.recurrence !== null) return 'the rule did not move';
      return null;
    });
    console.log('e2e-tasks-recurrence: 5. a recurring project: B received the next one with both steps, all reset to todo');

    console.log('e2e-tasks-recurrence: OK');
    return 0;
  } catch (err) {
    console.error('e2e-tasks-recurrence: FAIL', err);
    for (let i = 0; i < browsers.length; i++) {
      const open = (await browsers[i]?.pages().catch(() => [])) ?? [];
      for (let j = 0; j < open.length; j++) {
        await open[j]
          ?.screenshot({ path: resolve(ARTIFACTS, `device-${i}-page-${j}-fail.png`), fullPage: true })
          .catch(() => {});
      }
    }
    return 1;
  } finally {
    for (const browser of browsers) await browser.close().catch(() => {});
    await api.kill();
  }
}

process.exit(await main());
