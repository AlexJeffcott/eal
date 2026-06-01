import { describe, expect, test } from 'bun:test';
import type {
  AgentAction,
  AgentActionResult,
  EalClient,
  FamilyPhoneCallEvent,
  FamilyPhoneDeviceConnection,
} from '@eal/client';
import { delay } from '@eal/shared';
import { createAgentOutboundDialer } from './agent-outbound-dialer.ts';

interface FakeConnection extends FamilyPhoneDeviceConnection {
  readonly placeCalls: number[];
  emit(event: FamilyPhoneCallEvent): void;
}

function makeConnection(): FakeConnection {
  const placeCalls: number[] = [];
  const subscribers = new Set<(event: FamilyPhoneCallEvent) => void>();
  return {
    deviceId: 1,
    placeCalls,
    placeCall(targetDeviceId) {
      placeCalls.push(targetDeviceId);
    },
    placePstn() {},
    acceptCall() {},
    rejectCall() {},
    cancelCall() {},
    hangup() {},
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    sendAudio() {},
    sendText() {},
    subscribeAudio() {
      return () => {};
    },
    subscribePush() {},
    unsubscribePush() {},
    close() {},
    emit(event) {
      for (const h of subscribers) h(event);
    },
  };
}

interface AttachCall {
  actionId: number;
  callId: string;
}
interface FinishCall {
  actionId: number;
  result: Exclude<AgentActionResult, 'pending'>;
  callId: string | null;
  error: string | null;
}

interface FakeClient {
  client: EalClient;
  attachCalls: AttachCall[];
  finishCalls: FinishCall[];
  /** When set, attachAgentCall throws on first invocation. */
  attachFailures: number;
}

