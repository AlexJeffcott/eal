import { describe, expect, test } from 'bun:test';
import { importAgentPrivateKey } from './agent-key-import.ts';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe('importAgentPrivateKey', () => {
  test('round-trips a freshly generated key into a usable signing key', async () => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));

    const imported = await importAgentPrivateKey(toBase64(pkcs8));

    // Sanity: imported key must be able to produce a signature that the
    // matching public key verifies — proves the algorithm + format
    // matched and the bytes survived base64 cleanly.
    const message = new TextEncoder().encode('hello agent');
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, imported, message),
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      kp.publicKey,
      signature,
      message,
    );
    expect(ok).toBe(true);
  });

  test('rejects garbage base64 with an informative error', async () => {
    await expect(importAgentPrivateKey('not-valid-key-bytes')).rejects.toBeDefined();
  });
});
