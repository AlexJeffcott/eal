import { $state } from '@fairfox/polly/state';
import type { CurrentUser, Message } from '@eal/client';

/**
 * Shell-global reactive state — the things true everywhere, regardless of
 * which app is active: identity, the WS connection, CLI pairing, and the
 * assistant chat. Per-app state lives in that app's own stores module.
 */

export type WsConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
export type CliPairStatus = 'idle' | 'claiming' | 'success';

export const $currentUser = $state<CurrentUser | null>(null);
export const $signInDisplayName = $state<string>('');
export const $signInError = $state<string | null>(null);
export const $wsState = $state<WsConnectionState>('idle');
export const $wsError = $state<string | null>(null);
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

export interface ShellStores {
  $currentUser: typeof $currentUser;
  $signInDisplayName: typeof $signInDisplayName;
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
}

export function createShellStores(): ShellStores {
  return {
    $currentUser,
    $signInDisplayName,
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
  };
}

export function resetShellStores(): void {
  $currentUser.value = null;
  $signInDisplayName.value = '';
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
}
