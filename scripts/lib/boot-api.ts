import { spawn, type Subprocess } from 'bun';
import { createServer } from 'node:net';

export interface BootedApi {
  url: string;
  kill: () => Promise<void>;
}

/**
 * Ask the kernel for a free TCP port, then release it. There is a small
 * TOCTOU window before the api re-binds it, but for a local test harness it
 * is acceptable — and it lets us know the port *before* spawning so
 * EAL_ORIGIN can carry the real host:port. Binding the api directly on port
 * 0 would hide the port until the listen line is parsed, which left
 * EAL_ORIGIN (and therefore publicHost) stuck at the bogus `:0`.
 */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('pickFreePort: no numeric address')));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn the single api+SPA server, parse the EAL_API_LISTENING line from stdout,
 * and return the URL the harness should hit. A free port is reserved up front
 * (rather than binding on 0) so EAL_ORIGIN — and the publicHost the Twilio
 * trunk derives from it — reflects the real host:port. Multiple multi-process
 * scripts still run in parallel without clashing.
 */
export async function bootApi(
  opts: { port?: string; database?: string; hostname?: string; env?: Record<string, string> } = {},
): Promise<BootedApi> {
  const port = opts.port && opts.port !== '0' ? opts.port : String(await pickFreePort());
  // The server always reports itself as `localhost` (see EAL_API_LISTENING in
  // server.ts), and that is the host every script connects to. EAL_ORIGIN —
  // and the publicHost the Twilio trunk derives from it for X-Twilio-Signature
  // verification — must use the same host, or signed-over and reconstructed
  // URLs disagree (localhost vs 127.0.0.1) and every webhook 403s.
  const host = opts.hostname ?? 'localhost';
  const proc: Subprocess = spawn(['bun', 'packages/api/src/server.ts'], {
    env: {
      ...process.env,
      // The api process auto-loads `.env` itself, so a developer's own trunk
      // config would otherwise decide whether it boots for every script here —
      // and a half-filled one (`TWILIO_ENABLED=true` with the number still to
      // buy) stops it dead. Pin the trunk off. An explicit value set here wins
      // over `.env`, which never overwrites an inherited variable, so the PSTN
      // scripts turn it back on through `opts.env` below.
      TWILIO_ENABLED: 'false',
      PORT: port,
      DATABASE_PATH: opts.database ?? ':memory:',
      // The server requires EAL_ORIGIN (no fallback). It must match the
      // host:port the scripts actually hit so webhook signatures verify.
      EAL_ORIGIN: `https://${host}:${port}`,
      ...(opts.env ?? {}),
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const stdout = proc.stdout;
  if (typeof stdout === 'number' || stdout === undefined) {
    throw new Error('boot-api: stdout was not piped');
  }
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 5_000;
  let buf = '';

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    const match = buf.match(/EAL_API_LISTENING url=(https?:\/\/[^\s]+)/);
    if (match) {
      reader.releaseLock();
      // Optionally rewrite the host (e.g. 127.0.0.1 → localhost) for WebAuthn rpID matching.
      const rawUrl = match[1]!;
      const url = opts.hostname ? rawUrl.replace(/\/\/[^:/]+/, `//${opts.hostname}`) : rawUrl;
      return {
        url,
        kill: async (): Promise<void> => {
          proc.kill('SIGTERM');
          const handle = setTimeout(() => proc.kill('SIGKILL'), 2_000);
          await proc.exited;
          clearTimeout(handle);
        },
      };
    }
  }

  proc.kill('SIGKILL');
  throw new Error('boot-api: api did not print EAL_API_LISTENING within 5s');
}
