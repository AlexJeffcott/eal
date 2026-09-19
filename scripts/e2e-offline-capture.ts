#!/usr/bin/env bun
/**
 * Verification artefact for the capture outbox — Plan 06 part B,
 * `docs/plans/06-offline-capture.md`. Part A's is `e2e-offline-shell.ts`.
 *
 * The done-when, from the plan: aeroplane mode, the app opens, you capture a
 * task, you come back online, and it is on the server ONCE.
 *
 * One real browser against a real server, from a cold profile, over a database
 * file that predates the `client_id` column:
 *
 *   0. The database is put back to its pre-stage-5 shape — no `client_id`
 *      column, no index — with a row already in it. The api must migrate it.
 *   1. One online visit, and one task captured online.
 *   2. The server dies. A cold navigation must show BOTH earlier tasks: the
 *      list copy in IndexedDB is the only place they can come from.
 *   3. A task is captured with no server. It must show as pending.
 *   4. A reload, server still dead. The capture must still be there, still
 *      pending: IndexedDB is the only place it can come from.
 *   5. The server returns. With NO reload the capture must become a real row,
 *      and the server must hold exactly one row for it.
 *   6. The cruel case. The server commits a create and the RESPONSE is lost
 *      (failed at the response stage, over CDP). The device cannot tell that
 *      from a lost request. One row on the server, one row on the screen, and
 *      nothing left pending — by whichever road the row came back.
 *   7. The replay, forced. The script sends that same `client_id` again, as a
 *      device that never heard back would. 200, the same task, still one row.
 *
 * Every count is read from the DATABASE, not the DOM. A lost or doubled write
 * looks identical on the screen that made it; only what crossed the boundary
 * tells them apart.
 *
 * Why the outage is a killed process and not `page.setOfflineMode(true)`:
 * Chrome's offline emulation is per target, and a service worker is its own
 * target — see `e2e-offline-shell.ts`.
 */
import { Database } from 'bun:sqlite';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi, type BootedApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS, waitFor, waitForSignedInAs } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/offline-capture');
const PROFILE = resolve(ARTIFACTS, 'profile');
const DB_PATH = resolve(ARTIFACTS, 'offline-capture.sqlite');
const FIXED_PORT = '4119';
const ORIGIN = `https://localhost:${FIXED_PORT}`;
/** The reconnect backoff caps at 30s, and no `online` event fires here. */
const RECONNECT_TIMEOUT_MS = 60_000;

const LEGACY_TITLE = 'Already on the list';
const ONLINE_TITLE = 'Written before the tunnel';
const OFFLINE_TITLE = 'Written in the tunnel';
const LOST_REPLY_TITLE = 'The reply got lost';

function boot(): Promise<BootedApi> {
  return bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
}

interface CountRow { n: number }
interface ColumnRow { name: string }
interface ClientIdRow { id: number; client_id: string | null }

