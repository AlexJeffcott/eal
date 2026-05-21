import { spawn, which } from 'bun';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const CERTS_DIR = resolve(ROOT, 'packages/api/certs');
const CERT_PATH = resolve(CERTS_DIR, 'cert.pem');
const KEY_PATH = resolve(CERTS_DIR, 'key.pem');

const HOSTS = ['localhost', '127.0.0.1', '::1'];

async function run(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

async function generateWithMkcert(): Promise<boolean> {
  console.log('  using mkcert (preferred)');
  const result = await run([
    'mkcert',
    '-key-file', KEY_PATH,
    '-cert-file', CERT_PATH,
    ...HOSTS,
  ]);
  if (result.exitCode !== 0) {
    console.error('mkcert failed:');
    console.error(result.stderr || result.stdout);
    return false;
  }
  console.log('  certs written:');
  console.log(`    ${CERT_PATH}`);
  console.log(`    ${KEY_PATH}`);
  return true;
}

async function generateWithOpenssl(): Promise<boolean> {
  console.log('  using openssl (fallback — local browser will not trust this cert by default)');
  const sanLine = HOSTS.map((h) => (h.includes(':') || /^[0-9.]+$/.test(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
  const result = await run([
    'openssl', 'req',
    '-x509',
    '-newkey', 'rsa:4096',
    '-sha256',
    '-days', '365',
    '-nodes',
    '-keyout', KEY_PATH,
    '-out', CERT_PATH,
    '-subj', '/CN=localhost',
    '-addext', `subjectAltName=${sanLine}`,
  ]);
  if (result.exitCode !== 0) {
    console.error('openssl failed:');
    console.error(result.stderr || result.stdout);
    return false;
  }
  console.log('  certs written:');
  console.log(`    ${CERT_PATH}`);
  console.log(`    ${KEY_PATH}`);
  return true;
}

export async function sslCmd(args: string[]): Promise<number> {
  const force = args.includes('--force');

  if (!force && existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    console.log('devctl ssl: certs already present (use --force to regenerate)');
    console.log(`  ${CERT_PATH}`);
    console.log(`  ${KEY_PATH}`);
    return 0;
  }

  await mkdir(CERTS_DIR, { recursive: true });

  console.log('devctl ssl: generating local TLS certs');

  if (which('mkcert')) {
    return (await generateWithMkcert()) ? 0 : 1;
  }

  if (which('openssl')) {
    return (await generateWithOpenssl()) ? 0 : 1;
  }

  console.error('devctl ssl: neither mkcert nor openssl is installed.');
  console.error('  install mkcert (recommended): brew install mkcert nss && mkcert -install');
  console.error('  or install openssl: brew install openssl');
  return 1;
}
