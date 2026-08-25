#!/usr/bin/env bun
/**
 * Multi-process passkey ceremony test.
 *
 * Browser A registers a passkey via the CDP Virtual Authenticator. Then a
 * separate Browser B process is launched and the registered credential is
 * injected into B's authenticator via CDP. B navigates the same SPA and
 * signs in — discoverable credentials → no display name needed → the
 * authed header appears. Proves the full register-then-sign-in flow works
 * across two distinct browser processes against one shared api.
 *
 * Catches the class of bug where the api accepts a registration but emits
 * something that the subsequent sign-in can't consume (the userHandle bug
 * being the canonical example).
 */
import puppeteer, { type Browser } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi, E2E_INVITE_CODE } from './lib/boot-api.ts';
import { waitForSignedInAs, waitForText, NAV_TIMEOUT_MS } from './lib/e2e-config.ts';
import {
  addCredential,
  attachVirtualAuthenticator,
  closeBrowserQuietly,
  getCredentials,
} from './lib/puppeteer-webauthn.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/passkey-multi');
const PROFILES = resolve(ARTIFACTS, 'profiles');
const DB_PATH = resolve(ARTIFACTS, 'passkey-multi.sqlite');

const FIXED_PORT = '4103';
const DISPLAY_NAME = 'crosser';

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILES, { recursive: true });

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  let browserA: Browser | undefined;
  let browserB: Browser | undefined;

  try {
    // ─── Browser A: register a passkey ───────────────────────────────────────
    browserA = await puppeteer.launch({
      userDataDir: resolve(PROFILES, 'A'),
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const pageA = (await browserA.pages())[0] ?? (await browserA.newPage());
    const vaA = await attachVirtualAuthenticator(pageA);
    await pageA.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await waitForText(pageA, 'Sign in');

    await pageA.locator('input[name="displayName"]').fill(DISPLAY_NAME);
    await pageA.locator('input[name="inviteCode"]').fill(E2E_INVITE_CODE);
    await pageA.locator('[data-action="auth:register"]').click();
    await waitForSignedInAs(pageA, DISPLAY_NAME);

    // Capture the credential from A's virtual authenticator so we can inject it into B.
    const credentials = await getCredentials(vaA);
    if (credentials.length === 0) {
      throw new Error('Browser A registered but the CDP authenticator has no credential to extract');
    }
    const sharedCredential = credentials[0]!;
    console.log(`Browser A registered (credentialId=${sharedCredential.credentialId.slice(0, 24)}…)`);

    await closeBrowserQuietly(browserA);
    browserA = undefined;

    // ─── Browser B: sign in with A's credential ──────────────────────────────
    browserB = await puppeteer.launch({
      userDataDir: resolve(PROFILES, 'B'),
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const pageB = (await browserB.pages())[0] ?? (await browserB.newPage());
    const vaB = await attachVirtualAuthenticator(pageB);

    // Inject the credential before navigating so the discoverable-credential
    // sign-in flow surfaces it.
    await addCredential(vaB, sharedCredential);

    await pageB.goto(api.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    await waitForText(pageB, 'Sign in');

    await pageB.locator('[data-action="auth:sign-in"]').click();
    await waitForSignedInAs(pageB, DISPLAY_NAME);

    // The sanity check that the sign-in did NOT create a second user is the
    // assertion above: `waitForSignedInAs` reads the badge in B's own drawer
    // and fails unless it carries A's display name. Re-reading the badge here
    // would find nothing — the helper leaves the drawer closed again.

    console.log(`Browser B signed in as ${DISPLAY_NAME} using A's credential`);
    console.log('e2e-passkey-multi: OK');
    return 0;
  } catch (err) {
    console.error('e2e-passkey-multi: FAIL', err);
    return 1;
  } finally {
    await closeBrowserQuietly(browserA);
    await closeBrowserQuietly(browserB);
    await api.kill();
  }
}

process.exit(await main());
