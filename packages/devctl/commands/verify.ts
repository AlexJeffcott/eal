import { spawn, which } from 'bun';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

const EXIT_DOCKER_MISSING = 2;

async function dockerRunning(): Promise<boolean> {
  if (!which('docker')) return false;
  const proc = spawn(['docker', 'info'], { stdout: 'pipe', stderr: 'pipe' });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const code = await proc.exited;
  return code === 0;
}

export async function verifyCmd(args: string[]): Promise<number> {
  if (!(await dockerRunning())) {
    console.error('devctl verify: Docker is required for TLC model-checking.');
    console.error('  Install Docker Desktop, start it, and rerun.');
    console.error('  https://www.docker.com/products/docker-desktop');
    return EXIT_DOCKER_MISSING;
  }

  const proc = spawn(['bunx', 'polly', 'verify', ...args], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  return await proc.exited;
}
