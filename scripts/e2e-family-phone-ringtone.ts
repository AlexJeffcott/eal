#!/usr/bin/env bun
/**
 * End-to-end test for the family-phone ringtone + notification wiring.
 *
 * Two ends of a real call, one of them in a real browser:
 *
 *   caller (Node, headless @eal/client)  ──── /pair, /device WS ────►  api
 *                                                                       │
 *                                                          call:incoming│
 *                                                                       ▼
 *   callee (puppeteer Chrome, real WS, spies on Notification + AudioContext)
 *
 * The browser pairs itself by calling fetch() + crypto.subtle from inside
 * page.evaluate (the same wire calls @eal/client makes), persists the
 * resulting keypair to IndexedDB exactly the way keystore.ts does, then
 * reloads so the production devices-bootstrap rehydrates it and opens the
 * device WS. From that point the call is real: the caller invites, the
 * server forwards, the browser's call:incoming subscriber runs the actual
 * installCallEventHandlers, the ringtone constructs a real AudioContext,
 * the notifier constructs a real Notification. Spies catch both.
 *
 * No test seam in production code: main.tsx has no awareness of this
 * harness. The browser is signed in via the seeded session token in
 * localStorage exactly like every other e2e script in scripts/.
 */
import puppeteer, { type Browser } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { delay } from '@eal/shared';
import { bootApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';
import {
  createEalClient,
  type FamilyPhoneCallEvent,
  type FamilyPhoneDeviceConnection,
} from '../packages/client/src/index.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/family-phone-ringtone');
const PROFILES = resolve(ARTIFACTS, 'profiles');
const DB_PATH = resolve(ARTIFACTS, 'family-phone-ringtone.sqlite');

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface PairedCaller {
  deviceId: number;
  conn: FamilyPhoneDeviceConnection;
}

async function pairCallerNode(apiUrl: string, token: string): Promise<PairedCaller> {
  const client = createEalClient(apiUrl, { token });
  const { userCode } = await client.startFamilyPhonePair();
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const { deviceId } = await client.completeFamilyPhonePair({
    userCode,
    publicKey: toBase64Url(spki),
    alg: 'ES256',
    label: "caller",
    kind: 'pwa',
  });
  const conn = await client.connectFamilyPhoneDevice({ deviceId, privateKey: kp.privateKey });
  return { deviceId, conn };
}

/**
 * Pair the puppeteer browser as a household device entirely via page-side
 * fetch + crypto.subtle, then save the resulting CryptoKey pair into
 * IndexedDB under the same shape keystore.ts uses, and reload so the
 * production devices-bootstrap rehydrates and opens the WS.
 */
async function pairAndConnectCalleeBrowser(args: {
  page: import('puppeteer').Page;
  apiUrl: string;
  token: string;
  label: string;
}): Promise<number> {
  const deviceId = await args.page.evaluate(
    async ({ token, label }: { token: string; label: string }) => {
      function b64url(bytes: Uint8Array): string {
        let s = '';
        for (const x of bytes) s += String.fromCharCode(x);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
      const startRes = await fetch('/api/family-phone/pair/start', { method: 'POST', headers, body: '{}' });
      const { user_code }: { user_code: string } = await startRes.json();
      const kp = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      );
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
      const completeRes = await fetch('/api/family-phone/pair/complete', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user_code,
          public_key: b64url(spki),
          alg: 'ES256',
          label,
          kind: 'pwa',
        }),
      });
      const { device_id }: { device_id: number } = await completeRes.json();
      // Persist to IndexedDB under the same shape keystore.ts uses.
      const dbReq = indexedDB.open('eal-family-phone', 1);
      await new Promise<void>((res, rej) => {
        dbReq.onupgradeneeded = () => {
          const db = dbReq.result;
          if (!db.objectStoreNames.contains('identity')) db.createObjectStore('identity');
        };
        dbReq.onsuccess = () => res();
        dbReq.onerror = () => rej(dbReq.error ?? new Error('idb open failed'));
      });
      const db = dbReq.result;
      await new Promise<void>((res, rej) => {
        const tx = db.transaction('identity', 'readwrite');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error ?? new Error('idb save failed'));
        tx.objectStore('identity').put(
          {
            deviceId: device_id,
            privateKey: kp.privateKey,
            publicKey: kp.publicKey,
            publicKeyB64: b64url(spki),
          },
          'device',
        );
      });
      db.close();
      return device_id;
    },
    { token: args.token, label: args.label },
  );
  // Reload onto /devices so the production bootstrap rehydrates and the
  // panel renders the badge that confirms the WS is open.
  await args.page.goto(`${args.apiUrl}/devices`, { waitUntil: 'networkidle0', timeout: 15_000 });
  // Confirm the WS connection by polling for the "Device #N" badge that
  // the devices panel renders only after bootstrap successfully loaded
  // and opened the WS.
  await waitFor(
    () => args.page.evaluate((id) =>
      document.body.innerText.includes(`Device #${id}`),
      deviceId,
    ),
    `devices panel "Device #${deviceId}" badge`,
  );
  return deviceId;
}

/**
 * Pre-page spies on the real browser Notification + AudioContext globals.
 * The recorded values land on window.__spy so puppeteer can read them
 * back after each step.
 */
