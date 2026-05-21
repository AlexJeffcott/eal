import { spawn, type Subprocess } from 'bun';

export interface BootedApi {
  url: string;
  kill: () => Promise<void>;
}

/**
 * Spawn the single api+SPA server, parse the EAL_API_LISTENING line from stdout,
 * and return the URL the harness should hit. The api binds on port 0 (kernel-
 * assigned), so multiple multi-process scripts can run in parallel without
 * clashing.
 */
export async function bootApi(opts: { port?: string; database?: string; hostname?: string } = {}): Promise<BootedApi> {
  const port = opts.port ?? '0';
  const host = opts.hostname ?? '127.0.0.1';
  const proc: Subprocess = spawn(['bun', 'packages/api/src/server.ts'], {
    env: {
      ...process.env,
      PORT: port,
      DATABASE_PATH: opts.database ?? ':memory:',
      // The server requires EAL_ORIGIN (no fallback). For WebAuthn-exercising
      // scripts the origin must match the host:port the browser actually hits —
      // those pass hostname='localhost' and a fixed port, so this lines up.
      EAL_ORIGIN: `https://${host}:${port}`,
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
