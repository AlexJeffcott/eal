import { createEalClient, type EalClient } from '@eal/client';
import { deleteToken, readToken, tokenPath, writeToken } from '../lib/token-store.ts';
import { readStringFlag } from '../lib/split-args.ts';
import { log, logError } from '../lib/process.ts';
import type { GlobalOptions } from '../types.ts';

/**
 * Pure orchestration cores. Each takes an injected `EalClient` (real in prod,
 * mock in tests) and pure store hooks. Returns a structured result so tests
 * can assert on it without parsing console output.
 */

export interface AuthDeps {
  client: EalClient;
  writeToken: (token: string) => void;
  deleteToken: () => boolean;
  readToken: () => string | null;
  tokenPath: () => string;
}

export interface AuthResult {
  code: number;
  message: string;
  isError: boolean;
}

export async function authLoginCore(deps: AuthDeps, token: string | undefined): Promise<AuthResult> {
  if (!token || token.length === 0) {
    return { code: 1, isError: true, message: 'eal auth login: --token=<token> is required' };
  }
  try {
    const me = await deps.client.getCurrentUser();
    if (!me) {
      return { code: 1, isError: true, message: 'eal auth login: token rejected by api' };
    }
    deps.writeToken(token);
    return {
      code: 0,
      isError: false,
      message: `eal auth login: signed in as ${me.displayName} (token at ${deps.tokenPath()})`,
    };
  } catch (err) {
    return {
      code: 1,
      isError: true,
      message: `eal auth login: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function authStatusCore(deps: AuthDeps): Promise<AuthResult> {
  const token = deps.readToken();
  if (!token) {
    return { code: 0, isError: false, message: 'eal auth status: not signed in' };
  }
  const me = await deps.client.getCurrentUser().catch(() => null);
  if (!me) {
    return { code: 1, isError: false, message: 'eal auth status: stored token is invalid or expired' };
  }
  return { code: 0, isError: false, message: `eal auth status: signed in as ${me.displayName}` };
}

export async function authLogoutCore(deps: AuthDeps): Promise<AuthResult> {
  const token = deps.readToken();
  if (!token) {
    return { code: 0, isError: false, message: 'eal auth logout: not signed in' };
  }
  await deps.client.signOut().catch(() => {});
  const deleted = deps.deleteToken();
  return {
    code: 0,
    isError: false,
    message: `eal auth logout: ${deleted ? 'signed out' : 'no local token to remove'}`,
  };
}

function realDeps(global: GlobalOptions, token?: string): AuthDeps {
  const client = createEalClient(global.apiUrl, token ? { token } : {});
  const path = global.tokenPathOverride;
  return {
    client,
    writeToken: (t) => writeToken(t, path),
    deleteToken: () => deleteToken(path),
    readToken: () => readToken(path),
    tokenPath: () => tokenPath(path),
  };
}

function emit(result: AuthResult): number {
  if (result.isError) logError(result.message);
  else log(result.message);
  return result.code;
}

/** Dispatcher: `eal auth <subcommand>`. */
export async function authCommand(global: GlobalOptions): Promise<number> {
  const [sub, ...rest] = global.commandArgs;
  const subArgs = { ...global, commandArgs: rest };

  switch (sub) {
    case 'login': {
      const token = readStringFlag(subArgs.commandArgs, 'token');
      return emit(await authLoginCore(realDeps(subArgs, token), token));
    }
    case 'status': {
      const stored = readToken(subArgs.tokenPathOverride);
      return emit(await authStatusCore(realDeps(subArgs, stored ?? undefined)));
    }
    case 'logout': {
      const stored = readToken(subArgs.tokenPathOverride);
      return emit(await authLogoutCore(realDeps(subArgs, stored ?? undefined)));
    }
    case 'pair': {
      const { authPairCommand } = await import('./pair.ts');
      return authPairCommand(subArgs);
    }
    default:
      logError(`eal auth: unknown subcommand "${sub ?? ''}"`);
      logError('  expected: login | status | logout | pair');
      return 1;
  }
}
