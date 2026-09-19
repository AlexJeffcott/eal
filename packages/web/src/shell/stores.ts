import { $state } from '@fairfox/polly/state';
import type { CurrentUser, Message, WsConnectionState } from '@eal/client';

/**
 * Shell-global reactive state — the things true everywhere, regardless of
 * which app is active: identity, the WS connection, CLI pairing, and the
 * assistant chat. Per-app state lives in that app's own stores module.
 */

/**
 * The WS connection state is the client's, re-exported rather than redeclared:
 * the shell mirrors what the socket actually reports, and a second union here
 * would drift from it. `reconnecting` is the state a phone spends its time in.
 */
export type { WsConnectionState };
export type CliPairStatus = 'idle' | 'claiming' | 'success';

export const $currentUser = $state<CurrentUser | null>(null);
export const $signInDisplayName = $state<string>('');
/** The invite code the server's registration gate requires. */
export const $signInInviteCode = $state<string>('');
export const $signInError = $state<string | null>(null);
export const $wsState = $state<WsConnectionState>('idle');
export const $wsError = $state<string | null>(null);
/**
 * Signing in by pairing: this browser shows a code, a signed-in device claims
 * it, and the poll hands this browser a session. Null when no link is open.
 */
export interface BrowserLink {
  readonly userCode: string;
  readonly verificationUrl: string;
}
export const $browserLink = $state<BrowserLink | null>(null);
export const $cliPairCode = $state<string>('');
export const $cliPairLabel = $state<string>('');
export const $cliPairStatus = $state<CliPairStatus>('idle');
export const $cliPairError = $state<string | null>(null);

/** Whether the nav drawer overlay is open. */
export const $navOpen = $state<boolean>(false);

/**
 * The global assistant chat. `$chatMessages` is the persisted conversation;
 * `$chatStreaming` holds the assistant's reply text as it streams in (null when
 * nothing is in flight); `$chatBusy` spans send → done/error.
 */
export const $chatOpen = $state<boolean>(false);
export const $chatMessages = $state<Message[]>([]);
export const $chatInput = $state<string>('');
export const $chatStreaming = $state<string | null>(null);
export const $chatBusy = $state<boolean>(false);
export const $chatError = $state<string | null>(null);
/**
 * Whether an `eal agent` worker is connected to the relay. Chat has nowhere to
 * go without one. Starts optimistic: the seed and the WS both correct it, and
 * a moment of "offline" on every page load would be worse than a moment of
 * silence.
 */
export const $agentOnline = $state<boolean>(true);

export interface ShellStores {
  $currentUser: typeof $currentUser;
  $browserLink: typeof $browserLink;
  $signInDisplayName: typeof $signInDisplayName;
  $signInInviteCode: typeof $signInInviteCode;
  $signInError: typeof $signInError;
  $wsState: typeof $wsState;
  $wsError: typeof $wsError;
  $cliPairCode: typeof $cliPairCode;
  $cliPairLabel: typeof $cliPairLabel;
  $cliPairStatus: typeof $cliPairStatus;
  $cliPairError: typeof $cliPairError;
  $navOpen: typeof $navOpen;
  $chatOpen: typeof $chatOpen;
  $chatMessages: typeof $chatMessages;
  $chatInput: typeof $chatInput;
  $chatStreaming: typeof $chatStreaming;
  $chatBusy: typeof $chatBusy;
  $chatError: typeof $chatError;
  $agentOnline: typeof $agentOnline;
}

export function createShellStores(): ShellStores {
  return {
    $currentUser,
    $browserLink,
    $signInDisplayName,
    $signInInviteCode,
    $signInError,
    $wsState,
    $wsError,
    $cliPairCode,
    $cliPairLabel,
    $cliPairStatus,
    $cliPairError,
    $navOpen,
    $chatOpen,
    $chatMessages,
    $chatInput,
    $chatStreaming,
    $chatBusy,
    $chatError,
    $agentOnline,
  };
}

export function resetShellStores(): void {
  $currentUser.value = null;
  $browserLink.value = null;
  $signInDisplayName.value = '';
  $signInInviteCode.value = '';
  $signInError.value = null;
  $wsState.value = 'idle';
  $wsError.value = null;
  $cliPairCode.value = '';
  $cliPairLabel.value = '';
  $cliPairStatus.value = 'idle';
  $cliPairError.value = null;
  $navOpen.value = false;
  $chatOpen.value = false;
  $chatMessages.value = [];
  $chatInput.value = '';
  $chatStreaming.value = null;
  $chatBusy.value = false;
  $chatError.value = null;
  $agentOnline.value = true;
}
