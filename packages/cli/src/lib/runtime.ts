/**
 * Build-time constants baked into the CLI bundle.
 *
 * `packages/cli/build.ts` (when added) replaces these identifiers via
 * Bun.build's `define` option. When running the source directly with
 * `bun packages/cli/src/index.ts` the identifiers are undefined and the
 * typeof guards fall through to development defaults.
 */

declare const __EAL_CLI_BIN__: string | undefined;
declare const __EAL_CLI_VERSION__: string | undefined;
declare const __EAL_CLI_API_URL__: string | undefined;

export const BIN_NAME: string = typeof __EAL_CLI_BIN__ === 'undefined' ? 'eal' : __EAL_CLI_BIN__;

export const CLI_VERSION: string = typeof __EAL_CLI_VERSION__ === 'undefined' ? 'dev' : __EAL_CLI_VERSION__;

export const BAKED_API_URL: string | undefined =
  typeof __EAL_CLI_API_URL__ === 'undefined' ? undefined : __EAL_CLI_API_URL__;

export const DEFAULT_API_URL: string = BAKED_API_URL ?? 'https://127.0.0.1:3000';

export const CONFIG_DIR_NAME = `.${BIN_NAME}`;
