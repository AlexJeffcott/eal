/** Output helpers — prefix-decorated info/warn/error/success lines. */
import { log } from './log.ts';

export function success(message: string): void {
  log.info(`ok  ${message}`);
}

export function error(message: string): void {
  log.error(`err ${message}`);
}

export function info(message: string): void {
  log.info(`--  ${message}`);
}

export function warn(message: string): void {
  log.warn(`!!  ${message}`);
}