function installBrowserSpies(): void {
  interface NotificationRecord {
    title: string;
    body: string | undefined;
    tag: string | undefined;
    closed: boolean;
  }
  const records: NotificationRecord[] = [];
  class SpyNotification {
    static readonly permission = 'granted' as const;
    static requestPermission(): Promise<NotificationPermission> {
      return Promise.resolve('granted');
    }
    private readonly record: NotificationRecord;
    constructor(title: string, opts?: NotificationOptions) {
      this.record = { title, body: opts?.body, tag: opts?.tag, closed: false };
      records.push(this.record);
    }
    close(): void {
      this.record.closed = true;
    }
  }
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    writable: true,
    value: SpyNotification,
  });

  let audioContextCount = 0;
  const OriginalAudioContext = window.AudioContext;
  class SpyAudioContext extends OriginalAudioContext {
    constructor(options?: AudioContextOptions) {
      super(options);
      audioContextCount += 1;
    }
  }
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    writable: true,
    value: SpyAudioContext,
  });

  window.__spy = {
    notifications: records,
    audioContextCount: () => audioContextCount,
  };
}

declare global {
  interface Window {
    __spy?: {
      notifications: { title: string; body: string | undefined; tag: string | undefined; closed: boolean }[];
      audioContextCount(): number;
    };
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(75);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function main(): Promise<void> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await rm(DB_PATH, { force: true });
  await mkdir(PROFILES, { recursive: true });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const api = await bootApi({ database: DB_PATH });
  console.log(`[e2e] api up at ${api.url}`);
  let browser: Browser | null = null;
  try {
    const seed = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'ringtone-e2e' });
    console.log(`[e2e] seeded user #${seed.userId}`);

    const caller = await pairCallerNode(api.url, seed.token);
    console.log(`[e2e] caller paired as device #${caller.deviceId}`);

    browser = await puppeteer.launch({
      userDataDir: PROFILES,
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const ctx = browser.defaultBrowserContext();
    await ctx.overridePermissions(api.url, ['notifications']);
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.evaluateOnNewDocument(installBrowserSpies);
    await page.evaluateOnNewDocument((seedToken: string) => {
      try { localStorage.setItem('eal-token', seedToken); } catch { /* ignore */ }
    }, seed.token);
    await page.goto(`${api.url}/`, { waitUntil: 'networkidle0', timeout: 15_000 });
    console.log(`[e2e] callee page loaded`);

    const calleeId = await pairAndConnectCalleeBrowser({
      page,
      apiUrl: api.url,
      token: seed.token,
      label: "callee",
    });
    console.log(`[e2e] callee paired as device #${calleeId}, WS connected`);

    // The call. Caller places, browser receives via real WS, real
    // installCallEventHandlers runs in the page, real Notification + real
    // AudioContext are constructed, spies record.
    const callerEvents: FamilyPhoneCallEvent[] = [];
    caller.conn.subscribe((e) => callerEvents.push(e));
    caller.conn.placeCall(calleeId);

    await waitFor(
      async () => (await page.evaluate(() => window.__spy?.notifications.length ?? 0)) >= 1,
      'the browser to fire a Notification',
    );
    const snapshot = await page.evaluate(() => ({
      notifications: window.__spy?.notifications ?? [],
      audioContextCount: window.__spy?.audioContextCount() ?? 0,
    }));
    if (snapshot.notifications.length !== 1) {
      throw new Error(`expected 1 notification, got ${snapshot.notifications.length}`);
    }
    const note = snapshot.notifications[0]!;
    if (note.title !== 'Incoming call') {
      throw new Error(`expected title 'Incoming call', got ${note.title}`);
    }
    // The body identifies the *caller* (the device that's calling US).
    if (!note.body?.includes('caller')) {
      throw new Error(`expected body to mention 'caller', got: ${note.body}`);
    }
    if (note.tag !== 'family-phone-incoming') {
      throw new Error(`expected tag family-phone-incoming, got: ${note.tag}`);
    }
    if (snapshot.audioContextCount < 1) {
      throw new Error('expected the ringtone to construct at least one AudioContext');
    }
    console.log(`[e2e] notification fired (title="${note.title}", body="${note.body}")`);
    console.log(`[e2e] audio contexts constructed: ${snapshot.audioContextCount}`);

    // Caller cancels — the browser should close the notification.
    const callId = callerEvents.find((e) => e.type === 'call:invite-ack');
    if (!callId || callId.type !== 'call:invite-ack') {
      throw new Error('caller never received invite-ack');
    }
    caller.conn.cancelCall(callId.callId);
    await waitFor(
      async () => (await page.evaluate(() => window.__spy?.notifications[0]?.closed ?? false)),
      'the notification to be closed after cancel',
    );
    console.log(`[e2e] cancel dismissed the notification`);

    caller.conn.close();
    console.log(`[e2e] OK — real call from a real client fired real ringtone + notification in a real browser`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await api.kill();
  }
}

// Force a deterministic exit: a live WS connection keeps a reconnect timer
// pending, so a bare `await main()` prints OK but never returns control. A
// verification artefact must exit 0 on success / 1 on failure so it can be
// run in one command and trusted.
main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
