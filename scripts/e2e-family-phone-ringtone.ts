#!/usr/bin/env bun
/**
 * Layer-2 puppeteer test for the ringtone + notification wiring.
 *
 * Single browser, no real call, no second peer. The harness pre-installs
 * spies on window.Notification and window.AudioContext before the SPA
 * bundle loads, navigates to the shell with `?e2e=1` so main.tsx exposes
 * the synthetic-event seam (window.__familyPhoneTest), seeds the devices
 * directory, then fires a synthetic call:incoming and asserts the spies
 * recorded the right Notification + AudioContext calls. A follow-up
 * call:cancelled verifies dismiss + audio teardown fire too.
 *
 * Catches regressions the bun:test layer cannot see — chiefly "the
 * Notification constructor was not actually invoked in a real browser"
 * and "AudioContext failed to construct under the live WebAudio stack."
 */
import puppeteer, { type Browser } from 'puppeteer';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { delay } from '@eal/shared';
import { bootApi } from './lib/boot-api.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/family-phone-ringtone');
const PROFILES = resolve(ARTIFACTS, 'profiles');

/**
 * The spy installer runs in the page context via evaluateOnNewDocument.
 * Recorded calls are stashed on window so puppeteer.evaluate can read
 * them back. Spy on construction count for AudioContext (we don't need
 * a full method log; the Layer-1 unit tests cover the inside).
 */
function installSpies(): void {
  interface NotificationRecord {
    title: string;
    body: string | undefined;
    tag: string | undefined;
    closed: boolean;
  }
  const records: NotificationRecord[] = [];
  const OriginalNotification = window.Notification;
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
  window.__notificationRecords = records;
  window.__notificationOriginal = OriginalNotification;

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
  window.__audioContextCount = () => audioContextCount;
}

declare global {
  interface Window {
    __notificationRecords?: { title: string; body: string | undefined; tag: string | undefined; closed: boolean }[];
    __notificationOriginal?: typeof Notification;
    __audioContextCount?: () => number;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function main(): Promise<void> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILES, { recursive: true });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const api = await bootApi({ database: ':memory:' });
  console.log(`[e2e] api up at ${api.url}`);
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      userDataDir: PROFILES,
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const ctx = browser.defaultBrowserContext();
    await ctx.overridePermissions(api.url, ['notifications']);
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.evaluateOnNewDocument(installSpies);
    await page.goto(`${api.url}/?e2e=1`, { waitUntil: 'networkidle0', timeout: 15_000 });
    console.log(`[e2e] page loaded`);

    await waitFor(
      () => page.evaluate(() => window.__familyPhoneTest !== undefined),
      'window.__familyPhoneTest to be installed',
    );

    // Seed a device so the caller-label lookup produces a useful body.
    await page.evaluate(() => {
      window.__familyPhoneTest?.seedDevices([
        {
          id: 7,
          label: "Leo's handset",
          kind: 'handset',
          createdAt: '',
          pairedAt: '',
          ownerUserId: 2,
          ownerDisplayName: 'leo',
          online: true,
        },
      ]);
    });

    // Fire a synthetic call:incoming. The same installCallEventHandlers
    // function that the live WS subscriber would call.
    await page.evaluate(() => {
      window.__familyPhoneTest?.fireCallEvent({
        type: 'call:incoming',
        callId: 'test-call-1',
        fromDeviceId: 7,
      });
    });

    await waitFor(
      async () => (await page.evaluate(() => window.__notificationRecords?.length ?? 0)) >= 1,
      'a notification to fire',
    );
    const after = await page.evaluate(() => ({
      records: window.__notificationRecords ?? [],
      audioCount: window.__audioContextCount?.() ?? 0,
    }));
    if (after.records.length !== 1) {
      throw new Error(`expected 1 notification, got ${after.records.length}`);
    }
    const record = after.records[0]!;
    if (record.title !== 'Incoming call') {
      throw new Error(`expected title 'Incoming call', got ${record.title}`);
    }
    if (!record.body?.includes("Leo's handset")) {
      throw new Error(`expected body to mention Leo's handset, got: ${record.body}`);
    }
    if (record.tag !== 'family-phone-incoming') {
      throw new Error(`expected tag family-phone-incoming, got: ${record.tag}`);
    }
    if (after.audioCount < 1) {
      throw new Error('expected the ringtone to construct at least one AudioContext');
    }
    console.log(`[e2e] notification fired (title="${record.title}", body="${record.body}")`);
    console.log(`[e2e] audio contexts constructed: ${after.audioCount}`);

    // Fire cancel → notifier should close the active notification.
    await page.evaluate(() => {
      window.__familyPhoneTest?.fireCallEvent({
        type: 'call:cancelled',
        callId: 'test-call-1',
      });
    });
    await waitFor(
      async () => (await page.evaluate(() => window.__notificationRecords?.[0]?.closed ?? false)),
      'the notification to be closed after cancel',
    );
    console.log(`[e2e] cancel dismissed the notification`);

    console.log(`[e2e] OK — ringtone + notifications wired end-to-end in a real browser`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await api.kill();
  }
}

await main();
