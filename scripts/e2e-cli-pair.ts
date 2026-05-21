#!/usr/bin/env bun
/**
 * Cross-boundary CLI-pair test.
 *
 * The shape required by ~/projects/CLAUDE.md ("Green checks do not prove
 * features work"): drives the real CLI binary, the real api process, and a
 * real Chrome browser performing a real passkey registration via the CDP
 * Virtual Authenticator. No seedCliToken, no stubbed sessions — the CLI's
 * token must come back through the documented `auth pair` ceremony, the
 * SPA's claim handler, and the api's session repo.
 *
 * Steps:
 *  1. Boot the api against a fresh sqlite db.
 *  2. Puppeteer browser registers a passkey, gets a 'spa' session.
 *  3. CLI runs `eal auth pair --label test-cli`; we scrape user_code from stdout.
 *  4. Browser navigates to the verification URL, fills code + label, clicks Pair.
 *  5. CLI finishes (token written to disk).
 *  6. A task is created via the api with the CLI's new bearer token; the api
 *     broadcasts it and the browser SPA renders the row.
 *  7. Assert: the task persisted with created_by == the browser user; a
 *     `test-cli` session row exists for that user.
 */
import puppeteer, { type Browser } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'bun';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { bootApi } from './lib/boot-api.ts';
import { waitForText, NAV_TIMEOUT_MS } from './lib/e2e-config.ts';
import { attachVirtualAuthenticator, closeBrowserQuietly } from './lib/puppeteer-webauthn.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/cli-pair');
const PROFILES = resolve(ARTIFACTS, 'profiles');
const DB_PATH = resolve(ARTIFACTS, 'cli-pair.sqlite');
const TOKEN_HOME = resolve(ARTIFACTS, 'cli-home');
const TOKEN_PATH = resolve(TOKEN_HOME, 'token');
const FIXED_PORT = '4104';
const DISPLAY_NAME = 'pairer';
const LABEL = 'test-cli';

interface UserRow { id: number }
interface TaskRow { id: number; title: string; created_by: number }
interface SessionRow { label: string | null }

interface CliOutput {
  /** Resolves when the CLI prints the user_code + verification_url. */
  readonly codeReady: Promise<{ userCode: string; verificationUrl: string }>;
  /** Resolves to the complete stdout once the process exits. */
  readonly all: Promise<string>;
}

