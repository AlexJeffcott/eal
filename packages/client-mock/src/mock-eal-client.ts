import type {
  AgentAction,
  AgentActionResult,
  AgentActionTrigger,
  AgentRule,
  ChatAgentReply,
  ChatAgentRequest,
  ChatBrowserEvent,
  CliPairClaimInput,
  CliPairPollResult,
  CliPairStartResult,
  CloneTaskResult,
  CreatePstnContactInput,
  CreateTaskInput,
  CurrentUser,
  EalClient,
  HouseholdMember,
  ListTasksInput,
  Message,
  PostVoiceMessageInput,
  PstnContact,
  Task,
  TaskDetail,
  TaskEvent,
  UpdatePstnContactInput,
  UpsertAgentRuleInput,
  VoiceMessage,
  WsConnectionState,
} from '@eal/client';

export interface MockEalClient extends EalClient {
  /**
   * Test hook: drive every subscribeTaskEvents handler synchronously. Simulates
   * a broadcast from another device — does NOT mutate the local task store,
   * so the test author has full control over the "remote vs local" interleaving.
   */
  emitTaskEvent(event: TaskEvent): void;
  /**
   * Test hook: drive the connection-state subscribers, as the real client does
   * when a socket drops and comes back. `connectionState()` reads back the last
   * value emitted, so a test can script `connected → reconnecting → connected`
   * and assert what the shell did about it.
   */
  emitConnectionState(state: WsConnectionState): void;
  /** Test hook: how many times the shell asked for an immediate reconnect. */
  peekReconnectNowCalls(): number;
  /** Test hook: set the current user that getCurrentUser will return. */
  setCurrentUser(user: CurrentUser | null): void;
  /** Test hook: seed the household roster that listUsers will return. */
  seedUsers(users: readonly HouseholdMember[]): void;
  /**
   * Test hook: seed the cli-pair state machine. Subsequent calls to startCliPair
   * return this start result, and pollCliPair walks the supplied poll-result
   * sequence (the last entry sticks for any further polls).
   */
  mockCliPair(input: {
    start: CliPairStartResult;
    polls: readonly CliPairPollResult[];
  }): void;
  /**
   * Test hook: arm the next signInWithPasskey() call to reject with the given
   * Error. Cleared after one rejection so subsequent calls fall back to the
   * default behaviour. Pass `null` to clear pre-emptively.
   */
  mockSignInError(err: Error | null): void;
  /**
   * Test hook: arm the next registerPasskey() call to reject. Symmetric to
   * mockSignInError — same one-shot semantics.
   */
  mockRegisterError(err: Error | null): void;
  /** Test hook: arm the next mutating task call to reject. One-shot. */
  mockTaskError(err: Error | null): void;
  /** Test hook: snapshot the in-memory tasks store (live array — do not mutate). */
  peekTasks(): readonly Task[];
  /**
   * Test hook: drive every subscribeChatEvents handler synchronously. The chat
   * panel test scripts the relay by hand: emit chat:user, then chat:chunk(s),
   * then chat:done — full control over the streaming sequence.
   */
  emitChatEvent(event: ChatBrowserEvent): void;
  /** Test hook: seed the conversation that listMessages() will return. */
  seedMessages(messages: readonly Message[]): void;
  /** Test hook: the texts passed to sendChat, in order. */
  peekSentChats(): readonly string[];
  /** Test hook: drive the connectAsAgent onRequest handler. */
  emitChatRequest(request: ChatAgentRequest): void;
  /** Test hook: the replies passed to sendChatReply, in order. */
  peekChatReplies(): readonly ChatAgentReply[];
  /** Test hook: clear all subscribers and registered responses. */
  reset(): void;
}

interface MockStore {
  byId: Map<number, Task>;
  nextId: number;
}

function isoNow(): string {
  return new Date().toISOString();
}

function newTaskRow(input: CreateTaskInput, id: number, principalId: number): Task {
  const now = isoNow();
  return {
    id,
    parentId: input.parentId ?? null,
    title: input.title.trim(),
    notes: input.notes ?? '',
    status: 'open',
    deferUntil: input.deferUntil ?? null,
    dueAt: input.dueAt ?? null,
    createdBy: principalId,
    assignedTo: input.assignedTo ?? null,
    updatedBy: principalId,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
    position: id,
  };
}

