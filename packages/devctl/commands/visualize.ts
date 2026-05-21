import { spawn } from 'bun';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

export async function visualizeCmd(args: string[]): Promise<number> {
  const proc = spawn(['bunx', 'polly', 'visualize', ...args], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  return await proc.exited;
}
