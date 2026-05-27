import { describe, expect, test } from 'bun:test';
import type {
  FamilyPhoneCallEvent,
  FamilyPhoneDeviceConnection,
  FamilyPhoneDeviceKind,
} from '@eal/client';
import { DEFAULT_REJECT_REASON, installAgentPhoneHandler } from './agent-phone-loop.ts';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface FakeConn extends FamilyPhoneDeviceConnection {
  emit(event: FamilyPhoneCallEvent): void;
  emitAudio(callId: string, payload: Uint8Array): void;
  rejected: string[];
  accepted: string[];
}

function makeConn(): FakeConn {
  const subs = new Set<(e: FamilyPhoneCallEvent) => void>();
  const audioSubs = new Set<(callId: string, payload: Uint8Array) => void>();
  const rejected: string[] = [];
  const accepted: string[] = [];
  return {
    deviceId: 99,
    placeCall: () => {},
    acceptCall: (id) => accepted.push(id),
    rejectCall: (id) => rejected.push(id),
    cancelCall: () => {},
    hangup: () => {},
    subscribe: (h) => {
      subs.add(h);
      return () => subs.delete(h);
    },
    sendAudio: () => {},
    sendText: () => {},
    subscribeAudio: (h) => {
      audioSubs.add(h);
      return () => audioSubs.delete(h);
    },
    subscribePush: () => {},
    unsubscribePush: () => {},
    close: () => {},
    emit: (event) => {
      for (const h of subs) h(event);
    },
    emitAudio: (callId, payload) => {
      for (const h of audioSubs) h(callId, payload);
    },
    get rejected() { return rejected; },
    get accepted() { return accepted; },
  };
}