function applyFilter(tasks: readonly Task[], input: ListTasksInput | undefined, principalId: number): Task[] {
  let result = [...tasks];
  if (input?.trash) {
    result = result.filter((t) => t.deletedAt !== null);
  } else {
    result = result.filter((t) => t.deletedAt === null);
  }
  if (input?.parentId !== undefined) {
    if (input.parentId === null) {
      result = result.filter((t) => t.parentId === null);
    } else {
      result = result.filter((t) => t.parentId === input.parentId);
    }
  }
  if (input?.assignedTo !== undefined) {
    const target = input.assignedTo === 'me' ? principalId : input.assignedTo;
    result = result.filter((t) => t.assignedTo === target);
  }
  if (input?.createdBy !== undefined) {
    const target = input.createdBy === 'me' ? principalId : input.createdBy;
    result = result.filter((t) => t.createdBy === target);
  }
  if (input?.status !== undefined) {
    result = result.filter((t) => t.status === input.status);
  }
  if (input?.inbox) {
    result = result.filter((t) => t.parentId === null && t.assignedTo === null && t.deferUntil === null);
  }
  if (input?.today) {
    const cutoff = input.todayCutoff ?? new Date().toISOString();
    result = result.filter((t) => t.deferUntil === null || t.deferUntil <= cutoff);
    result = result.filter((t) => t.status === 'open');
  }
  if (input?.q !== undefined && input.q.trim().length > 0) {
    const needle = input.q.trim().toLowerCase();
    result = result.filter(
      (t) => t.title.toLowerCase().includes(needle) || t.notes.toLowerCase().includes(needle),
    );
  }
  return result.sort((a, b) => a.position - b.position || a.id - b.id);
}

