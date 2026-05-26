/**
 * Decode a base64-encoded PKCS8 ECDSA P-256 private key from the agent
 * device record and import it as a non-extractable signing CryptoKey
 * suitable for `connectFamilyPhoneDevice`.
 */
export async function importAgentPrivateKey(b64: string): Promise<CryptoKey> {
  const bytes = fromBase64(b64);
  return crypto.subtle.importKey(
    'pkcs8',
    bytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const out = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}
