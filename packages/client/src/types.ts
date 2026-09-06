/**
 * Misc shared client types. The Task type lives in task-types.ts; auth types
 * in auth-types.ts. Add new shared interfaces here as they appear.
 */

/**
 * A browser's Web Push subscription, serialised.
 *
 * The three fields are exactly what `PushSubscription` yields — the
 * vendor-minted endpoint URL, and the two keys (an ECDH public key and an
 * auth secret) the server needs to encrypt a payload only that browser can
 * read. Base64url, as the browser produces them; the server stores them
 * verbatim and hands them straight to web-push.
 */
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}