export function createMockEalClient(): MockEalClient {
  const taskEventSubscribers = new Set<(event: TaskEvent) => void>();
  const connectionStateSubscribers = new Set<(state: WsConnectionState) => void>();
  let connectionState: WsConnectionState = 'idle';
  let reconnectNowCalls = 0;

  function emitConnectionState(state: WsConnectionState): void {
    if (state === connectionState) return;
    connectionState = state;
    for (const h of connectionStateSubscribers) h(state);
  }

  const chatEventSubscribers = new Set<(event: ChatBrowserEvent) => void>();
  let currentUser: CurrentUser | null = null;
  let seededUsers: HouseholdMember[] = [];
  let cliPairStart: CliPairStartResult | null = null;
  let cliPairPolls: CliPairPollResult[] = [];
  const cliPairClaims: CliPairClaimInput[] = [];
  let nextSignInError: Error | null = null;
  let nextRegisterError: Error | null = null;
  let nextTaskError: Error | null = null;
  let store: MockStore = { byId: new Map(), nextId: 1 };
  let sentChats: string[] = [];
  let chatReplies: ChatAgentReply[] = [];
  let seededMessages: Message[] = [];
  let agentRequestHandler: ((request: ChatAgentRequest) => void) | null = null;

  function requireSignedIn(): CurrentUser {
    if (currentUser === null) {
      throw new Error('MockEalClient: task operation needs setCurrentUser() first.');
    }
    return currentUser;
  }

  function consumeTaskError(): void {
    if (nextTaskError !== null) {
      const err = nextTaskError;
      nextTaskError = null;
      throw err;
    }
  }

  function emit(event: TaskEvent): void {
    for (const h of taskEventSubscribers) h(event);
  }

  function snapshot(task: Task): Task {
    return { ...task };
  }

  return {
    async connect(): Promise<void> {
      emitConnectionState('connected');
    },
    async disconnect(): Promise<void> {
      emitConnectionState('idle');
    },

    connectionState(): WsConnectionState {
      return connectionState;
    },

    subscribeConnectionState(handler: (state: WsConnectionState) => void): () => void {
      connectionStateSubscribers.add(handler);
      return () => connectionStateSubscribers.delete(handler);
    },

    reconnectNow(): void {
      reconnectNowCalls += 1;
    },

    emitConnectionState(state: WsConnectionState): void {
      emitConnectionState(state);
    },

    peekReconnectNowCalls(): number {
      return reconnectNowCalls;
    },

    async registerPasskey(displayName: string, inviteCode: string): Promise<CurrentUser> {
      void inviteCode;
      if (nextRegisterError !== null) {
        const err = nextRegisterError;
        nextRegisterError = null;
        throw err;
      }
      const user: CurrentUser = { userId: 1, displayName };
      currentUser = user;
      return user;
    },

    async signInWithPasskey(): Promise<CurrentUser> {
      if (nextSignInError !== null) {
        const err = nextSignInError;
        nextSignInError = null;
        throw err;
      }
      if (currentUser === null) {
        throw new Error('MockEalClient.signInWithPasskey: no current user set. Call setCurrentUser() first.');
      }
      return currentUser;
    },

    async signOut(): Promise<void> {
      currentUser = null;
    },

    async getCurrentUser(): Promise<CurrentUser | null> {
      return currentUser;
    },

    async listUsers(): Promise<HouseholdMember[]> {
      return [...seededUsers];
    },

    async setUserInIvrMenu(id, inIvrMenu): Promise<HouseholdMember> {
      const idx = seededUsers.findIndex((u) => u.id === id);
      if (idx < 0) throw new Error(`MockEalClient.setUserInIvrMenu: no user with id=${id}`);
      const next: HouseholdMember = { ...seededUsers[idx]!, inIvrMenu };
      seededUsers[idx] = next;
      return next;
    },

    async startCliPair(): Promise<CliPairStartResult> {
      if (cliPairStart === null) {
        throw new Error('MockEalClient.startCliPair: no start registered. Call mockCliPair() first.');
      }
      return cliPairStart;
    },

    async pollCliPair(_input: { deviceCode: string }): Promise<CliPairPollResult> {
      if (cliPairPolls.length === 0) {
        throw new Error('MockEalClient.pollCliPair: no poll results registered. Call mockCliPair() first.');
      }
      const next = cliPairPolls.length === 1 ? cliPairPolls[0]! : cliPairPolls.shift()!;
      return next;
    },

    async claimCliPair(input: CliPairClaimInput): Promise<{ ok: true }> {
      cliPairClaims.push(input);
      return { ok: true };
    },

    async listFamilyPhoneDevices() {
      requireSignedIn();
      return [];
    },

    async startFamilyPhonePair() {
      requireSignedIn();
      return {
        userCode: 'TST-001',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },

    async completeFamilyPhonePair(input) {
      if (input.publicKey.length === 0) throw new Error('public_key is required');
      if (input.label.trim().length === 0) throw new Error('label is required');
      return { deviceId: 1 };
    },

    async deleteFamilyPhoneDevice() {
      /* mock: no-op */
    },

    async renameFamilyPhoneDevice() {
      /* mock: no-op */
    },

    async connectFamilyPhoneDevice(input) {
      // Mock: returns a no-op handle. Tests that need to exercise the call
      // signalling pump should spin up the real api against an in-memory db.
      return {
        deviceId: input.deviceId,
        placeCall() {},
        placePstn() {},
        acceptCall() {},
        rejectCall() {},
        cancelCall() {},
        hangup() {},
        subscribe() { return () => {}; },
        sendAudio() {},
        sendText() {},
        subscribeAudio() { return () => {}; },
        subscribePush() {},
        unsubscribePush() {},
        close() {},
      };
    },

    async listAgentRules(): Promise<AgentRule[]> {
      requireSignedIn();
      return [];
    },

    async upsertAgentRule(input: UpsertAgentRuleInput): Promise<AgentRule> {
      requireSignedIn();
      const now = isoNow();
      return {
        id: input.id ?? 1,
        name: input.name,
        enabled: input.enabled,
        targetDeviceId: input.targetDeviceId,
        kind: input.kind,
        body: input.body ?? null,
        systemPrompt: input.systemPrompt ?? null,
        nextFireAt: input.nextFireAt,
        intervalSec: input.intervalSec ?? null,
        cooldownSec: input.cooldownSec ?? 0,
        lastFiredAt: null,
        createdAt: now,
        updatedAt: now,
      };
    },

    async deleteAgentRule(): Promise<void> {
      /* mock: no-op */
    },

    async listPstnContacts(): Promise<PstnContact[]> {
      requireSignedIn();
      return [];
    },

    async createPstnContact(input: CreatePstnContactInput): Promise<PstnContact> {
      requireSignedIn();
      const now = isoNow();
      return {
        id: 1,
        e164: input.e164,
        label: input.label,
        allowIn: input.allowIn,
        allowOut: input.allowOut,
        intendedUserId: input.intendedUserId ?? null,
        createdAt: now,
        updatedAt: now,
      };
    },

    async updatePstnContact(input: UpdatePstnContactInput): Promise<PstnContact> {
      requireSignedIn();
      const now = isoNow();
      return {
        id: input.id,
        e164: '+440000000000',
        label: input.label,
        allowIn: input.allowIn,
        allowOut: input.allowOut,
        intendedUserId: input.intendedUserId ?? null,
        createdAt: now,
        updatedAt: now,
      };
    },

    async deletePstnContact(): Promise<void> {
      /* mock: no-op */
    },

    async createAgentPlaceCallAction(input: {
      targetDeviceId: number;
      trigger: AgentActionTrigger;
      ruleId?: number | null;
    }): Promise<AgentAction | null> {
      requireSignedIn();
      return {
        id: 1,
        ruleId: input.ruleId ?? null,
        kind: 'place_call',
        targetDeviceId: input.targetDeviceId,
        trigger: input.trigger,
        result: 'pending',
        callId: null,
        error: null,
        createdAt: isoNow(),
        finishedAt: null,
      };
    },

    async attachAgentCall(actionId: number, callId: string): Promise<AgentAction> {
      requireSignedIn();
      return {
        id: actionId,
        ruleId: null,
        kind: 'place_call',
        targetDeviceId: 1,
        trigger: 'tool',
        result: 'pending',
        callId,
        error: null,
        createdAt: isoNow(),
        finishedAt: null,
      };
    },

    async finishAgentAction(
      actionId: number,
      input: {
        result: Exclude<AgentActionResult, 'pending'>;
        callId?: string | null;
        error?: string | null;
      },
    ): Promise<AgentAction> {
      requireSignedIn();
      return {
        id: actionId,
        ruleId: null,
        kind: 'place_call',
        targetDeviceId: 1,
        trigger: 'tool',
        result: input.result,
        callId: input.callId ?? null,
        error: input.error ?? null,
        createdAt: isoNow(),
        finishedAt: isoNow(),
      };
    },

    async listAgentActions(): Promise<AgentAction[]> {
      requireSignedIn();
      return [];
    },

    async getConversationSessionId(): Promise<string | null> {
      requireSignedIn();
      return null;
    },

    async setConversationSessionId(): Promise<void> {
      requireSignedIn();
    },

    async postVoiceMessage(input: PostVoiceMessageInput): Promise<VoiceMessage> {
      requireSignedIn();
      return {
        id: 1,
        toDeviceId: input.toDeviceId,
        fromDeviceId: input.fromDeviceId ?? null,
        fromExternal: input.fromExternal ?? null,
        body: input.body,
        sampleRate: input.sampleRate ?? 24000,
        channels: input.channels ?? 1,
        durationMs: Math.max(
          1,
          Math.round((input.audio.byteLength * 1000) / ((input.sampleRate ?? 24000) * (input.channels ?? 1) * 2)),
        ),
        readAt: null,
        createdAt: isoNow(),
      };
    },

    async listVoiceMessages(): Promise<VoiceMessage[]> {
      requireSignedIn();
      return [];
    },

    async getVoiceMessageAudio(): Promise<ArrayBuffer> {
      requireSignedIn();
      return new ArrayBuffer(0);
    },

    async markVoiceMessageRead(id: number): Promise<VoiceMessage> {
      requireSignedIn();
      return {
        id,
        toDeviceId: 1,
        fromDeviceId: null,
        fromExternal: null,
        body: '',
        sampleRate: 24000,
        channels: 1,
        durationMs: 1,
        readAt: isoNow(),
        createdAt: isoNow(),
      };
    },

    async createTask(input): Promise<Task> {
      consumeTaskError();
      const user = requireSignedIn();
      if (input.title.trim().length === 0) {
        throw new Error('title is required');
      }
      const id = store.nextId++;
      const row = newTaskRow(input, id, user.userId);
      store.byId.set(id, row);
      const out = snapshot(row);
      emit({ type: 'task:created', topic: 'tasks', payload: out });
      return out;
    },

    async listTasks(input): Promise<Task[]> {
      const user = requireSignedIn();
      const all = Array.from(store.byId.values());
      return applyFilter(all, input, user.userId).map(snapshot);
    },

    async getTask(id): Promise<TaskDetail> {
      requireSignedIn();
      const task = store.byId.get(id);
      if (!task) throw new Error(`task ${id} not found`);
      const children = Array.from(store.byId.values())
        .filter((t) => t.parentId === id && t.deletedAt === null)
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map(snapshot);
      return { task: snapshot(task), children };
    },

    async updateTask(id, input): Promise<Task> {
      consumeTaskError();
      const user = requireSignedIn();
      const task = store.byId.get(id);
      if (!task || task.deletedAt !== null) throw new Error(`task ${id} not found or in trash`);
      const updated: Task = {
        ...task,
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.deferUntil !== undefined ? { deferUntil: input.deferUntil } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        updatedBy: user.userId,
        updatedAt: isoNow(),
      };
      store.byId.set(id, updated);
      const out = snapshot(updated);
      emit({ type: 'task:updated', topic: 'tasks', payload: out });
      return out;
    },

    async completeTask(id): Promise<Task> {
      consumeTaskError();
      const user = requireSignedIn();
      const task = store.byId.get(id);
      if (!task || task.deletedAt !== null) throw new Error(`task ${id} not found or in trash`);
      if (task.status === 'done') return snapshot(task);
      const updated: Task = {
        ...task,
        status: 'done',
        completedAt: isoNow(),
        updatedBy: user.userId,
        updatedAt: isoNow(),
      };
      store.byId.set(id, updated);
      const out = snapshot(updated);
      emit({ type: 'task:updated', topic: 'tasks', payload: out });
      return out;
    },

    async reopenTask(id): Promise<Task> {
      consumeTaskError();
      const user = requireSignedIn();
      const task = store.byId.get(id);
      if (!task || task.deletedAt !== null) throw new Error(`task ${id} not found or in trash`);
      if (task.status === 'open') return snapshot(task);
      const updated: Task = {
        ...task,
        status: 'open',
        completedAt: null,
        updatedBy: user.userId,
        updatedAt: isoNow(),
      };
      store.byId.set(id, updated);
      const out = snapshot(updated);
      emit({ type: 'task:updated', topic: 'tasks', payload: out });
      return out;
    },

    async deleteTask(id): Promise<Task> {
      consumeTaskError();
      const user = requireSignedIn();
      const task = store.byId.get(id);
      if (!task) throw new Error(`task ${id} not found`);
      const updated: Task = {
        ...task,
        deletedAt: task.deletedAt ?? isoNow(),
        updatedBy: user.userId,
        updatedAt: isoNow(),
      };
      store.byId.set(id, updated);
      const out = snapshot(updated);
      emit({ type: 'task:deleted', topic: 'tasks', payload: out });
      return out;
    },

    async restoreTask(id): Promise<Task> {
      consumeTaskError();
      const user = requireSignedIn();
      const task = store.byId.get(id);
      if (!task) throw new Error(`task ${id} not found`);
      const updated: Task = {
        ...task,
        deletedAt: null,
        status: 'open',
        completedAt: null,
        updatedBy: user.userId,
        updatedAt: isoNow(),
      };
      store.byId.set(id, updated);
      const out = snapshot(updated);
      emit({ type: 'task:updated', topic: 'tasks', payload: out });
      return out;
    },

    async cloneTask(id): Promise<CloneTaskResult> {
      consumeTaskError();
      const user = requireSignedIn();
      const root = store.byId.get(id);
      if (!root || root.deletedAt !== null) throw new Error(`task ${id} not found or in trash`);

      const cloned: Task[] = [];
      const oldToNew = new Map<number, number>();

      const newRootId = store.nextId++;
      const newRoot: Task = {
        ...root,
        id: newRootId,
        status: 'open',
        completedAt: null,
        deletedAt: null,
        createdBy: user.userId,
        updatedBy: user.userId,
        createdAt: isoNow(),
        updatedAt: isoNow(),
        position: newRootId,
      };
      store.byId.set(newRootId, newRoot);
      oldToNew.set(root.id, newRootId);
      cloned.push(snapshot(newRoot));

      // BFS over children. Mock doesn't bother with depth ordering — the
      // browser-test surface doesn't care about insertion order at this layer.
      const queue: number[] = [root.id];
      while (queue.length > 0) {
        const parentOld = queue.shift()!;
        const children = Array.from(store.byId.values()).filter(
          (t) => t.parentId === parentOld && t.deletedAt === null && !oldToNew.has(t.id),
        );
        for (const child of children) {
          const newId = store.nextId++;
          const newChild: Task = {
            ...child,
            id: newId,
            parentId: oldToNew.get(child.parentId ?? -1) ?? null,
            status: 'open',
            completedAt: null,
            deletedAt: null,
            createdBy: user.userId,
            updatedBy: user.userId,
            createdAt: isoNow(),
            updatedAt: isoNow(),
            position: newId,
          };
          store.byId.set(newId, newChild);
          oldToNew.set(child.id, newId);
          cloned.push(snapshot(newChild));
          queue.push(child.id);
        }
      }

      const result: CloneTaskResult = { rootId: newRootId, tasks: cloned };
      emit({ type: 'task:tree-cloned', topic: 'tasks', payload: result });
      return result;
    },

    subscribeTaskEvents(handler: (event: TaskEvent) => void): () => void {
      taskEventSubscribers.add(handler);
      return () => taskEventSubscribers.delete(handler);
    },

    emitTaskEvent(event: TaskEvent): void {
      emit(event);
    },

    async listMessages(): Promise<Message[]> {
      return [...seededMessages];
    },

    async clearChat(): Promise<void> {
      seededMessages = [];
    },

    sendChat(text: string): void {
      sentChats.push(text);
    },

    subscribeChatEvents(handler: (event: ChatBrowserEvent) => void): () => void {
      chatEventSubscribers.add(handler);
      return () => chatEventSubscribers.delete(handler);
    },

    async connectAsAgent(handlers): Promise<void> {
      agentRequestHandler = handlers.onRequest;
    },

    sendChatReply(reply: ChatAgentReply): void {
      chatReplies.push(reply);
    },

    emitChatEvent(event: ChatBrowserEvent): void {
      for (const h of chatEventSubscribers) h(event);
    },

    seedMessages(messages: readonly Message[]): void {
      seededMessages = [...messages];
    },

    peekSentChats(): readonly string[] {
      return sentChats;
    },

    emitChatRequest(request: ChatAgentRequest): void {
      if (agentRequestHandler !== null) agentRequestHandler(request);
    },

    peekChatReplies(): readonly ChatAgentReply[] {
      return chatReplies;
    },

    setCurrentUser(user: CurrentUser | null): void {
      currentUser = user;
    },

    seedUsers(users: readonly HouseholdMember[]): void {
      seededUsers = [...users];
    },

    mockCliPair(input): void {
      cliPairStart = input.start;
      cliPairPolls = [...input.polls];
    },

    mockSignInError(err: Error | null): void {
      nextSignInError = err;
    },

    mockRegisterError(err: Error | null): void {
      nextRegisterError = err;
    },

    mockTaskError(err: Error | null): void {
      nextTaskError = err;
    },

    peekTasks(): readonly Task[] {
      return Array.from(store.byId.values());
    },

    reset(): void {
      taskEventSubscribers.clear();
      chatEventSubscribers.clear();
      currentUser = null;
      seededUsers = [];
      cliPairStart = null;
      cliPairPolls = [];
      cliPairClaims.length = 0;
      nextSignInError = null;
      nextRegisterError = null;
      nextTaskError = null;
      store = { byId: new Map(), nextId: 1 };
      sentChats = [];
      chatReplies = [];
      seededMessages = [];
      agentRequestHandler = null;
    },
  };
}

/**
 * Bidirectional compile-time parity check.
 *
 * If EalClient adds a method, _CheckMockCoversReal fails.
 * If MockEalClient adds a non-test-hook method that EalClient doesn't have,
 * _CheckRealCoversMock fails.
 */
type TestHookKeys =
  | 'emitTaskEvent'
  | 'emitConnectionState'
  | 'peekReconnectNowCalls'
  | 'setCurrentUser'
  | 'seedUsers'
  | 'mockCliPair'
  | 'mockSignInError'
  | 'mockRegisterError'
  | 'mockTaskError'
  | 'peekTasks'
  | 'emitChatEvent'
  | 'seedMessages'
  | 'peekSentChats'
  | 'emitChatRequest'
  | 'peekChatReplies'
  | 'reset';
type EalClientMethodKeys = keyof EalClient;
type MockMethodKeys = Exclude<keyof MockEalClient, TestHookKeys>;

type _CheckMockCoversReal = EalClientMethodKeys extends MockMethodKeys ? true : never;
type _CheckRealCoversMock = MockMethodKeys extends EalClientMethodKeys ? true : never;

const _checkMockCoversReal: _CheckMockCoversReal = true;
const _checkRealCoversMock: _CheckRealCoversMock = true;
void _checkMockCoversReal;
void _checkRealCoversMock;
