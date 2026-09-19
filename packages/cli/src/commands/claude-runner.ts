import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Message } from '@eal/client';
import { log } from '../lib/process.ts';
import { EAL_TOOLS } from './mcp.ts';

/**
 * One chat request for the runner to answer.
 *  - `sessionId` set → resume that Claude session, sending only the newest turn.
 *  - `sessionId` null → seed a fresh session from `conversation` (recent history).
 */
export interface ChatRunInput {
  conversation: Message[];
  sessionId: string | null;
}

/**
 * The answer. `sessionId` is the Claude session the reply came from — the
 * existing one on a resume, or a freshly minted one when the runner had to
 * seed (cold start, or recovery after a lost session). The caller persists it.
 */
export interface ChatRunResult {
  content: string;
  sessionId: string;
}

/**
 * A ClaudeRunner answers one chat request, calling `emit` with each streamed
 * text delta and resolving with the reply plus the session it used.
 *
 * This is the seam between the agent daemon and Claude. The daemon and the
 * request-handling core depend only on this type — `agent.test.ts` injects a
 * scripted fake, and `createClaudeRunner` below drives the real `claude` CLI.
 */
export type ClaudeRunner = (
  input: ChatRunInput,
  emit: (delta: string) => void,
) => Promise<ChatRunResult>;

export interface ClaudeRunnerOptions {
  /** The eal API base URL the spawned `eal mcp` tool server should talk to. */
  apiUrl: string;
  /** The eal token file path the spawned `eal mcp` tool server should read. */
  tokenPath: string;
}

const SYSTEM_PROMPT = [
  'You are the eal household assistant for the Jeffcott family (Elisa, Alex, and Leo).',
  'You help them manage shared and personal tasks.',
  '',
  'You have tools to list, read, create, update, complete, and reopen tasks.',
  'You CANNOT delete tasks — if asked to remove something, complete it instead, or',
  'tell the person to delete it themselves in the web app.',
  '',
  'Be warm but concise: a sentence or two. After you change a task, confirm what',
  'you did in one short line. When a request is ambiguous, make a sensible choice',
  'and say what you assumed rather than asking a follow-up question.',
].join('\n');

/** Fully-qualified MCP tool names — the auto-approve allowlist for `claude`. */
const EAL_TOOL_NAMES = EAL_TOOLS.map((t) => `mcp__eal__${t.name}`);

/** How long to wait for one `claude` invocation before giving up. */
const CLAUDE_TIMEOUT_MS = 150_000;

/**
 * The model every assistant turn runs on.
 *
 * Pinned rather than left to the CLI's default: an unpinned model changes
 * under the household as Claude Code's default moves, and with it the reply
 * style, the latency and the cost of a turn. Sonnet is the choice for this
 * work — the tasks are short, the tool set is six calls wide, and the
 * conversation is a household one, not a reasoning problem.
 *
 * Use the exact id, not the `sonnet` alias: the alias follows the newest
 * Sonnet, which is the drift this constant exists to stop.
 */
const CLAUDE_MODEL = 'claude-sonnet-5';

/**
 * A stable working directory for the agent's `claude` invocations. Claude Code
 * keys its session storage by cwd, so this must be fixed for `--resume` to find
 * earlier sessions across separate `claude --print` processes. It is kept empty
 * (no CLAUDE.md) so the agent picks up no stray project context.
 */
function sessionWorkdir(): string {
  return join(homedir(), '.config', 'eal', 'agent-sessions');
}

/** Render a conversation into a seed prompt for a fresh `claude` session. */
export function buildPrompt(conversation: Message[]): string {
  const lines: string[] = [];
  for (const message of conversation) {
    const who = message.role === 'user' ? 'Household member' : 'Assistant';
    lines.push(`${who}: ${message.content}`);
  }
  lines.push('');
  lines.push('Respond to the most recent household member message above.');
  return lines.join('\n');
}

/** The newest turn — the prompt sent when resuming an existing session. */
export function latestUserMessage(conversation: Message[]): string {
  const last = conversation[conversation.length - 1];
  return last ? last.content : '';
}

/** The `claude` argv. `session` selects between resuming and seeding. */
export function buildClaudeArgs(
  mcpConfigJson: string,
  session: { mode: 'create' | 'resume'; id: string },
): string[] {
  return [
    '--print',
    '--model', CLAUDE_MODEL,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'default',
    session.mode === 'resume' ? '--resume' : '--session-id', session.id,
    '--tools', '', // disable every built-in tool — only the eal MCP tools remain
    '--mcp-config', mcpConfigJson,
    '--strict-mcp-config',
    '--allowedTools', EAL_TOOL_NAMES.join(','),
    '--system-prompt', SYSTEM_PROMPT,
  ];
}

