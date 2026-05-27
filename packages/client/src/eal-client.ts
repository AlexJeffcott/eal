import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types';
import type {
  CliPairClaimInput,
  CliPairPollResult,
  CliPairStartResult,
  CurrentUser,
  HouseholdMember,
} from './auth-types.ts';
import type {
  CloneTaskResult,
  CreateTaskInput,
  ListTasksInput,
  Task,
  TaskDetail,
  TaskEvent,
  UpdateTaskInput,
} from './task-types.ts';
import type {
  ChatAgentReply,
  ChatAgentRequest,
  ChatBrowserEvent,
  Message,
} from './chat-types.ts';
import type {
  AgentAction,
  AgentActionResult,
  AgentActionTrigger,
  AgentRule,
  FamilyPhoneCallEvent,
  FamilyPhoneDevice,
  FamilyPhoneDeviceConnection,
  FamilyPhonePairCompleteInput,
  FamilyPhonePairCompleteResult,
  FamilyPhonePairStartResult,
  UpsertAgentRuleInput,
} from './family-phone-types.ts';

const TOKEN_STORAGE_KEY = 'eal-token';

function toWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}/ws`;
  // Bare hostname falls through to wss:// for safety.
  return `wss://${httpUrl}/ws`;
}

function loadTokenFromStorage(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveTokenToStorage(token: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (token === null) localStorage.removeItem(TOKEN_STORAGE_KEY);
    else localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // localStorage may be disabled; tokens still work in-memory.
  }
}

interface IncomingWsMessage {
  type: string;
  topic?: string;
  payload?: unknown;
  message?: unknown;
  delta?: unknown;
  content?: unknown;
  requestId?: unknown;
  conversation?: unknown;
  claudeSessionId?: unknown;
}

function isMessageShape(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value && typeof value.id === 'number' &&
    'role' in value && (value.role === 'user' || value.role === 'assistant') &&
    'content' in value && typeof value.content === 'string' &&
    'createdBy' in value && typeof value.createdBy === 'number' &&
    'createdAt' in value && typeof value.createdAt === 'string'
  );
}

/** Browser-facing chat frames (no requestId — the server has already routed). */
function parseChatBrowserEvent(msg: IncomingWsMessage): ChatBrowserEvent | null {
  if (msg.type === 'chat:user' && isMessageShape(msg.message)) {
    return { type: 'chat:user', message: msg.message };
  }
  if (msg.type === 'chat:chunk' && typeof msg.delta === 'string') {
    return { type: 'chat:chunk', delta: msg.delta };
  }
  if (msg.type === 'chat:done' && isMessageShape(msg.message)) {
    return { type: 'chat:done', message: msg.message };
  }
  if (msg.type === 'chat:error' && typeof msg.message === 'string') {
    return { type: 'chat:error', message: msg.message };
  }
  return null;
}

/** Agent-facing chat frame — a request to answer, carrying the conversation. */
function parseChatAgentRequest(msg: IncomingWsMessage): ChatAgentRequest | null {
  if (msg.type !== 'chat:request') return null;
  if (typeof msg.requestId !== 'string') return null;
  if (msg.claudeSessionId !== null && typeof msg.claudeSessionId !== 'string') return null;
  if (!Array.isArray(msg.conversation) || !msg.conversation.every(isMessageShape)) return null;
  return {
    type: 'chat:request',
    requestId: msg.requestId,
    claudeSessionId: msg.claudeSessionId,
    conversation: msg.conversation,
  };
}

function isTaskShape(value: unknown): value is Task {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value && typeof value.id === 'number' &&
    'title' in value && typeof value.title === 'string' &&
    'status' in value && (value.status === 'open' || value.status === 'done')
  );
}

function isCloneShape(value: unknown): value is CloneTaskResult {
  if (typeof value !== 'object' || value === null) return false;
  if (!('rootId' in value) || typeof value.rootId !== 'number') return false;
  if (!('tasks' in value) || !Array.isArray(value.tasks)) return false;
  return value.tasks.every(isTaskShape);
}

function parseTaskEvent(msg: IncomingWsMessage): TaskEvent | null {
  if (msg.type === 'task:created' && isTaskShape(msg.payload)) {
    return { type: 'task:created', topic: 'tasks', payload: msg.payload };
  }
  if (msg.type === 'task:updated' && isTaskShape(msg.payload)) {
    return { type: 'task:updated', topic: 'tasks', payload: msg.payload };
  }
  if (msg.type === 'task:deleted' && isTaskShape(msg.payload)) {
    return { type: 'task:deleted', topic: 'tasks', payload: msg.payload };
  }
  if (msg.type === 'task:tree-cloned' && isCloneShape(msg.payload)) {
    return { type: 'task:tree-cloned', topic: 'tasks', payload: msg.payload };
  }
  return null;
}

