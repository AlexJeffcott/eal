import { describe, expect, test } from 'bun:test';
import type { FamilyPhoneCallEvent, FamilyPhoneDeviceConnection } from '@eal/client';
import { DEFAULT_REJECT_REASON, installAgentPhoneHandler } from './agent-phone-loop.ts';

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

  test('logs hangups for the currently accepted call', () => {
    const conn = makeConn();
    const logs: string[] = [];
    installAgentPhoneHandler(conn, {
      log: (l) => logs.push(l),
      rejectReason: 'r',
      voiceLoopFactory: () => ({ onInboundFrame: () => {}, close: () => {} }),
    });

    conn.emit({ type: 'call:incoming', callId: 'xyz', fromDeviceId: 1 });
    conn.emit({ type: 'call:hung-up', callId: 'xyz', reason: 'caller bored' });

    expect(logs.some((l) => l.includes('xyz') && l.includes('caller bored'))).toBe(true);
  });

  test('accepts and routes audio when a voiceLoopFactory is supplied', () => {
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

  test('rejects a second concurrent call while the first is still active', () => {
    const conn = makeConn();
    installAgentPhoneHandler(conn, {
      log: () => {},
      rejectReason: 'r',
      voiceLoopFactory: () => ({ onInboundFrame: () => {}, close: () => {} }),
    });
    conn.emit({ type: 'call:incoming', callId: 'one', fromDeviceId: 1 });
    conn.emit({ type: 'call:incoming', callId: 'two', fromDeviceId: 2 });
    expect(conn.accepted).toEqual(['one']);
    expect(conn.rejected).toEqual(['two']);
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
