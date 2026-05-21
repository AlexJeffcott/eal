import { describe, expect, test } from 'bun:test';
import type { ChatAgentReply, ChatAgentRequest, Message } from '@eal/client';
import { handleChatRequest } from './agent.ts';
import type { ChatRunInput, ClaudeRunner } from './claude-runner.ts';

function request(text: string, claudeSessionId: string | null = null): ChatAgentRequest {
  const conversation: Message[] = [
    { id: 1, role: 'user', content: text, createdBy: 7, createdAt: '2026-05-20T00:00:00Z' },
  ];
  return { type: 'chat:request', requestId: 'req-1', claudeSessionId, conversation };
}

function collector(): { replies: ChatAgentReply[]; sendReply: (r: ChatAgentReply) => void } {
  const replies: ChatAgentReply[] = [];
  return { replies, sendReply: (r) => replies.push(r) };
}

describe('handleChatRequest', () => {
  test('streams each delta as a chunk, then a done with the full text + session id', async () => {
    const { replies, sendReply } = collector();
    const runClaude: ClaudeRunner = async (_input, emit) => {
      emit('Hello');
      emit(', Alex');
      return { content: 'Hello, Alex', sessionId: 'sess-1' };
    };

    await handleChatRequest(request('hi'), { runClaude, sendReply, log: () => {} });

    expect(replies).toEqual([
      { type: 'chat:chunk', requestId: 'req-1', delta: 'Hello' },
      { type: 'chat:chunk', requestId: 'req-1', delta: ', Alex' },
      { type: 'chat:done', requestId: 'req-1', content: 'Hello, Alex', claudeSessionId: 'sess-1' },
    ]);
  });

  test('passes the conversation and the request’s session id through to the runner', async () => {
    const { sendReply } = collector();
    const seen: ChatRunInput[] = [];
    const runClaude: ClaudeRunner = async (input) => {
      seen.push(input);
      return { content: 'ok', sessionId: 'sess-existing' };
    };

    await handleChatRequest(request('what is open?', 'sess-existing'), {
      runClaude,
      sendReply,
      log: () => {},
    });

    expect(seen[0]?.conversation.map((m) => m.content)).toEqual(['what is open?']);
    expect(seen[0]?.sessionId).toBe('sess-existing');
  });

  test('reports the session id the runner returns — covers a re-seeded session', async () => {
    const { replies, sendReply } = collector();
    // The request points at a stale session; the runner had to seed a new one.
    const runClaude: ClaudeRunner = async () => ({ content: 'done', sessionId: 'sess-fresh' });

    await handleChatRequest(request('hi', 'sess-stale'), { runClaude, sendReply, log: () => {} });

    const done = replies.find((r) => r.type === 'chat:done');
    expect(done).toEqual({
      type: 'chat:done',
      requestId: 'req-1',
      content: 'done',
      claudeSessionId: 'sess-fresh',
    });
  });

  test('drops empty deltas — they would be wasted chunk frames', async () => {
    const { replies, sendReply } = collector();
    const runClaude: ClaudeRunner = async (_input, emit) => {
      emit('');
      emit('real');
      emit('');
      return { content: 'real', sessionId: 'sess-1' };
    };

    await handleChatRequest(request('hi'), { runClaude, sendReply, log: () => {} });

    expect(replies.filter((r) => r.type === 'chat:chunk')).toEqual([
      { type: 'chat:chunk', requestId: 'req-1', delta: 'real' },
    ]);
  });

  test('a runner failure becomes a chat:error, not an unhandled throw', async () => {
    const { replies, sendReply } = collector();
    const logged: string[] = [];
    const runClaude: ClaudeRunner = async () => {
      throw new Error('claude is offline');
    };

    await handleChatRequest(request('hi'), { runClaude, sendReply, log: (l) => logged.push(l) });

    expect(replies).toEqual([
      { type: 'chat:error', requestId: 'req-1', message: 'claude is offline' },
    ]);
    expect(logged.some((l) => l.includes('claude is offline'))).toBe(true);
  });
});
