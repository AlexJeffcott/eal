#!/usr/bin/env bun
import puppeteer, { type Browser } from 'puppeteer';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'bun';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { bootApi } from './lib/boot-api.ts';
import { waitForSignedInAs, waitForText, NAV_TIMEOUT_MS } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/auth-multi');
const PROFILES = resolve(ARTIFACTS, 'profiles');
const DB_PATH = resolve(ARTIFACTS, 'auth-multi.sqlite');
const TOKEN_HOME = resolve(ARTIFACTS, 'cli-home');
const TOKEN_PATH = resolve(TOKEN_HOME, 'token');

const FIXED_PORT = '4101';

async function captureScreenshots(browsers: Browser[], suffix: string): Promise<void> {
  for (let i = 0; i < browsers.length; i++) {
    const browser = browsers[i];
    if (!browser) continue;
    const pages = await browser.pages().catch(() => []);
    for (let j = 0; j < pages.length; j++) {
      const page = pages[j];
      if (!page) continue;
      await page
        .screenshot({ path: resolve(ARTIFACTS, `device-${i}-${suffix}.png`), fullPage: true })
        .catch(() => {});
    }
  }
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILES, { recursive: true });
  await mkdir(TOKEN_HOME, { recursive: true });

  // Seed users + tokens BEFORE the api boots. With auth-by-default the WS
  // requires a token before subscribing — anonymous browsers can't see the
  // broadcast at all. So this script exercises:
  //  1. The CLI's authenticated POST → broadcast across authed WS subscribers
  //  2. An anonymous browser sees the SignIn surface and CANNOT subscribe.
  const seeded = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'cli-e2e' });
  const browserA = seedCliToken({ dbPath: DB_PATH, displayName: 'browser-a', label: 'browser-seed' });
  await writeFile(TOKEN_PATH, seeded.token, { encoding: 'utf8', mode: 0o600 });

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  const browsers: Browser[] = [];

  try {
    // Browser A: authed via pre-seeded localStorage token.
    {
      const browser = await puppeteer.launch({
        userDataDir: resolve(PROFILES, 'auth-a'),
        args: ['--no-sandbox', '--ignore-certificate-errors'],
      });
      browsers.push(browser);
      const pages = await browser.pages();
      const page = pages[0] ?? (await browser.newPage());
      await page.evaluateOnNewDocument((seedToken: string) => {
        try { localStorage.setItem('eal-token', seedToken); } catch { /* ignore */ }
      }, browserA.token);
      await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
      await waitForSignedInAs(page, 'browser-a');
      // `/` is the shell launcher. Open the Tasks app so the panel is mounted
      // to render the broadcast row asserted below, and so its WS subscription
      // is live before the CLI-token write fires.
      await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
      await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });
    }

    // Browser B: anonymous — must see the SignIn surface, must NOT see the broadcast.
    {
      const browser = await puppeteer.launch({
        userDataDir: resolve(PROFILES, 'anon-b'),
        args: ['--no-sandbox', '--ignore-certificate-errors'],
      });
      browsers.push(browser);
      const pages = await browser.pages();
      const page = pages[0] ?? (await browser.newPage());
      await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
      await waitForText(page, 'Sign in');
    }

    // Run the CLI with the seeded token — exercises auth login + hello.
    const login = spawn(
      ['bun', 'packages/cli/src/index.ts', 'auth', 'login', '--token', seeded.token],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          EAL_API_URL: api.url,
          EAL_TOKEN_PATH: TOKEN_PATH,
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    if ((await login.exited) !== 0) throw new Error('cli auth login failed');
    // The fetch below uses the same dev self-signed cert as the CLI processes
    // (which have NODE_TLS_REJECT_UNAUTHORIZED=0 via their spawn env).
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

    // Create a task via the CLI's bearer token to prove the session is live
    // end-to-end (CLI token → api auth → DB write → WS broadcast).
    const TASK_TITLE = 'cli-authed-create';
    const cliToken = await Bun.file(TOKEN_PATH).text();
    const taskResp = await fetch(`${api.url}/api/v1/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cliToken.trim()}`,
      },
      body: JSON.stringify({ title: TASK_TITLE }),
    });
    if (!taskResp.ok) {
      throw new Error(`task creation via CLI token failed: ${taskResp.status} ${await taskResp.text()}`);
    }

    // Browser A (authed) sees the broadcast.
    {
      const page = (await browsers[0]!.pages())[0]!;
      await page.waitForFunction(
        (needle) => {
          const els = Array.from(document.querySelectorAll('[data-task-row] [data-task-title]'));
          return els.some((el) => (el.textContent ?? '').trim() === needle);
        },
        {},
        TASK_TITLE,
      );
    }
    // Browser B (anonymous) does NOT — the SignIn surface remains.
    {
      const page = (await browsers[1]!.pages())[0]!;
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes(TASK_TITLE)) {
        throw new Error('anonymous browser saw the broadcast — WS auth gate is leaking');
      }
      if (!bodyText.includes('Sign in')) {
        throw new Error('anonymous browser is no longer showing the SignIn surface');
      }
    }

    // Confirm the persisted task carries the cli user's created_by.
    const db = new Database(DB_PATH, { readonly: true });
    interface TaskProbe { title: string; created_by: number }
    const rows = db.prepare<TaskProbe, []>('SELECT title, created_by FROM tasks').all();
    db.close();
    const persisted = rows.find((r) => r.title === TASK_TITLE);
    if (!persisted) throw new Error(`persisted task "${TASK_TITLE}" not found`);
    if (persisted.created_by !== seeded.userId) {
      throw new Error(`expected created_by=${seeded.userId}, got ${persisted.created_by}`);
    }

    // Logout removes the session row.
    const logout = spawn(
      ['bun', 'packages/cli/src/index.ts', 'auth', 'logout'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          EAL_API_URL: api.url,
          EAL_TOKEN_PATH: TOKEN_PATH,
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    if ((await logout.exited) !== 0) throw new Error('cli auth logout failed');

    const dbAfter = new Database(DB_PATH, { readonly: true });
    interface CountRow { c: number }
    const countStmt = dbAfter.prepare<CountRow, []>("SELECT count(*) AS c FROM sessions WHERE label = 'cli-e2e'");
    const remaining = countStmt.get();
    dbAfter.close();
    if (remaining && remaining.c !== 0) throw new Error(`expected 0 cli-e2e sessions after logout, got ${remaining.c}`);

    await captureScreenshots(browsers, 'ok');
    console.log('e2e-auth-multi: OK');
    return 0;
  } catch (err) {
    console.error('e2e-auth-multi: FAIL', err);
    await captureScreenshots(browsers, 'fail');
    return 1;
  } finally {
    for (const browser of browsers) await browser.close().catch(() => {});
    await api.kill();
  }
}

process.exit(await main());