function isErrorEnvelope(value: unknown): value is { error: string } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('error' in value)) return false;
  return typeof value.error === 'string';
}

/**
 * The api returns errors as `{ "error": "..." }`. Surface the inner string so
 * UIs don't show stack-trace-looking wrappers like `POST /x failed: 500 {...}`.
 * Falls back to the raw body when it isn't a JSON envelope.
 */
export function extractServerError(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isErrorEnvelope(parsed)) return parsed.error;
  } catch {
    // Body wasn't JSON; fall through.
  }
  return body;
}

export interface EalClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  registerPasskey(displayName: string): Promise<CurrentUser>;
  signInWithPasskey(): Promise<CurrentUser>;
  signOut(): Promise<void>;
  getCurrentUser(): Promise<CurrentUser | null>;
  /** The household roster — used to populate the task assignee picker. */
  listUsers(): Promise<HouseholdMember[]>;
  startCliPair(): Promise<CliPairStartResult>;
  pollCliPair(input: { deviceCode: string }): Promise<CliPairPollResult>;
  claimCliPair(input: CliPairClaimInput): Promise<{ ok: true }>;

  createTask(input: CreateTaskInput): Promise<Task>;
  listTasks(input?: ListTasksInput): Promise<Task[]>;
  getTask(id: number): Promise<TaskDetail>;
  updateTask(id: number, input: UpdateTaskInput): Promise<Task>;
  completeTask(id: number): Promise<Task>;
  reopenTask(id: number): Promise<Task>;
  deleteTask(id: number): Promise<Task>;
  restoreTask(id: number): Promise<Task>;
  cloneTask(id: number): Promise<CloneTaskResult>;
  /** Fires for task:created, task:updated, task:deleted, task:tree-cloned. */
  subscribeTaskEvents(handler: (event: TaskEvent) => void): () => void;

  // ── Family-phone ─────────────────────────────────────────────────────────
  /** The signed-in user's family-phone devices. */
  listFamilyPhoneDevices(): Promise<FamilyPhoneDevice[]>;
  /** In-household browser mints a short opaque invite code to hand to a new device. */
  startFamilyPhonePair(): Promise<FamilyPhonePairStartResult>;
  /** New-device side — submits the spoken code and its freshly-generated public key. */
  completeFamilyPhonePair(
    input: FamilyPhonePairCompleteInput,
  ): Promise<FamilyPhonePairCompleteResult>;
  /** Delete a device the caller owns; cascades to its key, challenges, sessions. */
  deleteFamilyPhoneDevice(id: number): Promise<void>;
  /** Rename a device the caller owns. Trimmed, non-empty, ≤60 chars. */
  renameFamilyPhoneDevice(id: number, label: string): Promise<void>;
  /**
   * Open a device-authenticated WebSocket. The connection runs its own
   * challenge/sign handshake against the supplied keypair and is independent
   * of the user Bearer-token WS that `connect()` opens. Returns a handle the
   * caller uses to place calls, accept/reject incoming, and listen for the
   * family-phone signalling events.
   */
  connectFamilyPhoneDevice(input: {
    deviceId: number;
    privateKey: CryptoKey;
  }): Promise<FamilyPhoneDeviceConnection>;

  // ── Agent proactivity ────────────────────────────────────────────────────
  /** Read every proactivity rule. Admin UI listing. */
  listAgentRules(): Promise<AgentRule[]>;
  /** Insert when `id` is omitted, update otherwise. */
  upsertAgentRule(input: UpsertAgentRuleInput): Promise<AgentRule>;
  /** Delete a rule. The audit log entries that referenced it survive. */
  deleteAgentRule(id: number): Promise<void>;

  // ── Agent actions (audit + lock) ─────────────────────────────────────────
  /**
   * Claim the agent's phone lock and insert a pending audit row. Returns
   * the new action on success, or `null` if the agent is already on a
   * call (server returned 409). Used by the scheduler before placing the
   * actual `call:invite` over the agent's family-phone WS.
   */
  createAgentPlaceCallAction(input: {
    targetDeviceId: number;
    trigger: AgentActionTrigger;
    ruleId?: number | null;
  }): Promise<AgentAction | null>;
  /** Stamp the freshly-minted family-phone call_id onto a pending action. */
  attachAgentCall(actionId: number, callId: string): Promise<AgentAction>;
  /** Finish a pending action and release the lock. */
  finishAgentAction(
    actionId: number,
    input: {
      result: Exclude<AgentActionResult, 'pending'>;
      callId?: string | null;
      error?: string | null;
    },
  ): Promise<AgentAction>;
  /** Most-recent-first audit log, optionally filtered to one rule. */
  listAgentActions(input?: { limit?: number; ruleId?: number }): Promise<AgentAction[]>;

  // ── Chat (browser side) ──────────────────────────────────────────────────
  /** Load the signed-in user's current assistant conversation, oldest first. */
  listMessages(): Promise<Message[]>;
  /** Reset the conversation — hide the history and drop the assistant's memory. */
  clearChat(): Promise<void>;
  /** Send a chat message to the assistant. Requires an open browser WS. */
  sendChat(text: string): void;
  /** Fires for chat:user, chat:chunk, chat:done, chat:error. */
  subscribeChatEvents(handler: (event: ChatBrowserEvent) => void): () => void;

  // ── Chat (agent side) ────────────────────────────────────────────────────
  /**
   * Connect the WS as an `agent` — the worker that answers chat requests.
   * `onRequest` fires for each chat:request; `onClose` fires when the socket
   * drops so the caller can reconnect.
   */
  connectAsAgent(handlers: {
    onRequest: (request: ChatAgentRequest) => void;
    onClose: () => void;
  }): Promise<void>;
  /** Send a streamed reply chunk / completion / error back for a chat request. */
  sendChatReply(reply: ChatAgentReply): void;
}