function makeClient(): FakeClient {
  const attachCalls: AttachCall[] = [];
  const finishCalls: FinishCall[] = [];
  let attachFailures = 0;
  function notImplemented(name: string): () => never {
    return () => {
      throw new Error(`fake EalClient: ${name} not stubbed`);
    };
  }
  const client: EalClient = {
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
    listAgentRules: notImplemented('listAgentRules'),
    upsertAgentRule: notImplemented('upsertAgentRule'),
    deleteAgentRule: notImplemented('deleteAgentRule'),
    listPstnContacts: notImplemented('listPstnContacts'),
    createPstnContact: notImplemented('createPstnContact'),
    updatePstnContact: notImplemented('updatePstnContact'),
    deletePstnContact: notImplemented('deletePstnContact'),
    createAgentPlaceCallAction: notImplemented('createAgentPlaceCallAction'),
    async attachAgentCall(actionId, callId): Promise<AgentAction> {
      if (attachFailures > 0) {
        attachFailures -= 1;
        throw new Error('attach failed');
      }
      attachCalls.push({ actionId, callId });
      return makeAction(actionId, { callId });
    },
    async finishAgentAction(actionId, input): Promise<AgentAction> {
      finishCalls.push({
        actionId,
        result: input.result,
        callId: input.callId ?? null,
        error: input.error ?? null,
      });
      return makeAction(actionId, {
        result: input.result,
        callId: input.callId ?? null,
        finishedAt: new Date().toISOString(),
        error: input.error ?? null,
      });
    },
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
  return {
    client,
    attachCalls,
    finishCalls,
    get attachFailures(): number {
      return attachFailures;
    },
    set attachFailures(n: number) {
      attachFailures = n;
    },
  };
}

function makeAction(id: number, overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id,
    ruleId: null,
    kind: 'place_call',
    targetDeviceId: 42,
    trigger: 'scheduled',
    result: 'pending',
    callId: null,
    error: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

describe('agent outbound dialer', () => {
  test('dial sends the invite and resolves once invite-ack lands and is attached', async () => {
    const conn = makeConnection();
    const fake = makeClient();
    const dialer = createAgentOutboundDialer({
      client: fake.client,
      connection: conn,
      log: () => {},
    });
    const dialing = dialer.dial({ id: 11, targetDeviceId: 42 });
    expect(conn.placeCalls).toEqual([42]);

    conn.emit({ type: 'call:invite-ack', callId: 'cid-1' });
    // Allow microtasks to flush the async attach.
    await delay(5);
    await dialing;
    expect(fake.attachCalls).toEqual([{ actionId: 11, callId: 'cid-1' }]);
  });

  test('invite-failed finishes the action with result=failed and rejects the dial', async () => {
    const conn = makeConnection();
    const fake = makeClient();
    const dialer = createAgentOutboundDialer({
      client: fake.client,
      connection: conn,
      log: () => {},
    });
    const dialing = dialer.dial({ id: 12, targetDeviceId: 42 });
    conn.emit({ type: 'call:invite-failed', reason: 'target-offline' });
    await expect(dialing).rejects.toThrow(/target-offline/);
    await delay(5);
    expect(fake.finishCalls).toEqual([
      {
        actionId: 12,
        result: 'failed',
        callId: null,
        error: 'target-offline',
      },
    ]);
  });

  test('accept then hung-up settles the action as answered', async () => {
    const conn = makeConnection();
    const fake = makeClient();
    const dialer = createAgentOutboundDialer({
      client: fake.client,
      connection: conn,
      log: () => {},
    });
    const dialing = dialer.dial({ id: 13, targetDeviceId: 42 });
    conn.emit({ type: 'call:invite-ack', callId: 'cid-x' });
    await delay(5);
    await dialing;

    conn.emit({ type: 'call:accepted', callId: 'cid-x' });
    conn.emit({ type: 'call:hung-up', callId: 'cid-x' });
    await delay(5);
    expect(fake.finishCalls).toEqual([
      { actionId: 13, result: 'answered', callId: 'cid-x', error: null },
    ]);
  });

  test('call:rejected finishes the action as rejected', async () => {
    const conn = makeConnection();
    const fake = makeClient();
    const dialer = createAgentOutboundDialer({
      client: fake.client,
      connection: conn,
      log: () => {},
    });
    const dialing = dialer.dial({ id: 14, targetDeviceId: 42 });
    conn.emit({ type: 'call:invite-ack', callId: 'cid-y' });
    await delay(5);
    await dialing;

    conn.emit({ type: 'call:rejected', callId: 'cid-y' });
    await delay(5);
    expect(fake.finishCalls).toEqual([
      { actionId: 14, result: 'rejected', callId: 'cid-y', error: null },
    ]);
  });

  test('call:unanswered finishes the action as unanswered', async () => {
    const conn = makeConnection();
    const fake = makeClient();
    const dialer = createAgentOutboundDialer({
      client: fake.client,
      connection: conn,
      log: () => {},
    });
    const dialing = dialer.dial({ id: 15, targetDeviceId: 42 });
    conn.emit({ type: 'call:invite-ack', callId: 'cid-z' });
    await delay(5);
    await dialing;

    conn.emit({ type: 'call:unanswered', callId: 'cid-z' });
    await delay(5);
    expect(fake.finishCalls).toEqual([
      { actionId: 15, result: 'unanswered', callId: 'cid-z', error: null },
    ]);
  });

  test('hung-up without a prior accept finishes the action as failed', async () => {
    const conn = makeConnection();
    const fake = makeClient();
    const dialer = createAgentOutboundDialer({
      client: fake.client,
      connection: conn,
      log: () => {},
    });
    const dialing = dialer.dial({ id: 16, targetDeviceId: 42 });
    conn.emit({ type: 'call:invite-ack', callId: 'cid-h' });
    await delay(5);
    await dialing;

    conn.emit({ type: 'call:hung-up', callId: 'cid-h', reason: 'peer-disconnect' });
    await delay(5);
    expect(fake.finishCalls).toHaveLength(1);
    expect(fake.finishCalls[0]?.result).toBe('failed');
    expect(fake.finishCalls[0]?.error).toBe('hung-up-without-accept');
  });

  test('call:* events for inbound calls (no matching outbound row) are ignored', async () => {
    const conn = makeConnection();
    const fake = makeClient();
    createAgentOutboundDialer({
      client: fake.client,
      connection: conn,
      log: () => {},
    });
    conn.emit({ type: 'call:incoming', callId: 'inbound', fromDeviceId: 99 });
    conn.emit({ type: 'call:accepted', callId: 'inbound' });
    conn.emit({ type: 'call:hung-up', callId: 'inbound' });
    await delay(5);
    expect(fake.finishCalls).toEqual([]);
  });

  test('a second concurrent dial rejects with a clear error', async () => {
    const conn = makeConnection();
    const fake = makeClient();
    const dialer = createAgentOutboundDialer({
      client: fake.client,
      connection: conn,
      log: () => {},
    });
    void dialer.dial({ id: 21, targetDeviceId: 42 });
    await expect(dialer.dial({ id: 22, targetDeviceId: 42 })).rejects.toThrow(
      /dialer busy/,
    );
  });

  test('close rejects an in-flight dial and clears subscriptions', async () => {
    const conn = makeConnection();
    const fake = makeClient();
    const dialer = createAgentOutboundDialer({
      client: fake.client,
      connection: conn,
      log: () => {},
    });
    const dialing = dialer.dial({ id: 31, targetDeviceId: 42 });
    dialer.close();
    await expect(dialing).rejects.toThrow(/dialer closed/);
    // After close the event handler is gone, so further events do nothing.
    conn.emit({ type: 'call:invite-ack', callId: 'late' });
    await delay(5);
    expect(fake.attachCalls).toEqual([]);
  });
});