/** Open, read, close: the api holds the file in WAL mode the whole time. */
function readDb<T>(read: (db: Database) => T): T {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function serverRowsTitled(title: string): ClientIdRow[] {
  return readDb((db) =>
    db.query<ClientIdRow, [string]>('SELECT id, client_id FROM tasks WHERE title = ?').all(title),
  );
}

function hasClientIdColumn(): boolean {
  return readDb((db) =>
    db.query<ColumnRow, []>("SELECT name FROM pragma_table_info('tasks')").all(),
  ).some((c) => c.name === 'client_id');
}

/**
 * Put the file back to the shape it had before stage 5. `seedCliToken` applies
 * today's schema, so the column and its index are taken off again — the index
 * first, since SQLite refuses to drop a column an index still reads.
 */
function downgradeToPreClientId(userId: number): void {
  const db = new Database(DB_PATH);
  try {
    db.exec('DROP INDEX idx_tasks_client_id');
    db.exec('ALTER TABLE tasks DROP COLUMN client_id');
    db.query(
      "INSERT INTO tasks (title, status, kind, position, created_by, updated_by) VALUES (?, 'todo', 'task', 0, ?, ?)",
    ).run(LEGACY_TITLE, userId, userId);
  } finally {
    db.close();
  }
}

async function titlesIn(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(
    (sel: string) =>
      Array.from(document.querySelectorAll(`${sel} [data-task-title]`)).map((el) =>
        (el.textContent ?? '').trim(),
      ),
    selector,
  );
}

const confirmedTitles = (page: Page): Promise<string[]> => titlesIn(page, '[data-task-row]');
const pendingTitles = (page: Page): Promise<string[]> => titlesIn(page, '[data-task-pending]');

/** What IndexedDB holds, read by the page: `{ outbox, snapshot }` titles. */
async function offlineStores(page: Page): Promise<{ outbox: string[]; snapshot: string[] }> {
  return page.evaluate(
    () =>
      new Promise<{ outbox: string[]; snapshot: string[] }>((resolveStores, reject) => {
        const open = indexedDB.open('eal-tasks-offline');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('outbox')) {
            db.close();
            resolveStores({ outbox: [], snapshot: [] });
            return;
          }
          const tx = db.transaction(['outbox', 'snapshot'], 'readonly');
          const outbox = tx.objectStore('outbox').getAll();
          const snapshot = tx.objectStore('snapshot').getAll();
          tx.oncomplete = () => {
            db.close();
            const titleOf = (v: unknown): string =>
              typeof v === 'object' && v !== null && 'title' in v && typeof v.title === 'string'
                ? v.title
                : '?';
            const lists: unknown[] = snapshot.result;
            resolveStores({
              outbox: outbox.result.map(titleOf),
              snapshot: lists.flatMap((list) => (Array.isArray(list) ? list.map(titleOf) : [])),
            });
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

async function quickAdd(page: Page, title: string): Promise<void> {
  await page.locator('#tasks-quick-add').fill(title);
  await page.locator('[data-action="tasks:quick-add"]').click();
}

interface CreateWatch {
  /** The `client_id` of every create the page has sent, in order. */
  sent: string[];
  /** Fail the response of the next create, after the server has answered it. */
  loseNextReply(): void;
  /** How many responses were really failed — so step 6 cannot pass by doing nothing. */
  repliesLost: number;
}

/**
 * Watch every `POST /api/v1/tasks` at the RESPONSE stage, over CDP. Paused
 * there, the server has already committed; failing it then is a response lost
 * on the way back, which is the one failure no request-stage hook can make.
 */
async function watchCreates(cdp: CDPSession): Promise<CreateWatch> {
  let lose = false;
  const watch: CreateWatch = {
    sent: [],
    loseNextReply: () => {
      lose = true;
    },
    repliesLost: 0,
  };
  cdp.on('Fetch.requestPaused', (event) => {
    const isCreate = event.request.method === 'POST' && event.request.url.endsWith('/api/v1/tasks');
    if (isCreate) {
      const body: unknown = JSON.parse(event.request.postData ?? '{}');
      const clientId =
        typeof body === 'object' && body !== null && 'client_id' in body ? body.client_id : null;
      watch.sent.push(typeof clientId === 'string' ? clientId : '(none)');
    }
    if (isCreate && lose) {
      lose = false;
      // Only a response that EXISTS can be lost: `responseStatusCode` is set
      // when the server answered, and absent when the request itself failed.
      if (event.responseStatusCode !== 200) {
        throw new Error(`meant to lose a 200, but the create answered ${event.responseStatusCode}`);
      }
      void cdp
        .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionReset' })
        .then(() => {
          watch.repliesLost += 1;
        });
      return;
    }
    // A request that failed before any response (the server is dead) pauses
    // here too, with nothing to continue; the error is its own answer.
    void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  });
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/v1/tasks', requestStage: 'Response' }],
  });
  return watch;
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });

  // ─── 0. A database from before the column ────────────────────────────────
  const user = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'browser-seed' });
  downgradeToPreClientId(user.userId);
  if (hasClientIdColumn()) throw new Error('the pre-migration database already has client_id');

  let api: BootedApi | null = await boot();
  let browser: Browser | null = null;

  try {
    if (!hasClientIdColumn()) throw new Error('the api booted and did not add client_id');
    const legacy = serverRowsTitled(LEGACY_TITLE);
    if (legacy.length !== 1 || legacy[0]?.client_id !== null) {
      throw new Error(`the legacy row did not survive the migration as one NULL-id row: ${JSON.stringify(legacy)}`);
    }
    console.log('e2e-offline-capture: the api migrated a pre-client_id database, and kept its row');

    browser = await puppeteer.launch({
      userDataDir: PROFILE,
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.evaluateOnNewDocument((seedToken: string) => {
      try { localStorage.setItem('eal-token', seedToken); } catch { /* ignore */ }
    }, user.token);
    const creates = await watchCreates(await page.createCDPSession());

    // ─── 1. One online visit, and one online capture ────────────────────────
    await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await waitForSignedInAs(page, 'alex');
    await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
    await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    await waitFor(async () => (await confirmedTitles(page)).includes(LEGACY_TITLE), {
      description: 'the legacy row, online',
    });
    await quickAdd(page, ONLINE_TITLE);
    await waitFor(async () => (await confirmedTitles(page)).includes(ONLINE_TITLE), {
      description: 'the online capture as a confirmed row',
    });
    if (serverRowsTitled(ONLINE_TITLE).length !== 1) {
      throw new Error('the online capture is not on the server exactly once');
    }
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await waitFor(async () => (await page.evaluate(() => caches.keys())).length === 1, {
      description: 'the shell cache',
    });
    await waitFor(
      async () => {
        const { snapshot } = await offlineStores(page);
        return snapshot.includes(LEGACY_TITLE) && snapshot.includes(ONLINE_TITLE);
      },
      { description: 'both tasks in the list copy' },
    );
    console.log('e2e-offline-capture: online, a capture goes through the outbox and lands once');

    // ─── 2. The server dies. A cold navigation shows the list copy ──────────
    await api.kill();
    api = null;
    await page.goto(`${ORIGIN}/tasks`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    await waitFor(
      async () => {
        const titles = await confirmedTitles(page);
        return titles.includes(LEGACY_TITLE) && titles.includes(ONLINE_TITLE);
      },
      { description: 'both earlier tasks, with no server' },
    );
    console.log('e2e-offline-capture: with no server, the list is there');

    // ─── 3. Capture with no server ──────────────────────────────────────────
    await quickAdd(page, OFFLINE_TITLE);
    await waitFor(async () => (await pendingTitles(page)).includes(OFFLINE_TITLE), {
      description: 'the offline capture, pending',
    });
    if ((await confirmedTitles(page)).includes(OFFLINE_TITLE)) {
      throw new Error('the offline capture rendered as a confirmed row with no server');
    }
    await waitFor(async () => (await offlineStores(page)).outbox.includes(OFFLINE_TITLE), {
      description: 'the offline capture in IndexedDB',
    });
    // The owner's phone is 350px wide. The pending row must fit it.
    await page.setViewport({ width: 350, height: 750, isMobile: true, hasTouch: true });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: resolve(ARTIFACTS, 'pending-at-350px.png'), fullPage: true });
    if (overflow > 0) throw new Error(`the page overflows by ${overflow}px at 350px with a pending row`);
    await page.setViewport({ width: 800, height: 600 });
    console.log('e2e-offline-capture: a capture with no server shows as pending, and fits 350px');

    // ─── 4. Reload, server still dead ───────────────────────────────────────
    await page.goto(`${ORIGIN}/tasks`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    await waitFor(async () => (await pendingTitles(page)).includes(OFFLINE_TITLE), {
      description: 'the offline capture, still pending after a reload',
    });
    if (serverRowsTitled(OFFLINE_TITLE).length !== 0) {
      throw new Error('the offline capture reached a server that is not running');
    }
    console.log('e2e-offline-capture: it survives a reload, still pending');

    // ─── 5. The server returns. No reload anywhere in this step ─────────────
    api = await boot();
    await waitFor(async () => (await confirmedTitles(page)).includes(OFFLINE_TITLE), {
      timeoutMs: RECONNECT_TIMEOUT_MS,
      description: 'the offline capture as a confirmed row, with no reload',
    });
    await waitFor(async () => !(await pendingTitles(page)).includes(OFFLINE_TITLE), {
      description: 'the pending entry gone',
    });
    const landed = serverRowsTitled(OFFLINE_TITLE);
    if (landed.length !== 1 || landed[0]?.client_id === null) {
      throw new Error(`expected one server row bearing a client_id, got ${JSON.stringify(landed)}`);
    }
    await waitFor(async () => (await offlineStores(page)).outbox.length === 0, {
      description: 'an empty outbox in IndexedDB',
    });
    console.log('e2e-offline-capture: the server returned, and it is there once');

    // ─── 6. The server commits and the response is lost ─────────────────────
    const sentBefore = creates.sent.length;
    creates.loseNextReply();
    await quickAdd(page, LOST_REPLY_TITLE);
    await waitFor(async () => (await confirmedTitles(page)).includes(LOST_REPLY_TITLE), {
      timeoutMs: RECONNECT_TIMEOUT_MS,
      description: 'the capture whose reply was lost, as a confirmed row',
    });
    await waitFor(async () => (await pendingTitles(page)).length === 0, {
      description: 'nothing left pending',
    });
    if (creates.repliesLost !== 1) {
      throw new Error(`the harness lost ${creates.repliesLost} replies; this step proves nothing`);
    }
    const onScreen = (await confirmedTitles(page)).filter((t) => t === LOST_REPLY_TITLE).length;
    if (onScreen !== 1) throw new Error(`the capture is on the screen ${onScreen} times`);
    const lost = serverRowsTitled(LOST_REPLY_TITLE);
    if (lost.length !== 1) throw new Error(`the server holds ${lost.length} rows for one capture`);
    const sentForIt = creates.sent.slice(sentBefore);
    console.log(
      `e2e-offline-capture: a lost response leaves one row, shown once ` +
        `(${sentForIt.length} create(s) sent; ${sentForIt.length > 1 ? 'settled by the retry' : 'settled by the broadcast'})`,
    );

    // ─── 7. The same client id, sent again ──────────────────────────────────
    const clientId = lost[0]?.client_id;
    if (typeof clientId !== 'string') throw new Error('the lost-reply row carries no client_id');
    const replay = await fetch(`${ORIGIN}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ title: LOST_REPLY_TITLE, client_id: clientId }),
      tls: { rejectUnauthorized: false },
    });
    const replayBody: unknown = await replay.json();
    const replayedId =
      typeof replayBody === 'object' && replayBody !== null && 'task' in replayBody &&
      typeof replayBody.task === 'object' && replayBody.task !== null && 'id' in replayBody.task
        ? replayBody.task.id
        : null;
    if (replay.status !== 200 || replayedId !== lost[0]?.id) {
      throw new Error(
        `the replay should be a 200 carrying task ${lost[0]?.id}; got ${replay.status} ${JSON.stringify(replayBody)}`,
      );
    }
    const afterReplay = serverRowsTitled(LOST_REPLY_TITLE).length;
    if (afterReplay !== 1) throw new Error(`the replay left ${afterReplay} rows`);
    const total = readDb((db) => db.query<CountRow, []>('SELECT COUNT(*) AS n FROM tasks').get());
    if (total?.n !== 4) throw new Error(`expected 4 tasks on the server in all, found ${total?.n}`);
    console.log('e2e-offline-capture: the same client_id sent again is a 200 and no new row');

    console.log('e2e-offline-capture: OK');
    return 0;
  } catch (err) {
    console.error('e2e-offline-capture: FAIL', err);
    const pages = (await browser?.pages().catch(() => [])) ?? [];
    for (let j = 0; j < pages.length; j++) {
      await pages[j]
        ?.screenshot({ path: resolve(ARTIFACTS, `page-${j}-fail.png`), fullPage: true })
        .catch(() => {});
    }
    return 1;
  } finally {
    await browser?.close().catch(() => {});
    await api?.kill();
  }
}

process.exit(await main());