export interface EalClientOptions {
  /** Optional token override. If omitted, the client falls back to localStorage in a browser context. */
  token?: string;
}

export function createEalClient(apiUrl: string, options: EalClientOptions = {}): EalClient {
  if (apiUrl.startsWith('http://') || apiUrl.startsWith('ws://')) {
    throw new Error(
      `createEalClient: plaintext URLs are not allowed (got "${apiUrl}"). ` +
        'eal requires HTTPS + WSS on every network-facing tier.',
    );
  }
  let currentToken: string | null = options.token ?? loadTokenFromStorage();
  const wsUrl = toWsUrl(apiUrl);

  function authHeaders(): Record<string, string> {
    if (currentToken === null) return {};
    return { authorization: `Bearer ${currentToken}` };
  }

  let socket: WebSocket | null = null;
  const taskEventSubscribers = new Set<(event: TaskEvent) => void>();
  const chatEventSubscribers = new Set<(event: ChatBrowserEvent) => void>();
  let agentRequestHandler: ((request: ChatAgentRequest) => void) | null = null;

  function setToken(token: string | null): void {
    currentToken = token;
    saveTokenToStorage(token);
  }

  function handleMessage(raw: string): void {
    let msg: IncomingWsMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const taskEvent = parseTaskEvent(msg);
    if (taskEvent !== null) {
      for (const h of taskEventSubscribers) h(taskEvent);
      return;
    }
    const chatBrowserEvent = parseChatBrowserEvent(msg);
    if (chatBrowserEvent !== null) {
      for (const h of chatEventSubscribers) h(chatBrowserEvent);
      return;
    }
    const agentRequest = parseChatAgentRequest(msg);
    if (agentRequest !== null && agentRequestHandler !== null) {
      agentRequestHandler(agentRequest);
    }
  }

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(extractServerError(text));
    }
    return response.json() as Promise<T>;
  }

  async function getJson<T>(path: string): Promise<T | null> {
    const response = await fetch(`${apiUrl}${path}`, { headers: authHeaders() });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
    return response.json() as Promise<T>;
  }

  async function getJsonOrThrow<T>(path: string): Promise<T> {
    const response = await fetch(`${apiUrl}${path}`, { headers: authHeaders() });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(extractServerError(text));
    }
    return response.json() as Promise<T>;
  }

  async function patchJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${apiUrl}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(extractServerError(text));
    }
    return response.json() as Promise<T>;
  }

  async function deleteJson<T>(path: string): Promise<T> {
    const response = await fetch(`${apiUrl}${path}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(extractServerError(text));
    }
    return response.json() as Promise<T>;
  }

  function tasksQueryString(input: ListTasksInput | undefined): string {
    if (!input) return '';
    const params = new URLSearchParams();
    if (input.parentId !== undefined) {
      params.set('parent_id', input.parentId === null ? 'null' : String(input.parentId));
    }
    if (input.assignedTo !== undefined) {
      params.set('assigned_to', input.assignedTo === 'me' ? 'me' : String(input.assignedTo));
    }
    if (input.createdBy !== undefined) {
      params.set('created_by', input.createdBy === 'me' ? 'me' : String(input.createdBy));
    }
    if (input.status !== undefined) params.set('status', input.status);
    if (input.dueBefore !== undefined) params.set('due_before', input.dueBefore);
    if (input.deferAfter !== undefined) params.set('defer_after', input.deferAfter);
    if (input.today) params.set('today', '1');
    if (input.todayCutoff !== undefined) params.set('today_cutoff', input.todayCutoff);
    if (input.inbox) params.set('inbox', '1');
    if (input.trash) params.set('trash', '1');
    if (input.q !== undefined) params.set('q', input.q);
    const qs = params.toString();
    return qs.length === 0 ? '' : `?${qs}`;
  }

  function toCreateTaskWire(input: CreateTaskInput): Record<string, unknown> {
    const body: Record<string, unknown> = { title: input.title };
    if (input.parentId !== undefined) body['parent_id'] = input.parentId;
    if (input.assignedTo !== undefined) body['assigned_to'] = input.assignedTo;
    if (input.notes !== undefined) body['notes'] = input.notes;
    if (input.deferUntil !== undefined) body['defer_until'] = input.deferUntil;
    if (input.dueAt !== undefined) body['due_at'] = input.dueAt;
    return body;
  }

  function toUpdateTaskWire(input: UpdateTaskInput): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body['title'] = input.title;
    if (input.notes !== undefined) body['notes'] = input.notes;
    if (input.assignedTo !== undefined) body['assigned_to'] = input.assignedTo;
    if (input.parentId !== undefined) body['parent_id'] = input.parentId;
    if (input.deferUntil !== undefined) body['defer_until'] = input.deferUntil;
    if (input.dueAt !== undefined) body['due_at'] = input.dueAt;
    if (input.position !== undefined) body['position'] = input.position;
    return body;
  }

  function toUpsertAgentRuleWire(input: UpsertAgentRuleInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
      name: input.name,
      enabled: input.enabled,
      target_device_id: input.targetDeviceId,
      kind: input.kind,
      next_fire_at: input.nextFireAt,
    };
    if (input.id !== undefined) body['id'] = input.id;
    if (input.body !== undefined) body['body'] = input.body;
    if (input.systemPrompt !== undefined) body['system_prompt'] = input.systemPrompt;
    if (input.intervalSec !== undefined) body['interval_sec'] = input.intervalSec;
    if (input.cooldownSec !== undefined) body['cooldown_sec'] = input.cooldownSec;
    return body;
  }

  function toCreatePlaceCallWire(input: {
    targetDeviceId: number;
    trigger: AgentActionTrigger;
    ruleId?: number | null;
  }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      target_device_id: input.targetDeviceId,
      trigger: input.trigger,
    };
    if (input.ruleId !== undefined) body['rule_id'] = input.ruleId;
    return body;
  }

  /**
   * Open the WS, run the first-message auth handshake with the given role, and
   * resolve once `auth:ok` lands. Shared by `connect` (browser) and
   * `connectAsAgent` (agent) — they differ only in the role and what they do
   * afterwards.
   */
  async function connectWs(role: 'browser' | 'agent'): Promise<void> {
    if (socket && socket.readyState === WebSocket.OPEN) return;
    if (currentToken === null) {
      throw new Error('connect: no auth token. Sign in or pass { token } before connecting the WS.');
    }
    socket = new WebSocket(wsUrl);
    socket.addEventListener('message', (e: MessageEvent) => {
      if (typeof e.data === 'string') handleMessage(e.data);
    });
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const s = socket;
      if (!s) {
        rejectOpen(new Error('socket not initialised'));
        return;
      }
      s.addEventListener('open', () => resolveOpen(), { once: true });
      s.addEventListener('error', () => rejectOpen(new Error('ws connect failed')), { once: true });
    });
    await new Promise<void>((resolveAuth, rejectAuth) => {
      const s = socket;
      if (!s) {
        rejectAuth(new Error('socket vanished during auth handshake'));
        return;
      }
      const onAuthMessage = (e: MessageEvent): void => {
        if (typeof e.data !== 'string') return;
        let parsed: { type?: string; code?: string; message?: string };
        try { parsed = JSON.parse(e.data); } catch { return; }
        if (parsed.type === 'auth:ok') {
          s.removeEventListener('message', onAuthMessage);
          resolveAuth();
        } else if (parsed.type === 'error' && parsed.code === 'unauthenticated') {
          s.removeEventListener('message', onAuthMessage);
          rejectAuth(new Error(`ws auth rejected: ${parsed.message ?? 'invalid token'}`));
        }
      };
      s.addEventListener('message', onAuthMessage);
      s.send(JSON.stringify({ type: 'auth', token: currentToken, role }));
    });
  }

  return {
    async connect(): Promise<void> {
      await connectWs('browser');
      socket?.send(JSON.stringify({ type: 'subscribe', topic: 'tasks' }));
    },

    async connectAsAgent(handlers): Promise<void> {
      agentRequestHandler = handlers.onRequest;
      await connectWs('agent');
      socket?.addEventListener('close', () => handlers.onClose(), { once: true });
    },

    async listMessages(): Promise<Message[]> {
      const result = await getJsonOrThrow<{ messages: Message[] }>('/api/v1/messages');
      return result.messages;
    },

    async clearChat(): Promise<void> {
      await postJson<{ ok: true }>('/api/v1/messages/clear', {});
    },

    sendChat(text: string): void {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('sendChat: not connected');
      }
      socket.send(JSON.stringify({ type: 'chat:send', text }));
    },

    subscribeChatEvents(handler: (event: ChatBrowserEvent) => void): () => void {
      chatEventSubscribers.add(handler);
      return () => chatEventSubscribers.delete(handler);
    },

    sendChatReply(reply: ChatAgentReply): void {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('sendChatReply: not connected');
      }
      socket.send(JSON.stringify(reply));
    },

    async disconnect(): Promise<void> {
      if (!socket) return;
      socket.close();
      socket = null;
    },

    async registerPasskey(displayName: string): Promise<CurrentUser> {
      const { options } = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON }>(
        '/public/auth/register/options',
        { displayName },
      );
      const attResp = await startRegistration({ optionsJSON: options });
      const result = await postJson<{ token: string; user: { id: number; displayName: string } }>(
        '/public/auth/register/verify',
        { response: attResp },
      );
      setToken(result.token);
      return { userId: result.user.id, displayName: result.user.displayName };
    },

    async signInWithPasskey(): Promise<CurrentUser> {
      const { options } = await postJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        '/public/auth/login/options',
        {},
      );
      const asnResp = await startAuthentication({ optionsJSON: options });
      const result = await postJson<{ token: string; user: { id: number; displayName: string } }>(
        '/public/auth/login/verify',
        { response: asnResp },
      );
      setToken(result.token);
      return { userId: result.user.id, displayName: result.user.displayName };
    },

    async signOut(): Promise<void> {
      if (currentToken !== null) {
        await fetch(`${apiUrl}/api/v1/auth/logout`, { method: 'POST', headers: authHeaders() }).catch(() => {});
      }
      setToken(null);
    },

    async getCurrentUser(): Promise<CurrentUser | null> {
      const result = await getJson<{ userId: number; displayName: string }>('/api/v1/auth/me');
      if (!result) return null;
      return { userId: result.userId, displayName: result.displayName };
    },

    async listUsers(): Promise<HouseholdMember[]> {
      const result = await getJsonOrThrow<{ users: HouseholdMember[] }>('/api/v1/users');
      return result.users;
    },

    async startCliPair(): Promise<CliPairStartResult> {
      const raw = await postJson<{
        user_code: string;
        device_code: string;
        verification_url: string;
        poll_interval_ms: number;
        expires_at: string;
      }>('/public/auth/cli-pair/start', {});
      return {
        userCode: raw.user_code,
        deviceCode: raw.device_code,
        verificationUrl: raw.verification_url,
        pollIntervalMs: raw.poll_interval_ms,
        expiresAt: raw.expires_at,
      };
    },

    async pollCliPair(input): Promise<CliPairPollResult> {
      const raw = await postJson<
        | { status: 'pending' }
        | { status: 'expired' }
        | { status: 'authorized'; token: string; user: { id: number; display_name: string } }
      >('/public/auth/cli-pair/poll', { device_code: input.deviceCode });
      if (raw.status === 'authorized') {
        return {
          status: 'authorized',
          token: raw.token,
          user: { userId: raw.user.id, displayName: raw.user.display_name },
        };
      }
      return { status: raw.status };
    },

    async claimCliPair(input): Promise<{ ok: true }> {
      await postJson<{ ok: true }>('/api/v1/auth/cli-pair/claim', {
        user_code: input.userCode,
        label: input.label,
      });
      return { ok: true };
    },

    async createTask(input): Promise<Task> {
      const { task } = await postJson<{ task: Task }>('/api/v1/tasks', toCreateTaskWire(input));
      return task;
    },

    async listTasks(input): Promise<Task[]> {
      const { tasks } = await getJsonOrThrow<{ tasks: Task[] }>(
        `/api/v1/tasks${tasksQueryString(input)}`,
      );
      return tasks;
    },

    async getTask(id): Promise<TaskDetail> {
      return getJsonOrThrow<TaskDetail>(`/api/v1/tasks/${id}`);
    },

    async updateTask(id, input): Promise<Task> {
      const { task } = await patchJson<{ task: Task }>(`/api/v1/tasks/${id}`, toUpdateTaskWire(input));
      return task;
    },

    async completeTask(id): Promise<Task> {
      const { task } = await postJson<{ task: Task }>(`/api/v1/tasks/${id}/complete`, {});
      return task;
    },

    async reopenTask(id): Promise<Task> {
      const { task } = await postJson<{ task: Task }>(`/api/v1/tasks/${id}/reopen`, {});
      return task;
    },

    async deleteTask(id): Promise<Task> {
      const { task } = await deleteJson<{ task: Task }>(`/api/v1/tasks/${id}`);
      return task;
    },

    async restoreTask(id): Promise<Task> {
      const { task } = await postJson<{ task: Task }>(`/api/v1/tasks/${id}/restore`, {});
      return task;
    },

    async cloneTask(id): Promise<CloneTaskResult> {
      return postJson<CloneTaskResult>(`/api/v1/tasks/${id}/clone`, {});
    },

    subscribeTaskEvents(handler: (event: TaskEvent) => void): () => void {
      taskEventSubscribers.add(handler);
      return () => taskEventSubscribers.delete(handler);
    },

    async listFamilyPhoneDevices(): Promise<FamilyPhoneDevice[]> {
      interface WireRow {
        id: number;
        user_id: number;
        label: string;
        kind: 'handset' | 'pwa' | 'agent';
        created_at: string;
        paired_at: string | null;
        owner_display_name: string;
        online: boolean;
      }
      const { devices } = await getJsonOrThrow<{ devices: WireRow[] }>(
        '/api/family-phone/devices',
      );
      return devices.map((d) => ({
        id: d.id,
        label: d.label,
        kind: d.kind,
        createdAt: d.created_at,
        pairedAt: d.paired_at,
        ownerUserId: d.user_id,
        ownerDisplayName: d.owner_display_name,
        online: d.online,
      }));
    },

    async startFamilyPhonePair(): Promise<FamilyPhonePairStartResult> {
      const wire = await postJson<{ user_code: string; expires_at: string }>(
        '/api/family-phone/pair/start',
        {},
      );
      return { userCode: wire.user_code, expiresAt: wire.expires_at };
    },

    async completeFamilyPhonePair(
      input: FamilyPhonePairCompleteInput,
    ): Promise<FamilyPhonePairCompleteResult> {
      const wire = await postJson<{ device_id: number }>(
        '/api/family-phone/pair/complete',
        {
          user_code: input.userCode,
          public_key: input.publicKey,
          alg: input.alg,
          label: input.label,
          kind: input.kind,
        },
      );
      return { deviceId: wire.device_id };
    },

    async deleteFamilyPhoneDevice(id: number): Promise<void> {
      await deleteJson<{ deleted: boolean }>(`/api/family-phone/devices/${id}`);
    },

    async renameFamilyPhoneDevice(id: number, label: string): Promise<void> {
      await patchJson<{ device: { id: number; label: string } }>(
        `/api/family-phone/devices/${id}`,
        { label },
      );
    },

    async connectFamilyPhoneDevice(input): Promise<FamilyPhoneDeviceConnection> {
      const { deviceId, privateKey } = input;
      // Subscribers survive reconnects — bound to the handle, not the WS.
      const subscribers = new Set<(event: FamilyPhoneCallEvent) => void>();
      const audioSubscribers = new Set<(callId: string, payload: Uint8Array) => void>();
      // The live socket; swapped on every reconnect. `closed` records the
      // caller's intent — set by close(), it stops the reconnect loop.
      let ws: WebSocket | null = null;
      let closed = false;
      let reconnectAttempt = 0;

      function onMessage(e: MessageEvent): void {
        if (typeof e.data === 'string') {
          const event = parseFamilyPhoneCallEvent(e.data);
          if (event) for (const h of subscribers) h(event);
          return;
        }
        if (e.data instanceof ArrayBuffer) {
          const view = new Uint8Array(e.data);
          if (view.length < 17 || view[0] !== AUDIO_TAG) return;
          const callIdBytes = view.slice(1, 17);
          const callId = new TextDecoder().decode(callIdBytes).replace(/\0+$/, '');
          const payload = view.slice(17);
          for (const h of audioSubscribers) h(callId, payload);
        }
      }

      async function openOnce(): Promise<void> {
        // Each connect needs a fresh nonce — challenges are single-use.
        const { nonce } = await postJson<{ nonce: string; expires_at: string }>(
          '/api/family-phone/device/challenge',
          { device_id: deviceId },
        );
        const nonceBytes = fromBase64UrlBytes(nonce);
        const sigBuf = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          privateKey,
          nonceBytes,
        );
        const signature = toBase64UrlBytes(new Uint8Array(sigBuf));
        const socket = new WebSocket(wsUrl);
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('message', onMessage);
        await new Promise<void>((resolveOpen, rejectOpen) => {
          socket.addEventListener('open', () => resolveOpen(), { once: true });
          socket.addEventListener('error', () => rejectOpen(new Error('device ws connect failed')), {
            once: true,
          });
        });
        await new Promise<void>((resolveAuth, rejectAuth) => {
          const onAuth = (e: MessageEvent): void => {
            if (typeof e.data !== 'string') return;
            let parsed: { type?: string; code?: string; message?: string };
            try { parsed = JSON.parse(e.data); } catch { return; }
            if (parsed.type === 'auth:ok') {
              socket.removeEventListener('message', onAuth);
              resolveAuth();
            } else if (parsed.type === 'error' && parsed.code === 'unauthenticated') {
              socket.removeEventListener('message', onAuth);
              rejectAuth(new Error(`device ws auth rejected: ${parsed.message ?? ''}`));
            }
          };
          socket.addEventListener('message', onAuth);
          socket.send(JSON.stringify({ type: 'auth', device_id: deviceId, nonce, signature }));
        });
        // Reconnect on unexpected close. Phones suspending their tab, network
        // changes, and Fly machine restarts all close the underlying WS;
        // without this the panel shows the device as online but no call ever
        // arrives. Exponential backoff capped at 30s.
        socket.addEventListener('close', () => {
          if (closed) return;
          ws = null;
          const delayMs = Math.min(30_000, 500 * 2 ** reconnectAttempt);
          reconnectAttempt += 1;
          setTimeout(() => {
            if (closed) return;
            openOnce().catch(() => { /* will retry on next close */ });
          }, delayMs);
        });
        ws = socket;
        reconnectAttempt = 0;
      }

      await openOnce();

      function sendCall(payload: unknown): void {
        ws?.send(JSON.stringify(payload));
      }

      return {
        deviceId,
        placeCall(targetDeviceId) {
          sendCall({ type: 'call:invite', target_device_id: targetDeviceId });
        },
        acceptCall(callId) {
          sendCall({ type: 'call:accept', call_id: callId });
        },
        rejectCall(callId) {
          sendCall({ type: 'call:reject', call_id: callId });
        },
        cancelCall(callId) {
          sendCall({ type: 'call:cancel', call_id: callId });
        },
        hangup(callId) {
          sendCall({ type: 'call:hangup', call_id: callId });
        },
        subscribePush(input) {
          sendCall({
            type: 'push:subscribe',
            endpoint: input.endpoint,
            p256dh: input.p256dh,
            auth: input.auth,
          });
        },
        unsubscribePush(endpoint) {
          sendCall({ type: 'push:unsubscribe', endpoint });
        },
        subscribe(handler) {
          subscribers.add(handler);
          return () => subscribers.delete(handler);
        },
        sendAudio(callId, payload) {
          if (!ws) return;
          const frame = new Uint8Array(new ArrayBuffer(1 + 16 + payload.byteLength));
          frame[0] = AUDIO_TAG;
          const idBytes = new TextEncoder().encode(callId).slice(0, 16);
          frame.set(idBytes, 1);
          frame.set(payload, 17);
          ws.send(frame);
        },
        subscribeAudio(handler) {
          audioSubscribers.add(handler);
          return () => audioSubscribers.delete(handler);
        },
        close() {
          closed = true;
          subscribers.clear();
          audioSubscribers.clear();
          ws?.close();
          ws = null;
        },
      };
    },

    async listAgentRules(): Promise<AgentRule[]> {
      const { rules } = await getJsonOrThrow<{ rules: AgentRule[] }>('/api/agent/rules');
      return rules;
    },

    async upsertAgentRule(input): Promise<AgentRule> {
      const { rule } = await postJson<{ rule: AgentRule }>(
        '/api/agent/rules',
        toUpsertAgentRuleWire(input),
      );
      return rule;
    },

    async deleteAgentRule(id): Promise<void> {
      await deleteJson<{ deleted: true }>(`/api/agent/rules/${id}`);
    },

    async createAgentPlaceCallAction(input): Promise<AgentAction | null> {
      const body = toCreatePlaceCallWire(input);
      const response = await fetch(`${apiUrl}/api/agent/actions/place-call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      // The lock is held; the server still recorded the audit row as
      // failed, but we report "busy" to the caller as `null` so the
      // scheduler can back off and try again on the next tick.
      if (response.status === 409) return null;
      if (!response.ok) {
        throw new Error(extractServerError(await response.text()));
      }
      const parsed: { action: AgentAction } = await response.json();
      return parsed.action;
    },

    async attachAgentCall(actionId, callId): Promise<AgentAction> {
      const { action } = await postJson<{ action: AgentAction }>(
        `/api/agent/actions/${actionId}/attach-call`,
        { call_id: callId },
      );
      return action;
    },

    async finishAgentAction(actionId, input): Promise<AgentAction> {
      const { action } = await postJson<{ action: AgentAction }>(
        `/api/agent/actions/${actionId}/finish`,
        {
          result: input.result,
          call_id: input.callId ?? null,
          error: input.error ?? null,
        },
      );
      return action;
    },

    async listAgentActions(input): Promise<AgentAction[]> {
      const params = new URLSearchParams();
      if (input?.limit !== undefined) params.set('limit', String(input.limit));
      if (input?.ruleId !== undefined) params.set('rule_id', String(input.ruleId));
      const query = params.toString();
      const path = `/api/agent/actions${query.length === 0 ? '' : `?${query}`}`;
      const { actions } = await getJsonOrThrow<{ actions: AgentAction[] }>(path);
      return actions;
    },
  };
}

