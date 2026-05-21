/**
 * Chat wire types — the assistant conversation and the WS protocol frames that
 * carry it between the browser, the server relay, and the `eal agent` process.
 *
 * The server source of truth for `Message` is
 * packages/api/src/handlers/messages.shared.ts; this declaration must stay
 * byte-identical at the field level.
 */
export interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /** The conversation owner — the household member this message belongs to. */
  createdBy: number;
  createdAt: string;
}

/** Browser → server: the human sends a chat message. */
export interface ChatSendFrame {
  type: 'chat:send';
  text: string;
}

/**
 * Server → browser. The relay echoes the persisted user message, streams the
 * assistant's reply as chunks, then delivers the final persisted message.
 */
export type ChatBrowserEvent =
  | { type: 'chat:user'; message: Message }
  | { type: 'chat:chunk'; delta: string }
  | { type: 'chat:done'; message: Message }
  | { type: 'chat:error'; message: string };

/**
 * Server → agent: a chat request. `claudeSessionId` is the Claude Code session
 * that already carries this conversation's context — the agent resumes it and
 * sends only the newest turn. `null` means seed a fresh session; `conversation`
 * is the recent history the agent uses to seed it.
 */
export interface ChatAgentRequest {
  type: 'chat:request';
  requestId: string;
  claudeSessionId: string | null;
  conversation: Message[];
}

/**
 * Agent → server: the streamed reply, correlated by requestId. `chat:done`
 * reports the Claude session id used (freshly seeded ones included) so the
 * server can persist it for the next turn.
 */
export type ChatAgentReply =
  | { type: 'chat:chunk'; requestId: string; delta: string }
  | { type: 'chat:done'; requestId: string; content: string; claudeSessionId: string }
  | { type: 'chat:error'; requestId: string; message: string };
