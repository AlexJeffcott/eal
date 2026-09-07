#!/usr/bin/env bun
/**
 * Regression guard: every control is one height and one corner.
 *
 * polly defines `--polly-control-height-sm/md/lg` and `--polly-control-radius`
 * as the single source of truth for how tall an interactive control is and how
 * its corner is cut. The failure this script exists to catch is a control that
 * sizes itself from font size plus padding instead, which looks correct on its
 * own and only reads wrong beside its neighbours.
 *
 * It has happened twice, and neither time did a test fail:
 *
 *   1. In polly through 0.87.0 the ladder existed and nothing read it. One row
 *      of the showcase held five different heights — Button 37.19px, Select
 *      trigger 40px, TextInput 42px, Dropdown trigger 42px, FileInput 54px —
 *      and buttons cornered at 4px against the fields' 8px (polly#179).
 *   2. eal's own `.showcase-dropdown-trigger` sized itself from padding and
 *      took `--polly-radius-sm`. When polly 0.88.0 moved every other control
 *      onto the ladder, that one measured 42px / 4px against everything
 *      else's 40px / 8px.
 *
 * The second is the case this script guards, because it is the one eal owns.
 * A consumer-dressed control (polly's Dropdown ships a bare trigger by design,
 * so eal supplies the chrome) has to opt into the contract by hand, and
 * nothing but a measurement notices when it does not.
 *
 * The assertions compare each control against the token value the page
 * resolves, not against a literal 40px, so polly re-cutting the ladder moves
 * the expectation with it. A token that resolves empty is its own failure:
 * that means the bundle lost polly's theme.css rather than that the ladder
 * changed.
 *
 * Runs at 350px and 900px, in both colour schemes: the user's small phone is
 * the hard floor, and a control that only lines up on a desktop has not lined
 * up.
 *
 *   bun scripts/e2e-control-geometry.ts
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi } from './lib/boot-api.ts';
import { NAV_TIMEOUT_MS } from './lib/e2e-config.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/control-geometry');
const PROFILE = resolve(ARTIFACTS, 'profile');
const DB_PATH = resolve(ARTIFACTS, 'control-geometry.sqlite');

/** The two viewports. 350px is the floor; 900px is where the grid opens up. */
const VIEWPORTS = [
  { name: '350', width: 350, height: 900 },
  { name: '900', width: 900, height: 1000 },
] as const;

/**
 * One probe per control the contract covers, anchored to the showcase section
 * that renders it. `radius` is false where a square corner is the design:
 * a Tab sits on a rule and is not a boxed control.
 */
interface Probe {
  name: string;
  selector: string;
  /** The height token the control must match. */
  heightToken: string;
  /** Whether the corner is under the shared-radius contract. */
  radius: boolean;
}

const PROBES: readonly Probe[] = [
  // polly's own controls. If these drift, the fault is upstream.
  { name: 'Button (normal)', selector: '#button button', heightToken: '--polly-control-height-md', radius: true },
  { name: 'TextInput', selector: '#text-input input', heightToken: '--polly-control-height-md', radius: true },
  { name: 'Select trigger', selector: '#select button', heightToken: '--polly-control-height-md', radius: true },
  { name: 'Tab', selector: '#tabs button', heightToken: '--polly-control-height-md', radius: false },
  // eal's own dressed control. polly's Dropdown ships a bare trigger by
  // design — Select and ActionSelect supply their own chrome — so this one
  // opts into the ladder in `showcase.css` and nothing upstream enforces it.
  { name: 'Dropdown trigger (eal-dressed)', selector: '#dropdown button', heightToken: '--polly-control-height-md', radius: true },
];

interface Measurement {
  name: string;
  found: boolean;
  height: number;
  radius: string;
}

interface Reading {
  tokens: Record<string, string>;
  controls: Measurement[];
  /** Every button in the size section, in document order. */
  buttonSizes: number[];
  checkboxHeight: number | null;
  horizontalOverflowPx: number;
}

/** `2.5rem` and `8px` as the page computes them, in px, for comparison. */
function toPx(value: string, rootFontSizePx: number): number | null {
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem?.[1] !== undefined) return Number(rem[1]) * rootFontSizePx;
  const px = /^([\d.]+)px$/.exec(value);
  if (px?.[1] !== undefined) return Number(px[1]);
  return null;
}

async function read(page: Page, probes: readonly Probe[]): Promise<Reading> {
  return page.evaluate((selectors: Probe[]) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const tokens: Record<string, string> = {};
    for (const name of [
      '--polly-control-height-sm',
      '--polly-control-height-md',
      '--polly-control-height-lg',
      '--polly-control-radius',
      '--polly-checkbox-size',
    ]) {
      tokens[name] = rootStyle.getPropertyValue(name).trim();
    }
    tokens['root-font-size'] = rootStyle.fontSize;

    const round = (n: number) => Math.round(n * 100) / 100;
    const controls = selectors.map((probe) => {
      const el = document.querySelector(probe.selector);
      if (el === null) return { name: probe.name, found: false, height: 0, radius: '' };
      return {
        name: probe.name,
        found: true,
        height: round(el.getBoundingClientRect().height),
        radius: getComputedStyle(el).borderTopLeftRadius,
      };
    });

    // Every button in the section, not the size row by position: the check
    // below asks whether each rung of the ladder has a button standing on it,
    // which stays true if the section gains or loses a specimen.
    const buttons = document.querySelectorAll('#button button');
    const buttonSizes = [...buttons].map((el) => round(el.getBoundingClientRect().height));

    const checkbox = document.querySelector('#checkbox input[type=checkbox]');

    return {
      tokens,
      controls,
      buttonSizes,
      checkboxHeight: checkbox === null ? null : round(checkbox.getBoundingClientRect().height),
      horizontalOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
    // `page.evaluate` serialises its argument, so the probes cross as a fresh
    // mutable array rather than the readonly const.
  }, probes.map((probe) => ({ ...probe })));
}