/** Binary tag claimed by family-phone for audio frames; mirrors the server. */
const AUDIO_TAG = 0x10;

function fromBase64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const decoded = atob(padded + '='.repeat(padLen));
  const out = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}

function toBase64UrlBytes(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseFamilyPhoneCallEvent(raw: string): FamilyPhoneCallEvent | null {
  let parsed: { type?: unknown };
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') return null;
  const t = parsed.type;
  if (t === 'call:invite-ack' && 'call_id' in parsed && typeof parsed.call_id === 'string') {
    return { type: 'call:invite-ack', callId: parsed.call_id };
  }
  if (t === 'call:invite-failed' && 'reason' in parsed && typeof parsed.reason === 'string') {
    return { type: 'call:invite-failed', reason: parsed.reason };
  }
  if (
    t === 'call:incoming' &&
    'call_id' in parsed && typeof parsed.call_id === 'string' &&
    'from_device_id' in parsed && typeof parsed.from_device_id === 'number'
  ) {
    return { type: 'call:incoming', callId: parsed.call_id, fromDeviceId: parsed.from_device_id };
  }
  if (
    (t === 'call:accepted' || t === 'call:accept-ack' || t === 'call:rejected' ||
     t === 'call:cancelled' || t === 'call:hung-up') &&
    'call_id' in parsed && typeof parsed.call_id === 'string'
  ) {
    const base = { callId: parsed.call_id };
    if (t === 'call:hung-up' && 'reason' in parsed && typeof parsed.reason === 'string') {
      return { type: t, ...base, reason: parsed.reason };
    }
    return { type: t, ...base };
  }
  if (
    t === 'presence:changed' &&
    'device_id' in parsed && typeof parsed.device_id === 'number' &&
    'online' in parsed && typeof parsed.online === 'boolean'
  ) {
    return { type: 'presence:changed', deviceId: parsed.device_id, online: parsed.online };
  }
  if (t === 'directory:changed') {
    return { type: 'directory:changed' };
  }
  if (t === 'push:subscribed') {
    return { type: 'push:subscribed' };
  }
  if (t === 'push:subscribe-failed' && 'reason' in parsed && typeof parsed.reason === 'string') {
    return { type: 'push:subscribe-failed', reason: parsed.reason };
  }
  if (t === 'push:unsubscribed') {
    return { type: 'push:unsubscribed' };
  }
  return null;
}
