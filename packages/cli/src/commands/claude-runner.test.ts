import { describe, expect, test } from 'bun:test';
import type { Message } from '@eal/client';
import {
  buildClaudeArgs,
  buildPrompt,
  claudeChildEnv,
  latestUserMessage,
  parseStreamJsonLine,
} from './claude-runner.ts';

function msg(role: 'user' | 'assistant', content: string): Message {
  return { id: 1, role, content, createdBy: 1, createdAt: '2026-05-20T00:00:00Z' };
}

describe('buildPrompt', () => {
  test('renders the conversation as a labelled transcript', () => {
    const prompt = buildPrompt([
      msg('user', 'what is open?'),
      msg('assistant', 'two things'),
      msg('user', 'mark the first done'),
    ]);
    expect(prompt).toContain('Household member: what is open?');
    expect(prompt).toContain('Assistant: two things');
    expect(prompt).toContain('Household member: mark the first done');
    expect(prompt).toContain('Respond to the most recent');
  });
});

describe('latestUserMessage', () => {
  test('returns just the newest turn — what a resume sends', () => {
    expect(latestUserMessage([msg('user', 'old'), msg('assistant', 'mid'), msg('user', 'new')]))
      .toBe('new');
  });
  test('is empty for an empty conversation', () => {
    expect(latestUserMessage([])).toBe('');
  });
});

describe('buildClaudeArgs', () => {
  test('disables built-in tools and allows only the eal MCP tools', () => {
    const args = buildClaudeArgs('{"mcpServers":{}}', { mode: 'create', id: 'uuid-1' });
    // `--tools ""` strips every built-in tool.
    const toolsIdx = args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe('');
    // The allowlist is exclusively eal MCP tools.
    const allowIdx = args.indexOf('--allowedTools');
    expect(allowIdx).toBeGreaterThan(-1);
    const allowed = (args[allowIdx + 1] ?? '').split(',');
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.every((t) => t.startsWith('mcp__eal__'))).toBe(true);
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--print');
    // Session persistence must stay ON, or --resume can never find a session.
    expect(args).not.toContain('--no-session-persistence');
  });

  test('the model is pinned to an exact id, not an alias', () => {
    // An unpinned model changes under the household as Claude Code's default
    // moves, and an alias like `sonnet` follows the newest Sonnet — which is
    // the drift the pin exists to stop.
    const args = buildClaudeArgs('{}', { mode: 'create', id: 'uuid-1' });
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe('claude-sonnet-5');
  });

  test('create mode opens a session by id; resume mode resumes one', () => {
    const create = buildClaudeArgs('{}', { mode: 'create', id: 'uuid-new' });
    expect(create[create.indexOf('--session-id') + 1]).toBe('uuid-new');
    expect(create).not.toContain('--resume');

    const resume = buildClaudeArgs('{}', { mode: 'resume', id: 'uuid-old' });
    expect(resume[resume.indexOf('--resume') + 1]).toBe('uuid-old');
    expect(resume).not.toContain('--session-id');
  });
});

describe('parseStreamJsonLine', () => {
  test('extracts assistant text as a delta', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'You have 3 tasks.' }] },
    });
    expect(parseStreamJsonLine(line)).toEqual({ delta: 'You have 3 tasks.' });
  });

  test('ignores tool_use blocks but keeps accompanying text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check. ' },
          { type: 'tool_use', name: 'list_tasks', input: {} },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual({ delta: 'Let me check. ' });
  });

  test('extracts the final result string', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'All done.' });
    expect(parseStreamJsonLine(line)).toEqual({ final: 'All done.' });
  });

  test('returns null for system events, blanks, and malformed JSON', () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
    expect(parseStreamJsonLine('')).toBeNull();
    expect(parseStreamJsonLine('{not json')).toBeNull();
  });
});

describe('claudeChildEnv', () => {
  test('removes the key-auth variables and names each one it removed', () => {
    const { env, removed } = claudeChildEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'from-the-shell',
      ANTHROPIC_AUTH_TOKEN: 'also-from-the-shell',
    });
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
    expect(removed).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  });

  test('leaves an environment that carries neither of them alone', () => {
    const { env, removed } = claudeChildEnv({ PATH: '/usr/bin' });
    expect(removed).toEqual([]);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  test('does not mutate the environment it was given', () => {
    const parent = { ANTHROPIC_API_KEY: 'from-the-shell' };
    claudeChildEnv(parent);
    expect(parent['ANTHROPIC_API_KEY']).toBe('from-the-shell');
  });
});
