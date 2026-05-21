/**
 * Process facades for CLI commands. Wraps process.exit and stdout/stderr
 * so tests can spy on them without stubbing globals.
 */
import { log as logger } from './log.ts';

export function exit(code: number): never {
  process.exit(code);
}

export function log(...args: unknown[]): void {
  logger.info(...args);
}

export function logError(...args: unknown[]): void {
  logger.error(...args);
}
