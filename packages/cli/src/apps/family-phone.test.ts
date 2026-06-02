import { describe, expect, test } from 'bun:test';
import type {
  AgentAction,
  AgentActionTrigger,
  EalClient,
  FamilyPhoneDevice,
} from '@eal/client';
import { familyPhoneMcpApp, resolveFamilyPhoneContact } from './family-phone.ts';

/**
 * Builds a partial EalClient that satisfies only the two methods
 * `place_call` exercises. Cast through `unknown` is not permitted in
 * this codebase — instead we return a fully-typed `EalClient` whose
 * untouched methods throw a clear marker if a future test path reaches
 * for them.
 */
function makeFakeClient(opts: {
  devices: FamilyPhoneDevice[];
  /** Override the result of createAgentPlaceCallAction. Defaults to a
   * synthesised pending action. */
  placeCallResult?: AgentAction | null;
  /** Captured args from createAgentPlaceCallAction calls. */
  recorded: {
    placeCallCalls: Array<{ targetDeviceId: number; trigger: AgentActionTrigger }>;
  };
}): EalClient {
  function notImplemented(name: string): () => never {
    return () => {
      throw new Error(`fake EalClient: ${name} not stubbed for this test`);
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
    setUserInIvrMenu: notImplemented('setUserInIvrMenu'),
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
    async listFamilyPhoneDevices(): Promise<FamilyPhoneDevice[]> {
      return opts.devices;
    },
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
    async createAgentPlaceCallAction(input): Promise<AgentAction | null> {
      opts.recorded.placeCallCalls.push({
        targetDeviceId: input.targetDeviceId,
        trigger: input.trigger,
      });
      if (opts.placeCallResult !== undefined) return opts.placeCallResult;
      return {
        id: 42,
        ruleId: null,
        kind: 'place_call',
        targetDeviceId: input.targetDeviceId,
        trigger: input.trigger,
        result: 'pending',
        callId: null,
        error: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      };
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

function device(
  partial: Partial<FamilyPhoneDevice> & { id: number; label: string },
): FamilyPhoneDevice {
  return {
    kind: 'handset',
    createdAt: '2025-01-01T00:00:00',
    pairedAt: null,
    ownerUserId: 1,
    ownerDisplayName: 'alex',
    online: true,
    ...partial,
  };
}

function findPlaceCallTool() {
  const tool = familyPhoneMcpApp.tools.find((t) => t.name === 'place_call');
  if (!tool) throw new Error('place_call tool not found');
  return tool;
}

describe('resolveFamilyPhoneContact', () => {
  test('matches case-insensitively and ignores surrounding whitespace', async () => {
    const client = makeFakeClient({
      devices: [device({ id: 5, label: 'Leo handset' })],
      recorded: { placeCallCalls: [] },
    });
    const r1 = await resolveFamilyPhoneContact(client, '  leo HANDSET ');
    expect(r1.device.id).toBe(5);
  });

  test('throws when no contact matches', async () => {
    const client = makeFakeClient({
      devices: [device({ id: 5, label: 'Leo handset' })],
      recorded: { placeCallCalls: [] },
    });
    await expect(resolveFamilyPhoneContact(client, 'unknown')).rejects.toThrow(
      /no household contact matches "unknown"/,
    );
  });

  test('throws on ambiguous matches and lists the owners', async () => {
    const client = makeFakeClient({
      devices: [
        device({ id: 5, label: 'Leo handset', ownerDisplayName: 'leo' }),
        device({ id: 6, label: 'Leo handset', ownerDisplayName: 'elisa' }),
      ],
      recorded: { placeCallCalls: [] },
    });
    await expect(resolveFamilyPhoneContact(client, 'Leo handset')).rejects.toThrow(
      /ambiguous.*leo, elisa/,
    );
  });

  test('filters out the agent kind so the assistant cannot ring itself', async () => {
    const client = makeFakeClient({
      devices: [
        device({ id: 1, label: 'agent', kind: 'agent' }),
        device({ id: 2, label: 'agent', kind: 'handset' }),
      ],
      recorded: { placeCallCalls: [] },
    });
    const r = await resolveFamilyPhoneContact(client, 'agent');
    expect(r.device.id).toBe(2);
  });

  test('rejects an empty contact label', async () => {
    const client = makeFakeClient({
      devices: [],
      recorded: { placeCallCalls: [] },
    });
    await expect(resolveFamilyPhoneContact(client, '   ')).rejects.toThrow(
      /cannot be empty/,
    );
  });
});

describe('place_call MCP tool', () => {
  test('resolves the contact and POSTs a tool-trigger action', async () => {
    const recorded: { placeCallCalls: Array<{ targetDeviceId: number; trigger: AgentActionTrigger }> } = {
      placeCallCalls: [],
    };
    const client = makeFakeClient({
      devices: [device({ id: 5, label: 'Leo handset' })],
      recorded,
    });
    const message = await findPlaceCallTool().run(client, { contact: 'Leo handset' });
    expect(message).toMatch(/Ringing Leo handset/);
    expect(message).toMatch(/action #42/);
    expect(recorded.placeCallCalls).toEqual([
      { targetDeviceId: 5, trigger: 'tool' },
    ]);
  });

  test('surfaces the busy state as a sentence rather than a thrown error', async () => {
    const recorded: { placeCallCalls: Array<{ targetDeviceId: number; trigger: AgentActionTrigger }> } = {
      placeCallCalls: [],
    };
    const client = makeFakeClient({
      devices: [device({ id: 5, label: 'Leo handset' })],
      placeCallResult: null,
      recorded,
    });
    const message = await findPlaceCallTool().run(client, { contact: 'Leo handset' });
    expect(message).toMatch(/already on a call/);
  });

  test('requires the contact argument', async () => {
    const recorded: { placeCallCalls: Array<{ targetDeviceId: number; trigger: AgentActionTrigger }> } = {
      placeCallCalls: [],
    };
    const client = makeFakeClient({
      devices: [device({ id: 5, label: 'Leo handset' })],
      recorded,
    });
    await expect(findPlaceCallTool().run(client, {})).rejects.toThrow(/contact is required/);
  });
});
