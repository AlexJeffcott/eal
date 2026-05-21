import { createEalClient, type CliPairPollResult, type EalClient } from '@eal/client';
import { delay } from '@eal/shared';
import { writeToken, tokenPath } from '../lib/token-store.ts';
import { readStringFlag } from '../lib/split-args.ts';
import { log, logError } from '../lib/process.ts';
import type { GlobalOptions } from '../types.ts';

/**
 * Pure orchestration core, parallel to `authLoginCore` in auth.ts. Injects the
 * client + sleep + token-store hooks so tests can drive the poll loop without
 * a real timer or filesystem.
 */
export interface PairDeps {
  client: EalClient;
  writeToken: (token: string) => void;
  tokenPath: () => string;
  sleep: (ms: number) => Promise<void>;
  /** Emit progress lines to stdout. Suppressed by --json. */
  log: (line: string) => void;
}

export interface PairResult {
  code: number;
  message: string;
  isError: boolean;
}

const MAX_POLLS = 600; // hard upper bound; server-side TTL is 10 min so this is generous.

export async function authPairCore(
  deps: PairDeps,
  label: string | undefined,
): Promise<PairResult> {
  if (!label || label.trim().length === 0) {
    return {
      code: 1,
      isError: true,
      message: 'eal auth pair: --label=<label> is required (a human-readable name for this device)',
    };
  }

  let start;
  try {
    start = await deps.client.startCliPair();
  } catch (err) {
    return {
      code: 1,
      isError: true,
      message: `eal auth pair: could not start: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Carry the label in the URL so the browser form pre-fills it — same idea as
  // the server's `?code=`. The user already typed `--label` here; they
  // shouldn't have to type it again in the browser.
  const verifyUrl = new URL(start.verificationUrl);
  verifyUrl.searchParams.set('label', label.trim());

  // Primary path: the link has the code AND the label baked in, so the browser
  // form is fully pre-filled — the user just clicks Pair. The bare code is only
  // a fallback for pairing from a device that can't open the terminal's link.
  deps.log(`eal auth pair: open this link to authorize "${label.trim()}":`);
  deps.log(`  ${verifyUrl.href}`);
  deps.log('');
  deps.log('  Pairing from another device? Open');
  deps.log(`    ${verifyUrl.origin}${verifyUrl.pathname}`);
  deps.log(`  and enter code ${start.userCode}`);
  deps.log(`(code expires at ${start.expiresAt}; polling every ${start.pollIntervalMs}ms)`);

  for (let i = 0; i < MAX_POLLS; i++) {
    let result: CliPairPollResult;
    try {
      result = await deps.client.pollCliPair({ deviceCode: start.deviceCode });
    } catch (err) {
      return {
        code: 1,
        isError: true,
        message: `eal auth pair: poll failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (result.status === 'expired') {
      return {
        code: 1,
        isError: true,
        message: 'eal auth pair: the pairing code expired before it was authorized — run `eal auth pair` again',
      };
    }
    if (result.status === 'authorized') {
      deps.writeToken(result.token);
      return {
        code: 0,
        isError: false,
        message: `eal auth pair: paired as ${result.user.displayName} (token at ${deps.tokenPath()}, label=${label.trim()})`,
      };
    }
    await deps.sleep(start.pollIntervalMs);
  }

  return {
    code: 1,
    isError: true,
    message: 'eal auth pair: gave up after too many polls — the server may be unreachable',
  };
}

function realDeps(global: GlobalOptions): PairDeps {
  const client = createEalClient(global.apiUrl);
  const path = global.tokenPathOverride;
  return {
    client,
    writeToken: (t) => writeToken(t, path),
    tokenPath: () => tokenPath(path),
    sleep: delay,
    log,
  };
}

function emit(result: PairResult): number {
  if (result.isError) logError(result.message);
  else log(result.message);
  return result.code;
}

/** Dispatcher: `eal auth pair`. Routed from `authCommand` in auth.ts. */
export async function authPairCommand(global: GlobalOptions): Promise<number> {
  const label = readStringFlag(global.commandArgs, 'label');
  return emit(await authPairCore(realDeps(global), label));
}
