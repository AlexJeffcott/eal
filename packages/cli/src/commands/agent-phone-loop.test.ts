import { describe, expect, test } from 'bun:test';
import type { FamilyPhoneCallEvent, FamilyPhoneDeviceConnection } from '@eal/client';
import { DEFAULT_REJECT_REASON, installAgentPhoneHandler } from './agent-phone-loop.ts';

interface FakeConn extends FamilyPhoneDeviceConnection {
  emit(event: FamilyPhoneCallEvent): void;
  rejected: string[];
  accepted: string[];
}

function makeConn(): FakeConn {
  const subs = new Set<(e: FamilyPhoneCallEvent) => void>();
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
    subscribeAudio: () => () => {},
    subscribePush: () => {},
    unsubscribePush: () => {},
    close: () => {},
    emit: (event) => {
      for (const h of subs) h(event);
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

  test('logs hangups with the server-supplied reason when present', () => {
    const conn = makeConn();
    const logs: string[] = [];
    installAgentPhoneHandler(conn, { log: (l) => logs.push(l), rejectReason: 'r' });

    conn.emit({ type: 'call:hung-up', callId: 'xyz', reason: 'caller bored' });

    expect(logs.some((l) => l.includes('xyz') && l.includes('caller bored'))).toBe(true);
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
