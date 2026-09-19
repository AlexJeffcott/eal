import type { ActionRegistry } from '@fairfox/polly/actions';
import type { AppStores } from '../stores.ts';
import { navigate } from './router.ts';

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function friendlySignInError(err: unknown): string {
  const raw = describeError(err);
  // Browser-side WebAuthn UI: user cancelled, dismissed the prompt, or no passkey
  // was selectable. Both Chromium and WebKit surface this as DOMException
  // "NotAllowedError"; the message wording varies.
  if (raw.includes('NotAllowedError') || /cancel/i.test(raw)) {
    return 'Sign-in cancelled before a passkey was chosen.';
  }
  if (raw.includes('credential not found')) {
    return "We don't recognise that passkey on this device. If you haven't registered yet, enter a display name and tap Register passkey.";
  }
  if (raw.includes('counter rollback')) {
    return 'This passkey looks replayed and was rejected. Try registering a fresh one.';
  }
  if (raw.includes('no pending authentication challenge')) {
    return 'Sign-in took too long — please try again.';
  }
  if (raw.includes('authentication response failed verification')) {
    return "That passkey didn't verify against the server. Try again, or register a new one.";
  }
  return raw;
}

export function friendlyRegisterError(err: unknown): string {
  const raw = describeError(err);
  if (raw.includes('NotAllowedError') || /cancel/i.test(raw)) {
    return 'Registration cancelled before a passkey was created.';
  }
  // The registration gate — see packages/api/src/auth/registration.ts.
  if (raw.includes('registration is closed')) {
    return 'This eal instance is not accepting new devices. Ask the household owner to set an invite code.';
  }
  if (raw.includes('invalid invite code')) {
    return 'That invite code is wrong. Check it and try again.';
  }
  if (raw.includes('too many registration attempts')) {
    return raw.replace('too many registration attempts', 'Too many wrong invite codes');
  }
  if (raw.includes('registration response failed verification')) {
    return "That passkey didn't verify with the server. Please try again.";
  }
  if (raw.includes('no pending registration challenge')) {
    return 'Registration took too long — please try again.';
  }
  return raw;
}

/**
 * Open the WS after an in-session sign-in or register.
 *
 * `$wsState` is not written here: the client reports its own state and
 * `installWsResync` in main.tsx mirrors it, so a socket that drops later still
 * moves the indicator. This function owns the error text only.
 */
async function connectAndTrack(stores: AppStores): Promise<void> {
  stores.$wsError.value = null;
  try {
    await stores.client.connect();
  } catch (err) {
    stores.$wsError.value = describeError(err);
  }
}

/** Shell-global actions: navigation, identity, CLI pairing, the assistant chat. */
export const SHELL_ACTIONS: ActionRegistry<AppStores> = {
  'shell:navigate': ({ event, data, stores }) => {
    // Nav links carry the destination on `data-action-path`.
    event.preventDefault();
    const path = data['path'];
    if (typeof path === 'string') navigate(path);
    // Navigating from the drawer dismisses it; harmless when already closed.
    stores.$navOpen.value = false;
  },

  'shell:nav-toggle': ({ stores }) => {
    stores.$navOpen.value = !stores.$navOpen.value;
  },

  'auth:register': async ({ stores }) => {
    stores.$signInError.value = null;
    try {
      const user = await stores.client.registerPasskey(
        stores.$signInDisplayName.value,
        stores.$signInInviteCode.value,
      );
      // Connect BEFORE flipping $currentUser so the DOM transition only happens
      // once the broadcast subscription is live.
      await connectAndTrack(stores);
      stores.$currentUser.value = user;
      stores.$signInDisplayName.value = '';
      stores.$signInInviteCode.value = '';
    } catch (err) {
      stores.$signInError.value = friendlyRegisterError(err);
    }
  },

  'auth:sign-in': async ({ stores }) => {
    stores.$signInError.value = null;
    try {
      const user = await stores.client.signInWithPasskey();
      await connectAndTrack(stores);
      stores.$currentUser.value = user;
    } catch (err) {
      stores.$signInError.value = friendlySignInError(err);
    }
  },

  'auth:sign-out': async ({ stores }) => {
    await stores.client.disconnect();
    stores.$wsState.value = 'idle';
    stores.$wsError.value = null;
    await stores.client.signOut();
    // The offline stores hold one member's tasks and unsent captures. The next
    // person to sign in on this device must find neither.
    const discarded = await stores.outbox.clear();
    if (discarded > 0) console.warn(`[outbox] sign-out discarded ${discarded} unsent capture(s)`);
    stores.$currentUser.value = null;
    // Sign-out is only reachable from inside the drawer, and the drawer does
    // not close itself. Left open it covers the sign-in surface with an
    // overlay that swallows every pointer event.
    stores.$navOpen.value = false;
  },

  'cli-pair:claim': async ({ stores }) => {
    stores.$cliPairError.value = null;
    const userCode = stores.$cliPairCode.value.trim();
    const label = stores.$cliPairLabel.value.trim();
    if (userCode.length === 0) {
      stores.$cliPairError.value = 'Enter the code printed by your CLI.';
      return;
    }
    if (label.length === 0) {
      stores.$cliPairError.value = 'Give this device a label.';
      return;
    }
    stores.$cliPairStatus.value = 'claiming';
    try {
      await stores.client.claimCliPair({ userCode, label });
      stores.$cliPairStatus.value = 'success';
      stores.$cliPairCode.value = '';
      stores.$cliPairLabel.value = '';
    } catch (err) {
      stores.$cliPairStatus.value = 'idle';
      stores.$cliPairError.value = describeError(err);
    }
  },

  'chat:toggle': ({ stores }) => {
    stores.$chatOpen.value = !stores.$chatOpen.value;
  },

  'chat:clear': async ({ stores }) => {
    // Reset the thread: the server hides the history and drops the assistant's
    // session; locally we empty the panel. Non-destructive — see clearChat.
    try {
      await stores.client.clearChat();
      stores.$chatMessages.value = [];
      stores.$chatStreaming.value = null;
      stores.$chatError.value = null;
    } catch (err) {
      stores.$chatError.value = describeError(err);
    }
  },

  'chat:send': ({ event, stores }) => {
    // May be dispatched from a form submit — stop the browser reload first.
    event.preventDefault();
    if (stores.$chatBusy.value) return;
    const text = stores.$chatInput.value.trim();
    if (text.length === 0) return;
    stores.$chatError.value = null;
    // Clear the input straight away; the server echoes the canonical user
    // message back as a chat:user event, which appends it to the transcript.
    stores.$chatInput.value = '';
    stores.$chatBusy.value = true;
    try {
      stores.client.sendChat(text);
    } catch (err) {
      // The WS isn't open — restore the draft so the user can retry.
      stores.$chatBusy.value = false;
      stores.$chatInput.value = text;
      stores.$chatError.value = describeError(err);
    }
  },
};