function check(failures: string[], label: string, reading: Reading): void {
  const rootFontSizePx = toPx(reading.tokens['root-font-size'] ?? '', 16) ?? 16;

  // A token that resolves empty means the bundle lost polly's theme.css. That
  // is a different fault from a control drifting, so it is named differently.
  for (const [name, value] of Object.entries(reading.tokens)) {
    if (value === '') failures.push(`${label}: ${name} resolves empty — the bundle is missing polly's theme.css`);
  }

  const expectedHeights = new Map<string, number | null>();
  for (const probe of PROBES) {
    expectedHeights.set(probe.heightToken, toPx(reading.tokens[probe.heightToken] ?? '', rootFontSizePx));
  }
  const expectedRadius = reading.tokens['--polly-control-radius'] ?? '';

  for (const probe of PROBES) {
    const m = reading.controls.find((c) => c.name === probe.name);
    if (m === undefined || !m.found) {
      failures.push(`${label}: ${probe.name} did not render — the probe selector \`${probe.selector}\` matched nothing`);
      continue;
    }
    const want = expectedHeights.get(probe.heightToken);
    if (want === null || want === undefined) {
      failures.push(`${label}: ${probe.heightToken} is ${JSON.stringify(reading.tokens[probe.heightToken])}, which this script cannot convert to px`);
    } else if (m.height !== want) {
      failures.push(`${label}: ${probe.name} is ${m.height}px, want ${want}px from ${probe.heightToken}`);
    }
    if (probe.radius && m.radius !== expectedRadius) {
      failures.push(`${label}: ${probe.name} corner is ${m.radius}, want ${expectedRadius} from --polly-control-radius`);
    }
  }

  // Three sizes must land on three rungs. Measuring the set rather than each
  // button by position keeps this honest if the section gains a specimen.
  const rungs = (['--polly-control-height-sm', '--polly-control-height-md', '--polly-control-height-lg'] as const)
    .map((t) => toPx(reading.tokens[t] ?? '', rootFontSizePx))
    .filter((n): n is number => n !== null);
  const boxHeights = new Set(reading.buttonSizes.filter((h) => h > 0));
  for (const rung of rungs) {
    if (!boxHeights.has(rung)) {
      failures.push(`${label}: no button measures ${rung}px — the size ladder has a rung nothing lands on (measured ${[...boxHeights].sort((a, b) => a - b).join(', ')})`);
    }
  }

  const wantCheckbox = toPx(reading.tokens['--polly-checkbox-size'] ?? '', rootFontSizePx);
  if (reading.checkboxHeight === null) {
    failures.push(`${label}: the Checkbox specimen did not render`);
  } else if (wantCheckbox !== null && reading.checkboxHeight !== wantCheckbox) {
    failures.push(`${label}: checkbox box is ${reading.checkboxHeight}px, want ${wantCheckbox}px from --polly-checkbox-size`);
  }

  if (reading.horizontalOverflowPx > 0) {
    failures.push(`${label}: the document overflows ${reading.horizontalOverflowPx}px sideways`);
  }
}

async function main(): Promise<number> {
  // The api serves HTTPS from packages/api/certs, which no CA in this process
  // signs. Every other e2e script sets this the same way.
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });

  const seed = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'control-geometry-seed' });
  const api = await bootApi({ database: DB_PATH, hostname: 'localhost' });
  let browser: Browser | undefined;
  const failures: string[] = [];
  let measured = 0;

  try {
    browser = await puppeteer.launch({
      userDataDir: PROFILE,
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    page.on('pageerror', (e: unknown) => {
      console.error('  [pageerror]', e instanceof Error ? e.message : String(e));
    });
    await page.evaluateOnNewDocument((token: string) => {
      try {
        localStorage.setItem('eal-token', token);
      } catch {
        /* ignore */
      }
    }, seed.token);

    for (const scheme of ['light', 'dark'] as const) {
      for (const viewport of VIEWPORTS) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
        await page.setViewport({ width: viewport.width, height: viewport.height });
        await page.goto(`${api.url}/showcase`, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
        await page.waitForSelector('#tabs button', { timeout: NAV_TIMEOUT_MS });
        const label = `${scheme} @ ${viewport.name}px`;
        check(failures, label, await read(page, PROBES));
        measured += PROBES.length;
      }
    }

    if (failures.length > 0) {
      console.error('e2e-control-geometry: FAILED');
      for (const f of failures) console.error(`  - ${f}`);
      return 1;
    }
    console.log(`e2e-control-geometry: ${measured} control measurement(s) across ${VIEWPORTS.length * 2} scheme/viewport combinations`);
    console.log('e2e-control-geometry: every control reads the height ladder and the shared corner');
    return 0;
  } finally {
    await browser?.close();
    await api.kill();
  }
}

process.exit(await main());
