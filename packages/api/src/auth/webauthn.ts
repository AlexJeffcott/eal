import {
  generateAuthenticationOptions as realGenerateAuthenticationOptions,
  generateRegistrationOptions as realGenerateRegistrationOptions,
  verifyAuthenticationResponse as realVerifyAuthenticationResponse,
  verifyRegistrationResponse as realVerifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types';
import type { DatabaseClient } from '../db/client.ts';
import { createCredentialsRepo } from '../db/repos/credentials.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import type { ChallengeStore } from './challenges.ts';

/**
 * Injectable handle for the @simplewebauthn/server surface the adapter uses.
 *
 * The shape is intentionally narrower than the library's exhaustive types:
 * it captures only the inputs the wrapper passes and the output fields it
 * reads. The real library functions structurally satisfy this interface;
 * test mocks can be constructed from plain objects without unsafe casts.
 */
export interface VerifiedRegistration {
  verified: boolean;
  registrationInfo?: {
    credential: {
      id: string;
      publicKey: Uint8Array;
      counter: number;
    };
  };
}

export interface VerifiedAuthentication {
  verified: boolean;
  authenticationInfo?: { newCounter: number };
}

export interface WebAuthnLibrary {
  generateRegistrationOptions(opts: unknown): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistrationResponse(opts: unknown): Promise<VerifiedRegistration>;
  generateAuthenticationOptions(opts: unknown): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthenticationResponse(opts: unknown): Promise<VerifiedAuthentication>;
}

export const DEFAULT_WEBAUTHN_LIBRARY: WebAuthnLibrary = {
  generateRegistrationOptions: realGenerateRegistrationOptions,
  verifyRegistrationResponse: realVerifyRegistrationResponse,
  generateAuthenticationOptions: realGenerateAuthenticationOptions,
  verifyAuthenticationResponse: realVerifyAuthenticationResponse,
};

/** Encode a user id as the WebAuthn `userHandle` (bytes of the decimal string). */
export function encodeUserHandle(userId: number): Uint8Array {
  return new TextEncoder().encode(String(userId));
}

/** Reverse of `encodeUserHandle`. Returns null if the bytes don't decode to a valid id. */
export function decodeUserHandle(bytes: Uint8Array | string): number | null {
  const raw = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  if (raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Counter-replay detection. WebAuthn authenticators ship a monotonically-increasing
 * counter; a captured-and-replayed response will carry a counter <= the stored value.
 *
 * Pure function. Single source of truth for the replay rule.
 */
export function isCounterRollback(storedCounter: number, newCounter: number): boolean {
  // Some authenticators emit 0 throughout. Treat 0/0 as legitimate; otherwise
  // require strict monotonic increase.
  if (storedCounter === 0 && newCounter === 0) return false;
  return newCounter <= storedCounter;
}

const ALLOWED_TRANSPORTS = new Set<string>([
  'ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb',
]);

function isAuthenticatorTransport(value: string): value is AuthenticatorTransportFuture {
  return ALLOWED_TRANSPORTS.has(value);
}

export function base64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface RpConfig {
  rpID: string;
  rpName: string;
  origin: string;
}

/**
 * Minimal shape the wrapper reads from a registration response. The library's
 * `RegistrationResponseJSON` structurally satisfies this; tests can construct
 * lightweight stubs from the narrow shape without fighting SDK fidelity.
 */
export interface RegistrationInput {
  id: string;
  response: {
    clientDataJSON: string;
    transports?: string[];
  };
}

export interface AuthenticationInput {
  id: string;
  response: {
    clientDataJSON: string;
    userHandle?: string;
  };
}

export interface WebAuthnAdapter {
  startRegistration(input: { displayName: string }): Promise<{
    options: PublicKeyCredentialCreationOptionsJSON;
  }>;
  finishRegistration(input: {
    response: RegistrationInput;
  }): Promise<{ userId: number; displayName: string }>;
  startAuthentication(): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
  }>;
  finishAuthentication(input: {
    response: AuthenticationInput;
  }): Promise<{ userId: number; displayName: string }>;
}

export function createWebAuthnAdapter(
  db: DatabaseClient,
  challenges: ChallengeStore,
  rp: RpConfig,
  lib: WebAuthnLibrary = DEFAULT_WEBAUTHN_LIBRARY,
): WebAuthnAdapter {
  const usersRepo = createUsersRepo(db);
  const credentialsRepo = createCredentialsRepo(db);

  return {
    async startRegistration({ displayName }) {
      const options = await lib.generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpID,
        userName: displayName,
        userDisplayName: displayName,
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'preferred',
        },
      });
      challenges.set(options.challenge, { kind: 'register', meta: { displayName } });
      return { options };
    },

    async finishRegistration({ response }) {
      const clientData = JSON.parse(new TextDecoder().decode(base64urlToBytes(response.response.clientDataJSON)));
      const challenge = String(clientData.challenge);
      const pending = challenges.take(challenge);
      if (!pending || pending.kind !== 'register') {
        throw new Error('webauthn: no pending registration challenge');
      }
      const displayName = pending.meta?.['displayName'];
      if (!displayName) throw new Error('webauthn: registration challenge missing displayName');

      const verified = await lib.verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });

      if (!verified.verified || !verified.registrationInfo) {
        throw new Error('webauthn: registration response failed verification');
      }
      const info = verified.registrationInfo;

      const user = usersRepo.findByDisplayName(displayName) ?? usersRepo.insert({ displayName });
      const transports = response.response.transports ?? null;

      credentialsRepo.insert({
        userId: user.id,
        credentialId: info.credential.id ? base64urlToBytes(info.credential.id) : new Uint8Array(0),
        publicKey: info.credential.publicKey,
        counter: info.credential.counter,
        transports,
      });

      return { userId: user.id, displayName: user.display_name };
    },

    async startAuthentication() {
      const options = await lib.generateAuthenticationOptions({
        rpID: rp.rpID,
        allowCredentials: [],
        userVerification: 'preferred',
      });
      challenges.set(options.challenge, { kind: 'authenticate' });
      return { options };
    },

    async finishAuthentication({ response }) {
      const clientData = JSON.parse(new TextDecoder().decode(base64urlToBytes(response.response.clientDataJSON)));
      const challenge = String(clientData.challenge);
      const pending = challenges.take(challenge);
      if (!pending || pending.kind !== 'authenticate') {
        throw new Error('webauthn: no pending authentication challenge');
      }

      // Identify the user via the credential id, not the userHandle. The
      // userHandle is opaque bytes generated by @simplewebauthn/server at
      // registration time when no `userID` is supplied — so decoding it as a
      // decimal user id fails. The credentials table is keyed by credential_id
      // and stores user_id directly; that's the authoritative mapping.
      const credentialIdBytes = base64urlToBytes(response.id);
      const credentialRow = credentialsRepo.findByCredentialId(credentialIdBytes);
      if (!credentialRow) throw new Error('webauthn: credential not found');

      const user = usersRepo.findById(credentialRow.user_id);
      if (!user) throw new Error('webauthn: user row missing for credential (db inconsistency)');

      const transports: AuthenticatorTransportFuture[] | undefined = credentialRow.transports
        ? credentialRow.transports.split(',').map((t) => t.trim()).filter(isAuthenticatorTransport)
        : undefined;

      const verified = await lib.verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: response.id,
          publicKey: credentialRow.public_key,
          counter: credentialRow.counter,
          ...(transports ? { transports } : {}),
        },
        requireUserVerification: false,
      });

      if (!verified.verified || !verified.authenticationInfo) {
        throw new Error('webauthn: authentication response failed verification');
      }

      const { newCounter } = verified.authenticationInfo;
      if (isCounterRollback(credentialRow.counter, newCounter)) {
        throw new Error('webauthn: counter rollback detected (replay)');
      }
      credentialsRepo.updateCounter(credentialIdBytes, newCounter);

      return { userId: user.id, displayName: user.display_name };
    },
  };
}