export interface ParsedStreamLine {
  /** Text the assistant produced in this event — relay it as a chunk. */
  delta?: string;
  /** The final, complete reply text (from the terminal `result` event). */
  final?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse one line of `claude --output-format stream-json`. Returns the assistant
 * text from an `assistant` event, or the final text from the `result` event;
 * `null` for everything else (system/init, tool results, blank lines).
 */
export function parseStreamJsonLine(line: string): ParsedStreamLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(event)) return null;

  if (event['type'] === 'assistant' && isRecord(event['message'])) {
    const content = event['message']['content'];
    if (!Array.isArray(content)) return null;
    let text = '';
    for (const block of content) {
      if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
        text += block['text'];
      }
    }
    return text.length > 0 ? { delta: text } : null;
  }

  if (event['type'] === 'result' && typeof event['result'] === 'string') {
    return { final: event['result'] };
  }
  return null;
}

/**
 * The variables that make the `claude` CLI authenticate with a key instead of
 * this machine's own login. The agent is defined to reuse that login — no
 * separate API key — so an inherited key changes which account answers a
 * household turn, and a stale one spends the whole 150s budget on 401 retries
 * before the turn fails. They are removed from the child environment, and the
 * removal is announced rather than done quietly.
 */
export const KEY_AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** The child environment: this process's, minus the key-auth variables. */
export function claudeChildEnv(parent: Record<string, string | undefined>): {
  env: Record<string, string | undefined>;
  removed: string[];
} {
  const env = { ...parent };
  const removed: string[] = [];
  for (const name of KEY_AUTH_VARS) {
    if (env[name] === undefined) continue;
    delete env[name];
    removed.push(name);
  }
  return { env, removed };
}

/** The announcement belongs to the process, not to every turn. */
let announcedKeyAuthStrip = false;

/**
 * Spawn one `claude` invocation, stream its text out through `emit`, and
 * resolve with the full reply text (empty string if it produced none — which
 * the runner reads as a lost session on a resume attempt).
 */
function spawnClaude(
  args: string[],
  prompt: string,
  cwd: string,
  emit: (delta: string) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { env, removed } = claudeChildEnv(process.env);
    if (removed.length > 0 && !announcedKeyAuthStrip) {
      announcedKeyAuthStrip = true;
      log(`eal agent: ignoring ${removed.join(' and ')} — a turn runs on this machine's claude login.`);
    }
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdoutBuffer = '';
    let stderr = '';
    let streamed = '';
    let finalText = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('the assistant timed out'));
    }, CLAUDE_TIMEOUT_MS);

    function consumeLine(line: string): void {
      const parsed = parseStreamJsonLine(line);
      if (parsed === null) return;
      if (parsed.delta !== undefined) {
        streamed += parsed.delta;
        emit(parsed.delta);
      }
      if (parsed.final !== undefined) finalText = parsed.final;
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not run the claude CLI (is Claude Code installed?): ${err.message}`));
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        consumeLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      consumeLine(stdoutBuffer);
      const reply = streamed.length > 0 ? streamed : finalText;
      // A clean run that yields no text is treated by the runner as a lost
      // session (resume miss). A non-zero exit with no text is a real failure.
      if (reply.length === 0 && code !== 0 && code !== null) {
        const detail = stderr.trim().slice(0, 300);
        reject(new Error(`claude exited ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      resolve(reply);
    });

    child.stdin.end(prompt);
  });
}

/**
 * Build the real Claude-backed runner. Each request resumes the conversation's
 * Claude session (sending only the new turn — Claude Code keeps the context and
 * compacts it) or, if there is no session yet or it has been lost, seeds a
 * fresh one from the recent history. The local `claude` login is reused — no
 * separate API key — and only the non-destructive eal MCP tools are allowed.
 */
export async function createClaudeRunner(options: ClaudeRunnerOptions): Promise<ClaudeRunner> {
  const cwd = sessionWorkdir();
  mkdirSync(cwd, { recursive: true });

  const cliEntry = fileURLToPath(new URL('../index.ts', import.meta.url));
  const mcpEnv: Record<string, string> = {
    EAL_API_URL: options.apiUrl,
    EAL_TOKEN_PATH: options.tokenPath,
  };
  const tlsReject = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  if (tlsReject !== undefined) mcpEnv['NODE_TLS_REJECT_UNAUTHORIZED'] = tlsReject;

  const mcpConfigJson = JSON.stringify({
    mcpServers: {
      eal: { command: process.execPath, args: [cliEntry, 'mcp'], env: mcpEnv },
    },
  });

  return async (input, emit) => {
    if (input.sessionId !== null) {
      const args = buildClaudeArgs(mcpConfigJson, { mode: 'resume', id: input.sessionId });
      const content = await spawnClaude(args, latestUserMessage(input.conversation), cwd, emit);
      if (content.length > 0) {
        return { content, sessionId: input.sessionId };
      }
      // The resume produced nothing — the session is gone (agent moved hosts,
      // or Claude Code pruned it). Fall through and seed a fresh one.
    }

    const freshId = crypto.randomUUID();
    const args = buildClaudeArgs(mcpConfigJson, { mode: 'create', id: freshId });
    const content = await spawnClaude(args, buildPrompt(input.conversation), cwd, emit);
    return { content, sessionId: freshId };
  };
}
