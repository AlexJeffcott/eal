import { createHash } from 'node:crypto';

export function sha256(input: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}
