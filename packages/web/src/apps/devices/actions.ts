import type { ActionRegistry } from '@fairfox/polly/actions';
import type { AppStores } from '../../stores.ts';
import type {
  EalClient,
  FamilyPhoneCallEvent,
  FamilyPhoneDeviceKind,
} from '@eal/client';
import {
  $deviceConnection,
  $devices,
  $pairStartCode,
  $pairStartSecondsLeft,
  type PairedThisSession,
} from './stores.ts';
import { Notification } from '../../platform/notification.ts';
import { ensurePushSubscription } from '../../platform/push.ts';
import { clearPairedDevice, loadPairedDevice, savePairedDevice } from './keystore.ts';
import { subtleCrypto } from '../../platform/subtle-crypto.ts';
// Family-phone subscribes its own call:* handler to the same WS connection
// once it is open; the import lives here because the devices layer owns the
// connection lifecycle, and a one-way dependency (devices → family-phone)
// avoids a circular import.
import {
  installCallEventHandlers,
  requestCallPermissions,
  resetFamilyPhoneCallState,
} from '../family-phone/actions.ts';

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isKind(value: unknown): value is FamilyPhoneDeviceKind {
  return value === 'handset' || value === 'pwa' || value === 'agent';
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Live countdown ticker for the displayed invite code. One per module —
 * minting a new code stops any running interval and starts a fresh one,
 * so two rapid mints don't race to clear each other's code.
 */
const PAIR_TTL_SECONDS = 60;
let pairCountdownInterval: ReturnType<typeof setInterval> | null = null;

function startPairCountdown(code: string): void {
  if (pairCountdownInterval !== null) clearInterval(pairCountdownInterval);
  $pairStartCode.value = code;
  $pairStartSecondsLeft.value = PAIR_TTL_SECONDS;
  pairCountdownInterval = setInterval(() => {
    const next = $pairStartSecondsLeft.value - 1;
    if (next <= 0) {
      $pairStartSecondsLeft.value = 0;
      $pairStartCode.value = null;
      if (pairCountdownInterval !== null) {
        clearInterval(pairCountdownInterval);
        pairCountdownInterval = null;
      }
      return;
    }
    $pairStartSecondsLeft.value = next;
  }, 1000);
}

/**
 * Stash a reference to the live client. The directory event subscriber
 * runs in module scope without a stores argument; it needs the client to
 * refresh the list when the server broadcasts a presence or directory
 * change. The ref is set in openDeviceConnection.
 */
let clientRef: EalClient | null = null;

async function refreshDevicesQuietly(): Promise<void> {
  if (!clientRef) return;
  try {
    $devices.value = await clientRef.listFamilyPhoneDevices();
  } catch {
    /* keep stale list */
  }
}

/**
 * Devices-side WS event handler. Listens for presence and directory
 * changes from the server and re-fetches the directory; ignores call:*
 * events (those are family-phone's concern, on the same connection).
 */
function installDirectoryEventHandlers(event: FamilyPhoneCallEvent): void {
  if (event.type === 'presence:changed' || event.type === 'directory:changed') {
    void refreshDevicesQuietly();
  }
}

async function openDeviceConnection(
  client: EalClient,
  paired: PairedThisSession,
): Promise<void> {
  clientRef = client;
  const existing = $deviceConnection.value;
  if (existing && existing.deviceId === paired.deviceId) return;
  existing?.close();
  const conn = await client.connectFamilyPhoneDevice({
    deviceId: paired.deviceId,
    privateKey: paired.privateKey,
  });
  conn.subscribe(installDirectoryEventHandlers);
  conn.subscribe(installCallEventHandlers);
  $deviceConnection.value = conn;
  // If notifications are already granted on this device, refresh the
  // push subscription on every connect — handles vendor endpoint
  // rotation and server-side VAPID key changes by re-registering. The
  // call is best-effort; ensurePushSubscription returns null silently
  // on every recoverable failure.
  void (async () => {
    try {
      const subscription = await ensurePushSubscription();
      if (subscription) {
        conn.subscribePush(subscription);
      }
    } catch (err) {
      console.warn('[push] re-subscribe on connect failed:', err);
    }
  })();
}

/**
 * Rehydrate a previously-paired device from IndexedDB and open its WS
 * connection. Called from the central session seeder in main.tsx whenever
 * auth completes; on first load with no paired device this returns
 * silently. Errors clear the stale row rather than getting stuck.
 */
export async function bootstrapDevices(stores: AppStores): Promise<void> {
  clientRef = stores.client;
  // Snapshot the Notification permission so the panel can hide the
  // "Enable notifications" button when it's already granted.
  stores.$notificationPermission.value =
    Notification === null ? 'unsupported' : Notification.permission;
  let persisted;
  try {
    persisted = await loadPairedDevice();
  } catch (err) {
    stores.$devicesError.value = describeError(err);
    return;
  }
  if (!persisted) return;
  const paired: PairedThisSession = {
    deviceId: persisted.deviceId,
    privateKey: persisted.privateKey,
    publicKeyB64: persisted.publicKeyB64,
  };
  stores.$pairedThisSession.value = paired;
  try {
    await openDeviceConnection(stores.client, paired);
  } catch (err) {
    stores.$devicesError.value =
      `Saved device could not reconnect (${describeError(err)}). Pair again.`;
    stores.$pairedThisSession.value = null;
    try { await clearPairedDevice(); } catch { /* ignore */ }
  }
}

export const DEVICES_ACTIONS: ActionRegistry<AppStores> = {
  'devices:set-complete-code': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$pairCompleteCode.value = value;
  },

  'devices:set-complete-label': ({ data, stores }) => {
    const value = data['value'];
    if (typeof value !== 'string') return;
    stores.$pairCompleteLabel.value = value;
  },

  'devices:set-complete-kind': ({ data, stores }) => {
    const value = data['value'];
    if (!isKind(value)) return;
    stores.$pairCompleteKind.value = value;
  },

  'devices:start-pair': async ({ event, stores }) => {
    event.preventDefault();
    stores.$devicesError.value = null;
    try {
      const result = await stores.client.startFamilyPhonePair();
      startPairCountdown(result.userCode);
    } catch (err) {
      stores.$devicesError.value = describeError(err);
    }
  },

  'devices:complete-pair': async ({ event, stores }) => {
    event.preventDefault();
    // Re-entrancy guard. A paste that contains a trailing newline used to
    // fire the form's implicit submit; we removed the form, but keeping
    // the guard cheaply hardens against double-clicks too.
    if (stores.$pairedThisSession.value !== null) {
      stores.$devicesError.value = null;
      stores.$pairCompleteCode.value = '';
      return;
    }
    const code = stores.$pairCompleteCode.value.trim();
    const label = stores.$pairCompleteLabel.value.trim();
    if (code.length === 0) {
      stores.$devicesError.value = 'Enter the invite code first.';
      return;
    }
    if (label.length === 0) {
      stores.$devicesError.value = 'Give this device a name.';
      return;
    }
    stores.$devicesError.value = null;
    try {
      if (subtleCrypto === null) {
        stores.$devicesError.value = 'Web Crypto is not available on this browser.';
        return;
      }
      // `extractable: false` prevents JavaScript from ever reading the raw
      // key bytes — and IndexedDB can still structured-clone the CryptoKey
      // across reloads.
      const kp = await subtleCrypto.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      );
      const spki = new Uint8Array(await subtleCrypto.exportKey('spki', kp.publicKey));
      const publicKeyB64 = toBase64Url(spki);
      const result = await stores.client.completeFamilyPhonePair({
        userCode: code,
        publicKey: publicKeyB64,
        alg: 'ES256',
        label,
        kind: stores.$pairCompleteKind.value,
      });
      const paired: PairedThisSession = {
        deviceId: result.deviceId,
        privateKey: kp.privateKey,
        publicKeyB64,
      };
      stores.$pairedThisSession.value = paired;
      stores.$pairCompleteCode.value = '';
      stores.$pairCompleteLabel.value = '';
      stores.$devices.value = await stores.client.listFamilyPhoneDevices();
      // Persist before opening the WS so a crash mid-handshake still
      // leaves the pairing usable on next load.
      try {
        await savePairedDevice({
          deviceId: paired.deviceId,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          publicKeyB64,
        });
      } catch (err) {
        stores.$devicesError.value =
          `Paired, but persistence failed (${describeError(err)}). Will not survive reload.`;
      }
      await openDeviceConnection(stores.client, paired);
      // Ask for every browser permission this browser needs from the same
      // user gesture that completed the pair. Today that is the
      // Notifications API for incoming-call alerts; microphone is
      // requested at call-accept time, when the gesture lines up there.
      // Failure is non-fatal — the user can re-prompt manually later.
      try {
        const perms = await requestCallPermissions();
        stores.$notificationPermission.value = perms.notifications;
        if (perms.notifications === 'denied') {
          stores.$devicesError.value =
            'Notification permission denied. Re-enable it in your browser\'s site settings to hear ringing.';
        }
      } catch { /* best-effort */ }
    } catch (err) {
      stores.$devicesError.value = describeError(err);
    }
  },

  'devices:request-permissions': async ({ stores }) => {
    try {
      const perms = await requestCallPermissions();
      stores.$notificationPermission.value = perms.notifications;
      if (perms.notifications === 'denied') {
        stores.$devicesError.value =
          'Notification permission denied. Re-enable it in your browser\'s site settings.';
        return;
      }
      if (perms.notifications === 'unsupported') {
        stores.$devicesError.value = 'This browser does not support notifications.';
        return;
      }
      // Permission granted. Bind a Web Push subscription to the
      // server's VAPID identity and register it on the device's
      // already-authed WS so an offline call:invite can wake this
      // device's phone. No-op when the device hasn't paired yet —
      // the subscription happens on first pairing instead.
      const conn = stores.$deviceConnection.value;
      if (!conn) return;
      const subscription = await ensurePushSubscription();
      if (subscription) {
        conn.subscribePush(subscription);
      }
    } catch (err) {
      stores.$devicesError.value = describeError(err);
    }
  },

  'devices:refresh': async ({ stores }) => {
    stores.$devicesError.value = null;
    try {
      stores.$devices.value = await stores.client.listFamilyPhoneDevices();
    } catch (err) {
      stores.$devicesError.value = describeError(err);
    }
  },

  'devices:dismiss-error': ({ stores }) => {
    stores.$devicesError.value = null;
  },

  'devices:rename': async ({ data, stores }) => {
    const raw = data['deviceId'];
    if (typeof raw !== 'string') return;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    const current = data['currentLabel'] ?? '';
    // window.prompt is the simplest in-tab text-entry primitive; it
    // blocks the page and returns null on cancel. A polly Modal-based
    // dialog would be nicer but isn't justified for a one-field edit.
    const next = typeof window !== 'undefined' ? window.prompt('Rename device', current) : null;
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed.length === 0) return;
    if (trimmed === current) return;
    stores.$devicesError.value = null;
    try {
      await stores.client.renameFamilyPhoneDevice(id, trimmed);
    } catch (err) {
      stores.$devicesError.value = describeError(err);
      return;
    }
    // Refresh the directory so the new name appears on this tab and
    // every other connected tab gets it through the directory:changed
    // broadcast.
    try {
      stores.$devices.value = await stores.client.listFamilyPhoneDevices();
    } catch (err) {
      stores.$devicesError.value = describeError(err);
    }
  },

  'devices:delete': async ({ data, stores }) => {
    const raw = data['deviceId'];
    if (typeof raw !== 'string') return;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    stores.$devicesError.value = null;
    try {
      await stores.client.deleteFamilyPhoneDevice(id);
    } catch (err) {
      stores.$devicesError.value = describeError(err);
      return;
    }
    // If we just deleted the device this tab was paired as, the local key
    // is now useless. Tear it down so the UI returns to the pair card and
    // IndexedDB doesn't try to reconnect with a dead device on next load.
    const paired = stores.$pairedThisSession.value;
    if (paired && paired.deviceId === id) {
      stores.$deviceConnection.value?.close();
      stores.$deviceConnection.value = null;
      stores.$pairedThisSession.value = null;
      resetFamilyPhoneCallState();
      try { await clearPairedDevice(); } catch { /* best-effort */ }
    }
    try {
      stores.$devices.value = await stores.client.listFamilyPhoneDevices();
    } catch { /* keep stale list */ }
  },

  'devices:unpair': async ({ stores }) => {
    // Close any active call and the WS first, then clear in-memory state,
    // then the persisted row. Order matters — IndexedDB errors must not
    // leave a stale connection running.
    stores.$deviceConnection.value?.close();
    stores.$deviceConnection.value = null;
    stores.$pairedThisSession.value = null;
    resetFamilyPhoneCallState();
    try {
      await clearPairedDevice();
    } catch {
      /* best-effort */
    }
    try {
      stores.$devices.value = await stores.client.listFamilyPhoneDevices();
    } catch {
      /* keep stale list */
    }
  },
};