function collectCliOutput(stream: ReadableStream<Uint8Array>): CliOutput {
  const decoder = new TextDecoder();
  let buf = '';
  let codeResolve: (v: { userCode: string; verificationUrl: string }) => void = () => {};
  let codeReject: (err: Error) => void = () => {};
  const codeReady = new Promise<{ userCode: string; verificationUrl: string }>((resolve, reject) => {
    codeResolve = resolve;
    codeReject = reject;
  });
  let allResolve: (v: string) => void = () => {};
  const all = new Promise<string>((resolve) => { allResolve = resolve; });

  void (async (): Promise<void> => {
    const reader = stream.getReader();
    let codeSeen = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        buf += chunk;
        process.stdout.write(chunk);
        if (!codeSeen) {
          const codeMatch = buf.match(/\b([0-9A-Z]{4}-[0-9A-Z]{4})\b/);
          const urlMatch = buf.match(/\bhttps:\/\/[^\s]*\/public\/auth\/cli-pair\?code=[^\s]+/);
          if (codeMatch && urlMatch) {
            codeSeen = true;
            codeResolve({ userCode: codeMatch[1]!, verificationUrl: urlMatch[0]! });
          }
        }
      }
    } finally {
      reader.releaseLock();
      if (!codeSeen) codeReject(new Error(`never saw user_code + verification_url in CLI stdout (got: ${buf.slice(0, 400)})`));
      allResolve(buf);
    }
  })();

  return { codeReady, all };
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILES, { recursive: true });
  await mkdir(TOKEN_HOME, { recursive: true });
  // The CLI subprocesses set NODE_TLS_REJECT_UNAUTHORIZED via spawn env. The
  // harness itself also makes a fetch against the dev https cert below, so we
  // need this here too.
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  let browser: Browser | undefined;

  try {
    // ─── 1. Browser: real passkey registration ───────────────────────────────
    browser = await puppeteer.launch({
      userDataDir: resolve(PROFILES, 'A'),
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await attachVirtualAuthenticator(page);
    await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await waitForText(page, 'Sign in');

    await page.locator('input[name="displayName"]').fill(DISPLAY_NAME);
    await page.locator('[data-action="auth:register"]').click();
    await waitForText(page, DISPLAY_NAME);

    // ─── 2. CLI: start pairing, scrape user_code from stdout ─────────────────
    const pair = spawn(
      ['bun', 'packages/cli/src/index.ts', 'auth', 'pair', '--label', LABEL],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          EAL_API_URL: api.url,
          EAL_TOKEN_PATH: TOKEN_PATH,
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        stdout: 'pipe',
        stderr: 'inherit',
      },
    );
    if (!pair.stdout || typeof pair.stdout === 'number') {
      throw new Error('e2e-cli-pair: CLI stdout was not piped');
    }
    const cliOutput = collectCliOutput(pair.stdout);
    const { userCode, verificationUrl } = await cliOutput.codeReady;
    console.log(`e2e-cli-pair: scraped userCode=${userCode}`);

    // ─── 3. Browser: claim the user_code via the verification page ───────────
    await page.goto(verificationUrl, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    // Both the code AND the label are carried in the URL the CLI printed, so
    // the form is fully pre-filled — the user types nothing. Assert both, then
    // claim directly without any manual fill (that's the carry-over contract).
    const prefilledForm = await page.evaluate(() => {
      const inputValue = (name: string): string | null => {
        const el = document.querySelector(`input[name="${name}"]`);
        return el instanceof HTMLInputElement ? el.value : null;
      };
      return { code: inputValue('user_code'), label: inputValue('label') };
    });
    if (prefilledForm.code !== userCode) {
      throw new Error(`expected pre-filled code=${userCode}, got ${prefilledForm.code}`);
    }
    if (prefilledForm.label !== LABEL) {
      throw new Error(`expected pre-filled label=${LABEL}, got ${prefilledForm.label}`);
    }
    await page.locator('[data-action="cli-pair:claim"]').click();
    await waitForText(page, 'Device paired');

    // ─── 4. CLI exits 0 having written the token to disk ─────────────────────
    const pairExit = await pair.exited;
    if (pairExit !== 0) throw new Error(`cli auth pair exited ${pairExit}`);
    if (!existsSync(TOKEN_PATH)) throw new Error('no token written to disk at ' + TOKEN_PATH);

    // CLI must echo the user the server actually paired — proves the client's
    // display_name → displayName translation didn't drop or substitute the
    // identity in the wire result.
    const cliStdout = await cliOutput.all;
    if (!cliStdout.includes(`paired as ${DISPLAY_NAME}`)) {
      throw new Error(`CLI stdout did not contain "paired as ${DISPLAY_NAME}":\n${cliStdout.slice(-400)}`);
    }
    if (!cliStdout.includes(`label=${LABEL}`)) {
      throw new Error(`CLI stdout did not echo label=${LABEL}:\n${cliStdout.slice(-400)}`);
    }

    // ─── 5. Token works end-to-end: create a task via the api with the CLI's
    //     new bearer token; browser receives the broadcast ───────────────────
    // Open the Tasks app FIRST so the WS subscribes before the broadcast fires
    // and the tasks panel is mounted to render the row. `/` is the shell
    // launcher — the panel only mounts once the Tasks app is open.
    await page.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await waitForText(page, DISPLAY_NAME);
    await page.locator('[data-landing-app="tasks"] [data-action="shell:navigate"]').click();
    await page.waitForSelector('[data-tasks-panel]', { timeout: NAV_TIMEOUT_MS });

    const TASK_TITLE = 'paired-cli-created-this';
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

    // Browser SPA received the broadcast and rendered the new task.
    await page.waitForFunction(
      (needle) => {
        const els = Array.from(document.querySelectorAll('[data-task-row] [data-task-title]'));
        return els.some((el) => (el.textContent ?? '').trim() === needle);
      },
      { timeout: NAV_TIMEOUT_MS },
      TASK_TITLE,
    );

    // ─── 6. Persistence assertions ───────────────────────────────────────────
    const db = new Database(DB_PATH, { readonly: true });
    const user = db.prepare<UserRow, [string]>('SELECT id FROM users WHERE display_name = ?').get(DISPLAY_NAME);
    if (!user) throw new Error(`user ${DISPLAY_NAME} not found in db`);

    const task = db
      .prepare<TaskRow, [string]>('SELECT id, title, created_by FROM tasks WHERE title = ?')
      .get(TASK_TITLE);
    if (!task) throw new Error(`persisted task "${TASK_TITLE}" not found`);
    if (task.created_by !== user.id) {
      throw new Error(`expected created_by=${user.id}, got ${task.created_by}`);
    }

    const sessionLabels = db
      .prepare<SessionRow, [number]>('SELECT label FROM sessions WHERE user_id = ?')
      .all(user.id)
      .map((r) => r.label);
    db.close();
    if (!sessionLabels.includes(LABEL)) {
      throw new Error(`expected a session row with label=${LABEL}; got labels=${JSON.stringify(sessionLabels)}`);
    }

    console.log('e2e-cli-pair: OK');
    return 0;
  } catch (err) {
    console.error('e2e-cli-pair: FAIL', err);
    if (browser) {
      const pages = await browser.pages().catch(() => []);
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        if (!p) continue;
        await p.screenshot({ path: resolve(ARTIFACTS, `fail-${i}.png`), fullPage: true }).catch(() => {});
      }
    }
    return 1;
  } finally {
    await closeBrowserQuietly(browser);
    await api.kill();
  }
}

process.exit(await main());
