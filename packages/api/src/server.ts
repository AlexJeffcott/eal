import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createDb, type DatabaseClient } from './db/client.ts';
import { getPrincipal } from './auth/principals.ts';
import { createAppInternal } from './server-factory.ts';

export { type App } from './server-factory.ts';

const CERTS_DIR = resolve(import.meta.dir, '../certs');
const CERT_PATH = resolve(CERTS_DIR, 'cert.pem');
const KEY_PATH = resolve(CERTS_DIR, 'key.pem');

/**
 * DATABASE_PATH is required — there is no default. A file path gives a
 * persistent DB (and is what Litestream replicates); `:memory:` is a valid
 * explicit choice for an ephemeral in-process DB. Either way the operator
 * states it; the server never guesses. `bun devctl setup` writes one to .env.
 */
function resolveDatabasePath(): string {
  const path = process.env['DATABASE_PATH'];
  if (path === undefined || path === '') {
    throw new Error(
      'EAL_API: DATABASE_PATH is not set. The server requires an explicit database path —\n' +
        '  a file for persistence, or DATABASE_PATH=:memory: for an ephemeral in-process DB.\n' +
        '  Run `bun devctl setup` to write one into .env.',
    );
  }
  return path;
}

export function createApp(db: DatabaseClient) {
  return createAppInternal(db, (request) => getPrincipal(request, db));
}

export const app = await createApp(createDb(resolveDatabasePath()));

/**
 * TLS handling. The server binds plaintext only when SKIP_TLS=1 — two cases
 * legitimately use that: the unit tier (no network involved), and production
 * behind a platform proxy (Fly) that terminates TLS at its edge and
 * forwards plain HTTP to the container. Every other configuration — local dev,
 * e2e, multi-process — requires real certs and refuses to start without them.
 */
function resolveTls(): { tls: { cert: ReturnType<typeof Bun.file>; key: ReturnType<typeof Bun.file> } } | { plaintext: true } {
  if (process.env['SKIP_TLS'] === '1') return { plaintext: true };
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
    throw new Error(
      `EAL_API: TLS certs not found at ${CERTS_DIR}.\n` +
        '  Run `bun devctl ssl` to generate them, or set SKIP_TLS=1 for unit tests or for\n' +
        '  a deployment whose platform proxy terminates TLS.',
    );
  }
  return { tls: { cert: Bun.file(CERT_PATH), key: Bun.file(KEY_PATH) } };
}

/**
 * PORT is required — there is no default. Booting a network service should be
 * an explicit decision about which port it occupies, not a guess. Mirrors the
 * TLS hard-requirement above: misconfiguration fails loud at boot.
 */
function resolvePort(): number {
  const portEnv = process.env['PORT'];
  if (portEnv === undefined || portEnv === '') {
    throw new Error(
      'EAL_API: PORT is not set. The server requires an explicit port — there is no default.\n' +
        '  Run e.g. `PORT=4321 bun devctl dev`.',
    );
  }
  const port = Number(portEnv);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`EAL_API: PORT="${portEnv}" is not a valid port (expected an integer 0-65535).`);
  }
  return port;
}

async function bootServer(): Promise<void> {
  const tlsResolution = resolveTls();
  const port = resolvePort();

  const server = 'tls' in tlsResolution
    ? app.listen({ port, tls: tlsResolution.tls })
    : app.listen({ port });

  const actualPort = server.server?.port ?? port;
  const scheme = 'tls' in tlsResolution ? 'https' : 'http';
  // `localhost`, not `127.0.0.1`: it's the host WebAuthn requires as the RP ID
  // and the host the SPA's TLS cert is issued for. The two resolve to the same
  // socket, but only `localhost` works for the passkey flow.
  console.log(`EAL_API_LISTENING url=${scheme}://localhost:${actualPort}`);
}

if (import.meta.main) {
  await bootServer();
}