describe('installAgentPhoneHandler', () => {
  test('rejects every incoming call until the voice loop lands', () => {
    const conn = makeConn();
    const logs: string[] = [];
    installAgentPhoneHandler(conn, { log: (l) => logs.push(l), rejectReason: DEFAULT_REJECT_REASON });

    conn.emit({ type: 'call:incoming', callId: 'abc', fromDeviceId: 7 });

    expect(conn.rejected).toEqual(['abc']);
    expect(conn.accepted).toEqual([]);
    expect(logs.some((l) => l.includes('abc') && l.includes('rejecting'))).toBe(true);
  });

  test('logs hangups for the currently accepted call', async () => {
    const conn = makeConn();
    const logs: string[] = [];
    installAgentPhoneHandler(conn, {
      log: (l) => logs.push(l),
      rejectReason: 'r',
      voiceLoopFactory: () => ({ onInboundFrame: () => {}, close: () => {} }),
    });

    conn.emit({ type: 'call:incoming', callId: 'xyz', fromDeviceId: 1 });
    await flush();
    conn.emit({ type: 'call:hung-up', callId: 'xyz', reason: 'caller bored' });

    expect(logs.some((l) => l.includes('xyz') && l.includes('caller bored'))).toBe(true);
  });

  test('accepts and routes audio when a voiceLoopFactory is supplied', async () => {
    const conn = makeConn();
    const logs: string[] = [];
    const inboundFrames: Uint8Array[] = [];
    let closeCount = 0;
    installAgentPhoneHandler(conn, {
      log: (l) => logs.push(l),
      rejectReason: 'r',
      voiceLoopFactory: () => ({
        onInboundFrame: (pcm) => inboundFrames.push(pcm),
        close: () => {
          closeCount += 1;
        },
      }),
    });

    conn.emit({ type: 'call:incoming', callId: 'voice-1', fromDeviceId: 5 });
    await flush();
    expect(conn.accepted).toEqual(['voice-1']);
    expect(conn.rejected).toEqual([]);

    const frame = new Uint8Array([1, 2, 3, 4]);
    conn.emitAudio('voice-1', frame);
    expect(inboundFrames).toEqual([frame]);

    // Audio for an unrelated call id must not reach the current loop.
    conn.emitAudio('other-call', new Uint8Array([9, 9]));
    expect(inboundFrames).toEqual([frame]);

    conn.emit({ type: 'call:hung-up', callId: 'voice-1' });
    expect(closeCount).toBe(1);
  });

  test('rejects a second concurrent call while the first is still active', async () => {
    const conn = makeConn();
    installAgentPhoneHandler(conn, {
      log: () => {},
      rejectReason: 'r',
      voiceLoopFactory: () => ({ onInboundFrame: () => {}, close: () => {} }),
    });
    conn.emit({ type: 'call:incoming', callId: 'one', fromDeviceId: 1 });
    conn.emit({ type: 'call:incoming', callId: 'two', fromDeviceId: 2 });
    await flush();
    expect(conn.accepted).toEqual(['one']);
    expect(conn.rejected).toEqual(['two']);
  });

  test('lookupDeviceKind feeds the caller kind into the voiceLoopFactory', async () => {
    const conn = makeConn();
    const factoryInputs: Array<{
      callerKind: FamilyPhoneDeviceKind | null;
      fromDeviceId: number;
    }> = [];
    installAgentPhoneHandler(conn, {
      log: () => {},
      rejectReason: 'r',
      lookupDeviceKind: async (id) => (id === 42 ? 'pwa' : null),
      voiceLoopFactory: (input) => {
        factoryInputs.push({
          callerKind: input.callerKind,
          fromDeviceId: input.fromDeviceId,
        });
        return { onInboundFrame: () => {}, close: () => {} };
      },
    });
    conn.emit({ type: 'call:incoming', callId: 'pwa-call', fromDeviceId: 42 });
    await flush();
    expect(factoryInputs).toEqual([{ callerKind: 'pwa', fromDeviceId: 42 }]);
  });

  test('lookup failure surfaces null callerKind, the call is still accepted', async () => {
    const conn = makeConn();
    const factoryInputs: Array<FamilyPhoneDeviceKind | null> = [];
    installAgentPhoneHandler(conn, {
      log: () => {},
      rejectReason: 'r',
      lookupDeviceKind: async () => {
        throw new Error('directory down');
      },
      voiceLoopFactory: (input) => {
        factoryInputs.push(input.callerKind);
        return { onInboundFrame: () => {}, close: () => {} };
      },
    });
    conn.emit({ type: 'call:incoming', callId: 'mystery', fromDeviceId: 7 });
    await flush();
    expect(factoryInputs).toEqual([null]);
    expect(conn.accepted).toEqual(['mystery']);
  });

  test('sendAudio and sendText handed to the factory route through the connection', async () => {
    const conn = makeConn();
    const sentAudio: Array<{ callId: string; payload: Uint8Array }> = [];
    const sentText: Array<{ callId: string; text: string }> = [];
    conn.sendAudio = (callId, payload) => sentAudio.push({ callId, payload });
    conn.sendText = (callId, text) => sentText.push({ callId, text });
    const captured: Array<{
      sendAudio: (p: Uint8Array) => void;
      sendText: (t: string) => void;
    }> = [];
    installAgentPhoneHandler(conn, {
      log: () => {},
      rejectReason: 'r',
      voiceLoopFactory: (input) => {
        captured.push({ sendAudio: input.sendAudio, sendText: input.sendText });
        return { onInboundFrame: () => {}, close: () => {} };
      },
    });
    conn.emit({ type: 'call:incoming', callId: 'wire-1', fromDeviceId: 7 });
    await flush();
    expect(captured).toHaveLength(1);
    const callbacks = captured[0];
    if (!callbacks) throw new Error('unreachable');
    callbacks.sendAudio(new Uint8Array([0xaa, 0xbb]));
    callbacks.sendText('hi there');
    expect(sentAudio).toEqual([{ callId: 'wire-1', payload: new Uint8Array([0xaa, 0xbb]) }]);
    expect(sentText).toEqual([{ callId: 'wire-1', text: 'hi there' }]);
  });

  test('an unrecognised wire event lands on the catch-all log line', () => {
    const conn = makeConn();
    const logs: string[] = [];
    installAgentPhoneHandler(conn, {
      log: (l) => logs.push(l),
      rejectReason: 'r',
    });
    // call:invite-failed is a known event the handler does not act on.
    conn.emit({ type: 'call:invite-failed', reason: 'whatever' });
    expect(logs.some((l) => l.includes('call:invite-failed'))).toBe(true);
  });

  test('a hangup that lands during the kind lookup cancels the accept', async () => {
    const conn = makeConn();
    const resolvers: Array<(value: FamilyPhoneDeviceKind | null) => void> = [];
    let factoryCalls = 0;
    installAgentPhoneHandler(conn, {
      log: () => {},
      rejectReason: 'r',
      lookupDeviceKind: () =>
        new Promise<FamilyPhoneDeviceKind | null>((resolve) => {
          resolvers.push(resolve);
        }),
      voiceLoopFactory: () => {
        factoryCalls += 1;
        return { onInboundFrame: () => {}, close: () => {} };
      },
    });
    conn.emit({ type: 'call:incoming', callId: 'racey', fromDeviceId: 3 });
    conn.emit({ type: 'call:hung-up', callId: 'racey' });
    expect(resolvers).toHaveLength(1);
    resolvers[0]?.('pwa');
    await flush();
    expect(factoryCalls).toBe(0);
    expect(conn.accepted).toEqual([]);
  });

  test('swallows presence and directory churn without logging', () => {
    const conn = makeConn();
    const logs: string[] = [];
    installAgentPhoneHandler(conn, { log: (l) => logs.push(l), rejectReason: 'r' });

    conn.emit({ type: 'presence:changed', deviceId: 1, online: true });
    conn.emit({ type: 'directory:changed' });

    expect(logs).toEqual([]);
  });

  test('unsubscribe detaches the handler from further events', () => {
    const conn = makeConn();
    const logs: string[] = [];
    const off = installAgentPhoneHandler(conn, { log: (l) => logs.push(l), rejectReason: 'r' });

    off();
    conn.emit({ type: 'call:incoming', callId: 'aaa', fromDeviceId: 1 });

    expect(conn.rejected).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('the default reject reason is honest about the missing voice loop', () => {
    expect(DEFAULT_REJECT_REASON).toContain('voice');
  });
});
