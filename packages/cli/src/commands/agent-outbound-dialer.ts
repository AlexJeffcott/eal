import type {
  EalClient,
  FamilyPhoneCallEvent,
  FamilyPhoneDeviceConnection,
} from '@eal/client';

/**
 * Drives the agent worker's outbound call lifecycle for actions the
 * scheduler (and the MCP `place_call` tool) have already inserted
 * server-side. The dialer:
 *
 *   1. Sends a `call:invite` over the agent's family-phone WS for each
 *      pending action whose `call_id` is still null.
 *   2. Watches the connection's event stream — `call:invite-ack` lands
 *      the server-minted `call_id`, which the dialer immediately
 *      attaches to the audit row.
 *   3. Maps every terminal `call:*` event (rejected, unanswered,
 *      cancelled, hung-up after an accept) onto a `finishAgentAction`
 *      POST so the lock releases and the audit row settles.
 *
 * Single-flight is preserved by construction: the server's phone lock
 * only ever allows one pending action at a time per agent device, and
 * the dialer further guards against a stray `dial()` while an invite
 * is awaiting its ack.
 */

export interface PendingActionRef {
  id: number;
  targetDeviceId: number;
}

export interface AgentOutboundDialerDeps {
  client: EalClient;
  connection: FamilyPhoneDeviceConnection;
  log: (line: string) => void;
}

export interface AgentOutboundDialer {
  /** Send the invite for one pending action; resolves when invite-ack
   * lands and the call_id has been attached, or rejects with a clear
   * error when invite-failed lands instead. */
  dial(action: PendingActionRef): Promise<void>;
  /** Drop subscriptions and reject any in-flight dial. */
  close(): void;
}

interface PendingDial {
  actionId: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

export function createAgentOutboundDialer(
  deps: AgentOutboundDialerDeps,
): AgentOutboundDialer {
  /** Set while a call:invite has been sent and no invite-ack/failed
   * has come back. The connection serves a single WS so events are
   * received in order, but the next ack still has to be matched to
   * the current dial by position rather than by id. */
  let pendingDial: PendingDial | null = null;

  /** call_id → action id of the audit row this dialer owns. Tracks
   * calls that originated from us so inbound-call events (which share
   * the same channel) do not accidentally finish someone else's row. */
  const outboundCalls = new Map<string, number>();

  /** call_ids that have transitioned through `call:accepted`. A later
   * `call:hung-up` for one of these completes the action as 'answered';
   * a hangup without a prior accept (only possible on a server bug or a
   * peer-disconnect during pending) completes the action as 'failed'. */
  const acceptedCalls = new Set<string>();

  const unsubscribe = deps.connection.subscribe((event) =>
    void handleEvent(event),
  );

  async function handleEvent(event: FamilyPhoneCallEvent): Promise<void> {
    switch (event.type) {
      case 'call:invite-ack': {
        const dial = pendingDial;
        if (dial === null) return; // not awaiting an ack — ignore
        pendingDial = null;
        outboundCalls.set(event.callId, dial.actionId);
        try {
          await deps.client.attachAgentCall(dial.actionId, event.callId);
          deps.log(
            `dialer: action #${dial.actionId} dialed — call ${event.callId} pending`,
          );
          dial.resolve();
        } catch (err) {
          deps.log(
            `dialer: action #${dial.actionId} attach-call failed: ${describeError(err)}`,
          );
          outboundCalls.delete(event.callId);
          dial.reject(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      case 'call:invite-failed': {
        const dial = pendingDial;
        if (dial === null) return;
        pendingDial = null;
        await finishAction(dial.actionId, {
          result: 'failed',
          callId: null,
          error: event.reason,
        });
        dial.reject(new Error(event.reason));
        return;
      }
      case 'call:accepted': {
        if (outboundCalls.has(event.callId)) acceptedCalls.add(event.callId);
        return;
      }
      case 'call:rejected': {
        await finishOutboundCall(event.callId, {
          result: 'rejected',
          callId: event.callId,
          error: null,
        });
        return;
      }
      case 'call:cancelled': {
        await finishOutboundCall(event.callId, {
          result: 'failed',
          callId: event.callId,
          error: 'cancelled',
        });
        return;
      }
      case 'call:unanswered': {
        await finishOutboundCall(event.callId, {
          result: 'unanswered',
          callId: event.callId,
          error: null,
        });
        return;
      }
      case 'call:hung-up': {
        if (!outboundCalls.has(event.callId)) return;
        const wasAccepted = acceptedCalls.delete(event.callId);
        await finishOutboundCall(event.callId, {
          result: wasAccepted ? 'answered' : 'failed',
          callId: event.callId,
          error: wasAccepted ? null : 'hung-up-without-accept',
        });
        return;
      }
      default:
        // Other event types (incoming, accept-ack, presence:changed,
        // directory:changed, push:*) are not the dialer's concern.
        return;
    }
  }

  async function finishOutboundCall(
    callId: string,
    input: {
      result: 'answered' | 'unanswered' | 'rejected' | 'failed' | 'sent';
      callId: string | null;
      error: string | null;
    },
  ): Promise<void> {
    const actionId = outboundCalls.get(callId);
    if (actionId === undefined) return;
    outboundCalls.delete(callId);
    acceptedCalls.delete(callId);
    await finishAction(actionId, input);
  }

  async function finishAction(
    actionId: number,
    input: {
      result: 'answered' | 'unanswered' | 'rejected' | 'failed' | 'sent';
      callId: string | null;
      error: string | null;
    },
  ): Promise<void> {
    try {
      await deps.client.finishAgentAction(actionId, input);
      deps.log(
        `dialer: action #${actionId} finished result=${input.result}${input.error ? ` (${input.error})` : ''}`,
      );
    } catch (err) {
      deps.log(`dialer: action #${actionId} finish failed: ${describeError(err)}`);
    }
  }

  return {
    dial(action): Promise<void> {
      if (pendingDial !== null) {
        return Promise.reject(
          new Error(`dialer busy on action #${pendingDial.actionId}`),
        );
      }
      return new Promise<void>((resolve, reject) => {
        pendingDial = { actionId: action.id, resolve, reject };
        try {
          deps.connection.placeCall(action.targetDeviceId);
        } catch (err) {
          pendingDial = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    close(): void {
      unsubscribe();
      if (pendingDial !== null) {
        const dial = pendingDial;
        pendingDial = null;
        dial.reject(new Error('dialer closed'));
      }
      outboundCalls.clear();
      acceptedCalls.clear();
    },
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
