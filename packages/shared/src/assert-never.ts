/**
 * Exhaustiveness helper for discriminated unions and string-literal switches.
 * Place in the `default:` arm; if a new variant is added without a branch,
 * the call site fails to type-check because `value` is no longer `never`.
 */
export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
