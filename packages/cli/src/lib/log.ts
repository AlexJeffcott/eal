/** Thin logging facade over console — single seam for mocking/spying in tests. */
export const log = {
  info: (...args: unknown[]): void => console.log(...args),
  warn: (...args: unknown[]): void => console.warn(...args),
  error: (...args: unknown[]): void => console.error(...args),
};
