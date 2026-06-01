import { describe, expect, test } from 'bun:test';
import type {
  AgentAction,
  AgentActionResult,
  AgentRule,
  AgentRuleKind,
  EalClient,
  UpsertAgentRuleInput,
} from '@eal/client';
import { tickOnce } from './agent-scheduler.ts';

interface RecordedCreatePlaceCall {
  targetDeviceId: number;
  trigger: 'scheduled' | 'tool';
  ruleId: number | null;
}

interface FakeClientState {
  rules: AgentRule[];
  /** Override the next `createAgentPlaceCallAction` return value, FIFO. */
  placeCallQueue: Array<AgentAction | null>;
  recordedCreates: RecordedCreatePlaceCall[];
  recordedUpserts: UpsertAgentRuleInput[];
  listAgentRulesError: Error | null;
}

function defaultPlaceCall(input: RecordedCreatePlaceCall): AgentAction {
  return {
    id: 1,
    ruleId: input.ruleId,
    kind: 'place_call',
    targetDeviceId: input.targetDeviceId,
    trigger: input.trigger,
    result: 'pending',
    callId: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function makeFakeClient(state: FakeClientState): EalClient {
  function notImplemented(name: string): () => never {
    return () => {
      throw new Error(`fake EalClient: ${name} not stubbed`);
    };
  }
  return {
    connect: notImplemented('connect'),
    disconnect: notImplemented('disconnect'),
    registerPasskey: notImplemented('registerPasskey'),
    signInWithPasskey: notImplemented('signInWithPasskey'),
    signOut: notImplemented('signOut'),
    getCurrentUser: notImplemented('getCurrentUser'),
    listUsers: notImplemented('listUsers'),
    startCliPair: notImplemented('startCliPair'),
    pollCliPair: notImplemented('pollCliPair'),
    claimCliPair: notImplemented('claimCliPair'),
    createTask: notImplemented('createTask'),
    listTasks: notImplemented('listTasks'),
    getTask: notImplemented('getTask'),
    updateTask: notImplemented('updateTask'),
    completeTask: notImplemented('completeTask'),
    reopenTask: notImplemented('reopenTask'),
    deleteTask: notImplemented('deleteTask'),
    restoreTask: notImplemented('restoreTask'),
    cloneTask: notImplemented('cloneTask'),
    subscribeTaskEvents: notImplemented('subscribeTaskEvents'),
    listFamilyPhoneDevices: notImplemented('listFamilyPhoneDevices'),
    startFamilyPhonePair: notImplemented('startFamilyPhonePair'),
    completeFamilyPhonePair: notImplemented('completeFamilyPhonePair'),
    deleteFamilyPhoneDevice: notImplemented('deleteFamilyPhoneDevice'),
    renameFamilyPhoneDevice: notImplemented('renameFamilyPhoneDevice'),
    connectFamilyPhoneDevice: notImplemented('connectFamilyPhoneDevice'),
    async listAgentRules(): Promise<AgentRule[]> {
      if (state.listAgentRulesError !== null) throw state.listAgentRulesError;
      return state.rules;
    },
    async upsertAgentRule(input: UpsertAgentRuleInput): Promise<AgentRule> {
      state.recordedUpserts.push(input);
      const id = input.id ?? -1;
      const idx = state.rules.findIndex((r) => r.id === id);
      const now = new Date().toISOString();
      const updated: AgentRule = {
        id,
        name: input.name,
        enabled: input.enabled,
        targetDeviceId: input.targetDeviceId,
        kind: input.kind,
        body: input.body ?? null,
        systemPrompt: input.systemPrompt ?? null,
        nextFireAt: input.nextFireAt,
        intervalSec: input.intervalSec ?? null,
        cooldownSec: input.cooldownSec ?? 0,
        lastFiredAt: idx >= 0 ? state.rules[idx]?.lastFiredAt ?? null : null,
        createdAt: idx >= 0 ? state.rules[idx]?.createdAt ?? now : now,
        updatedAt: now,
      };
      if (idx >= 0) state.rules[idx] = updated;
      else state.rules.push(updated);
      return updated;
    },
    deleteAgentRule: notImplemented('deleteAgentRule'),
    listPstnContacts: notImplemented('listPstnContacts'),
    createPstnContact: notImplemented('createPstnContact'),
    updatePstnContact: notImplemented('updatePstnContact'),
    deletePstnContact: notImplemented('deletePstnContact'),
    async createAgentPlaceCallAction(input): Promise<AgentAction | null> {
      const recorded: RecordedCreatePlaceCall = {
        targetDeviceId: input.targetDeviceId,
        trigger: input.trigger,
        ruleId: input.ruleId ?? null,
      };
      state.recordedCreates.push(recorded);
      if (state.placeCallQueue.length > 0) {
        const head = state.placeCallQueue.shift();
        if (head === undefined) throw new Error('placeCallQueue underflow');
        return head;
      }
      return defaultPlaceCall(recorded);
    },
    attachAgentCall: notImplemented('attachAgentCall'),
    finishAgentAction: notImplemented('finishAgentAction'),
    listAgentActions: notImplemented('listAgentActions'),
    listMessages: notImplemented('listMessages'),
    clearChat: notImplemented('clearChat'),
    sendChat: notImplemented('sendChat'),
    subscribeChatEvents: notImplemented('subscribeChatEvents'),
    connectAsAgent: notImplemented('connectAsAgent'),
    sendChatReply: notImplemented('sendChatReply'),
    postVoiceMessage: notImplemented('postVoiceMessage'),
    listVoiceMessages: notImplemented('listVoiceMessages'),
    getVoiceMessageAudio: notImplemented('getVoiceMessageAudio'),
    markVoiceMessageRead: notImplemented('markVoiceMessageRead'),
    getConversationSessionId: notImplemented('getConversationSessionId'),
    setConversationSessionId: notImplemented('setConversationSessionId'),
  };
}

function rule(partial: Partial<AgentRule> & { id: number }): AgentRule {
  return {
    name: `rule-${partial.id}`,
    enabled: true,
    targetDeviceId: 100,
    kind: 'place_call' satisfies AgentRuleKind,
    body: 'ring',
    systemPrompt: null,
    nextFireAt: '2025-01-01T00:00:00.000Z',
    intervalSec: null,
    cooldownSec: 0,
    lastFiredAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...partial,
  };
}

function newState(rules: AgentRule[], placeCallQueue: Array<AgentAction | null> = []): FakeClientState {
  return {
    rules,
    placeCallQueue,
    recordedCreates: [],
    recordedUpserts: [],
    listAgentRulesError: null,
  };
}

const T = (iso: string) => new Date(iso);

describe('agent scheduler — tickOnce', () => {
  test('skips a rule whose nextFireAt is in the future', async () => {
    const state = newState([
      rule({ id: 1, nextFireAt: '2025-01-01T01:00:00.000Z' }),
    ]);
    const r = await tickOnce({
      client: makeFakeClient(state),
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
    });
    expect(r.due).toEqual([]);
    expect(state.recordedCreates).toEqual([]);
  });

  test('skips a disabled rule even when its nextFireAt is in the past', async () => {
    const state = newState([
      rule({
        id: 1,
        enabled: false,
        nextFireAt: '2024-12-01T00:00:00.000Z',
      }),
    ]);
    const r = await tickOnce({
      client: makeFakeClient(state),
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
    });
    expect(r.due).toEqual([]);
  });

  test('fires a due place_call rule: creates an action and advances nextFireAt', async () => {
    const state = newState([
      rule({
        id: 7,
        targetDeviceId: 42,
        nextFireAt: '2024-12-01T00:00:00.000Z',
        intervalSec: 3600,
      }),
    ]);
    const r = await tickOnce({
      client: makeFakeClient(state),
      now: () => T('2025-01-01T10:00:00.000Z'),
      log: () => {},
    });
    expect(r.advanced).toEqual([7]);
    expect(state.recordedCreates).toEqual([
      { targetDeviceId: 42, trigger: 'scheduled', ruleId: 7 },
    ]);
    expect(state.recordedUpserts).toHaveLength(1);
    const upsert = state.recordedUpserts[0];
    expect(upsert?.id).toBe(7);
    expect(upsert?.nextFireAt).toBe('2025-01-01T11:00:00.000Z');
  });

  test('one-shot rule (intervalSec=null) advances to a far-future sentinel and does not re-fire', async () => {
    const state = newState([
      rule({
        id: 9,
        nextFireAt: '2024-12-01T00:00:00.000Z',
        intervalSec: null,
      }),
    ]);
    const client = makeFakeClient(state);
    await tickOnce({
      client,
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
    });
    const second = await tickOnce({
      client,
      now: () => T('2025-01-01T01:00:00.000Z'),
      log: () => {},
    });
    expect(second.due).toEqual([]);
    expect(state.recordedCreates).toHaveLength(1);
  });

  test('busy lock (createAgentPlaceCallAction returns null) leaves the rule untouched', async () => {
    const state = newState(
      [
        rule({
          id: 3,
          nextFireAt: '2024-12-01T00:00:00.000Z',
          intervalSec: 60,
        }),
      ],
      [null],
    );
    const r = await tickOnce({
      client: makeFakeClient(state),
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
    });
    expect(r.busySkipped).toEqual([3]);
    expect(r.advanced).toEqual([]);
    expect(state.recordedUpserts).toEqual([]);
  });

  test('cooldown prevents re-fire when lastFiredAt is recent', async () => {
    const state = newState([
      rule({
        id: 5,
        nextFireAt: '2024-12-01T00:00:00.000Z',
        cooldownSec: 600,
        lastFiredAt: '2024-12-31T23:55:00.000Z',
      }),
    ]);
    const r = await tickOnce({
      client: makeFakeClient(state),
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
    });
    expect(r.due).toEqual([]);
  });

  test('cooldown lets the rule fire when enough time has passed', async () => {
    const state = newState([
      rule({
        id: 5,
        nextFireAt: '2024-12-01T00:00:00.000Z',
        intervalSec: 60,
        cooldownSec: 600,
        lastFiredAt: '2024-12-31T23:30:00.000Z',
      }),
    ]);
    const r = await tickOnce({
      client: makeFakeClient(state),
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
    });
    expect(r.advanced).toEqual([5]);
  });

  test('voice_message rules without tts wired stay on notImplemented', async () => {
    const state = newState([
      rule({
        id: 11,
        kind: 'voice_message',
        nextFireAt: '2024-12-01T00:00:00.000Z',
        intervalSec: 3600,
      }),
    ]);
    const r = await tickOnce({
      client: makeFakeClient(state),
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
    });
    expect(r.notImplemented).toEqual([11]);
    expect(state.recordedCreates).toEqual([]);
    expect(state.recordedUpserts).toEqual([]);
  });

  test('voice_message rule with a body synthesises, posts, and advances', async () => {
    const state = newState([
      rule({
        id: 17,
        kind: 'voice_message',
        targetDeviceId: 50,
        body: 'time for bed',
        systemPrompt: null,
        nextFireAt: '2024-12-01T00:00:00.000Z',
        intervalSec: 86_400,
      }),
    ]);
    const postedTexts: string[] = [];
    const postedSizes: number[] = [];
    const client = makeFakeClient(state);
    client.postVoiceMessage = async (input) => {
      postedTexts.push(input.body);
      postedSizes.push(input.audio.byteLength);
      return {
        id: 1,
        toDeviceId: input.toDeviceId,
        fromDeviceId: input.fromDeviceId ?? null,
        fromExternal: null,
        body: input.body,
        sampleRate: input.sampleRate ?? 24000,
        channels: input.channels ?? 1,
        durationMs: 100,
        readAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
    };
    // Fake TTS: yield a single 480-sample frame regardless of input.
    const fakeTts = {
      async *speak(_text: string): AsyncIterable<Int16Array> {
        yield new Int16Array(480);
      },
    };
    const r = await tickOnce({
      client,
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
      tts: fakeTts,
      agentDeviceId: 99,
    });
    expect(r.voiceMessagesSent).toEqual([17]);
    expect(postedTexts).toEqual(['time for bed']);
    // 480 samples × 2 bytes = 960 bytes of LE PCM
    expect(postedSizes).toEqual([960]);
    expect(state.recordedUpserts).toHaveLength(1);
    expect(state.recordedUpserts[0]?.nextFireAt).toBe('2025-01-02T00:00:00.000Z');
  });

  test('voice_message rule with a systemPrompt asks claudeRunner for the text', async () => {
    const state = newState([
      rule({
        id: 18,
        kind: 'voice_message',
        targetDeviceId: 50,
        body: null,
        systemPrompt: 'Compose a short reminder.',
        nextFireAt: '2024-12-01T00:00:00.000Z',
        intervalSec: null,
      }),
    ]);
    const client = makeFakeClient(state);
    const postedTexts: string[] = [];
    client.postVoiceMessage = async (input) => {
      postedTexts.push(input.body);
      return {
        id: 1,
        toDeviceId: input.toDeviceId,
        fromDeviceId: input.fromDeviceId ?? null,
        fromExternal: null,
        body: input.body,
        sampleRate: input.sampleRate ?? 24000,
        channels: input.channels ?? 1,
        durationMs: 50,
        readAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
    };
    const fakeTts = {
      async *speak(_text: string): AsyncIterable<Int16Array> {
        yield new Int16Array(240);
      },
    };
    const r = await tickOnce({
      client,
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
      tts: fakeTts,
      agentDeviceId: 99,
      claudeRunner: async () => ({ content: 'Generated reminder.', sessionId: 'fake' }),
    });
    expect(r.voiceMessagesSent).toEqual([18]);
    expect(postedTexts).toEqual(['Generated reminder.']);
  });

  test('voice_message rule with systemPrompt and no claudeRunner is parked', async () => {
    const state = newState([
      rule({
        id: 19,
        kind: 'voice_message',
        targetDeviceId: 50,
        body: null,
        systemPrompt: 'generate something',
        nextFireAt: '2024-12-01T00:00:00.000Z',
        intervalSec: null,
      }),
    ]);
    const fakeTts = {
      async *speak(_text: string): AsyncIterable<Int16Array> {
        yield new Int16Array(0);
      },
    };
    const r = await tickOnce({
      client: makeFakeClient(state),
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
      tts: fakeTts,
      agentDeviceId: 99,
    });
    expect(r.notImplemented).toEqual([19]);
    expect(state.recordedUpserts).toEqual([]);
  });

  test('listAgentRules failure is captured and the tick returns empty', async () => {
    const state = newState([]);
    state.listAgentRulesError = new Error('boom');
    const logs: string[] = [];
    const r = await tickOnce({
      client: makeFakeClient(state),
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: (line) => logs.push(line),
    });
    expect(r.due).toEqual([]);
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
  });

  test('dialer sweep dials a pending action that has no callId yet', async () => {
    const state = newState([]);
    const action: AgentAction = {
      id: 99,
      ruleId: null,
      kind: 'place_call',
      targetDeviceId: 42,
      trigger: 'tool',
      result: 'pending',
      callId: null,
      error: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      finishedAt: null,
    };
    const client = makeFakeClient(state);
    client.listAgentActions = async () => [action];

    const dialed: number[] = [];
    const dialer = {
      async dial(input: { id: number; targetDeviceId: number }) {
        dialed.push(input.id);
      },
      close() {},
    };

    const r = await tickOnce({
      client,
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
      dialer,
    });
    expect(dialed).toEqual([99]);
    expect(r.dialed).toEqual([99]);
  });

  test('dialer sweep skips actions that already have a callId or are not pending', async () => {
    const state = newState([]);
    const client = makeFakeClient(state);
    client.listAgentActions = async () => [
      {
        id: 1,
        ruleId: null,
        kind: 'place_call',
        targetDeviceId: 42,
        trigger: 'tool',
        result: 'pending',
        callId: 'already-dialed',
        error: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        finishedAt: null,
      },
      {
        id: 2,
        ruleId: null,
        kind: 'place_call',
        targetDeviceId: 42,
        trigger: 'tool',
        result: 'answered',
        callId: 'done',
        error: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        finishedAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    const dialed: number[] = [];
    const r = await tickOnce({
      client,
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
      dialer: {
        async dial(input: { id: number; targetDeviceId: number }) {
          dialed.push(input.id);
        },
        close() {},
      },
    });
    expect(dialed).toEqual([]);
    expect(r.dialed).toEqual([]);
  });

  test('dial errors land on dialErrors without aborting the tick', async () => {
    const state = newState([]);
    const client = makeFakeClient(state);
    client.listAgentActions = async () => [
      {
        id: 7,
        ruleId: null,
        kind: 'place_call',
        targetDeviceId: 42,
        trigger: 'tool',
        result: 'pending',
        callId: null,
        error: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        finishedAt: null,
      },
    ];
    const r = await tickOnce({
      client,
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
      dialer: {
        async dial() {
          throw new Error('target-offline');
        },
        close() {},
      },
    });
    expect(r.dialErrors).toEqual([{ actionId: 7, message: 'target-offline' }]);
  });

  test('per-rule errors are captured without aborting the tick', async () => {
    const state = newState(
      [
        rule({
          id: 1,
          nextFireAt: '2024-12-01T00:00:00.000Z',
          intervalSec: 3600,
        }),
        rule({
          id: 2,
          nextFireAt: '2024-12-01T00:00:00.000Z',
          intervalSec: 3600,
        }),
      ],
      [],
    );
    // First create throws; second succeeds.
    const client = makeFakeClient(state);
    let firstCall = true;
    const originalCreate = client.createAgentPlaceCallAction;
    client.createAgentPlaceCallAction = async (input) => {
      if (firstCall) {
        firstCall = false;
        throw new Error('network down');
      }
      return originalCreate.call(client, input);
    };
    const r = await tickOnce({
      client,
      now: () => T('2025-01-01T00:00:00.000Z'),
      log: () => {},
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.ruleId).toBe(1);
    expect(r.advanced).toEqual([2]);
  });
});

/** Used in tests to satisfy the `AgentActionResult` discriminant where
 * the value is irrelevant; left here to keep all imports above touched
 * by at least one reference. */
const _unused: AgentActionResult = 'pending';
void _unused;
