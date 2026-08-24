import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createCredentialsRepo } from '../db/repos/credentials.ts';
import { createChallengeStore } from './challenges.ts';
import {
  createWebAuthnAdapter,
  encodeUserHandle,
  type AuthenticationInput,
  type RegistrationInput,
  type RpConfig,
  type WebAuthnLibrary,
  type VerifiedRegistration,
  type VerifiedAuthentication,
} from './webauthn.ts';

const RP: RpConfig = {
  rpID: 'localhost',
  rpName: 'eal-test',
  origin: 'https://localhost:3000',
};

const CHALLENGE = 'test-challenge-base64url';

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function clientDataJSON(challenge: string, type: 'webauthn.create' | 'webauthn.get'): string {
  return b64url(JSON.stringify({ type, challenge, origin: RP.origin }));
}

function makeRegResponse(challenge: string, credIdB64: string): RegistrationInput {
  return {
    id: credIdB64,
    response: {
      clientDataJSON: clientDataJSON(challenge, 'webauthn.create'),
      transports: ['internal'],
    },
  };
}

function makeAuthResponse(challenge: string, credIdB64: string, userHandle: string): AuthenticationInput {
  return {
    id: credIdB64,
    response: {
      clientDataJSON: clientDataJSON(challenge, 'webauthn.get'),
      userHandle,
    },
  };
}

function libWith(overrides: {
  generateRegistrationOptions?: WebAuthnLibrary['generateRegistrationOptions'];
  verifyRegistrationResponse?: WebAuthnLibrary['verifyRegistrationResponse'];
  generateAuthenticationOptions?: WebAuthnLibrary['generateAuthenticationOptions'];
  verifyAuthenticationResponse?: WebAuthnLibrary['verifyAuthenticationResponse'];
}): WebAuthnLibrary {
  const reject = async (): Promise<never> => {
    throw new Error('webauthn.wrapper.test: unstubbed lib call');
  };
  const opts: PublicKeyCredentialCreationOptionsJSON = {
    rp: { id: RP.rpID, name: RP.rpName },
    user: { id: '', name: '', displayName: '' },
    challenge: CHALLENGE,
    pubKeyCredParams: [],
  };
  const authOpts: PublicKeyCredentialRequestOptionsJSON = {
    challenge: CHALLENGE,
    rpId: RP.rpID,
  };
  return {
    generateRegistrationOptions: overrides.generateRegistrationOptions ?? (async () => opts),
    verifyRegistrationResponse: overrides.verifyRegistrationResponse ?? reject,
    generateAuthenticationOptions: overrides.generateAuthenticationOptions ?? (async () => authOpts),
    verifyAuthenticationResponse: overrides.verifyAuthenticationResponse ?? reject,
  };
}

describe('WebAuthnAdapter (DI mocks)', () => {
  let db: DatabaseClient;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
  });

  describe('startRegistration', () => {
    test('stores the challenge with the displayName meta', async () => {
      const store = createChallengeStore();
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({}));
      const { options } = await adapter.startRegistration({ displayName: 'alex' });
      expect(options.challenge).toBe(CHALLENGE);
      const pending = store.take(CHALLENGE);
      expect(pending?.kind).toBe('register');
      expect(pending?.meta?.['displayName']).toBe('alex');
    });
  });

  describe('finishRegistration', () => {
    test('rejects when no pending challenge matches', async () => {
      const store = createChallengeStore();
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({}));
      await expect(adapter.finishRegistration({ response: makeRegResponse('bogus', b64url('c1')) })).rejects.toThrow(/no pending registration/);
    });

    test('rejects when the challenge was set with a non-register kind', async () => {
      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'authenticate' });
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({}));
      await expect(adapter.finishRegistration({ response: makeRegResponse(CHALLENGE, b64url('c1')) })).rejects.toThrow(/no pending registration/);
    });

    test('rejects when verify returns verified=false', async () => {
      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'register', meta: { displayName: 'alex' } });
      const verified: VerifiedRegistration = { verified: false };
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({
        verifyRegistrationResponse: async () => verified,
      }));
      await expect(adapter.finishRegistration({ response: makeRegResponse(CHALLENGE, b64url('c1')) })).rejects.toThrow(/failed verification/);
    });

    test('on verify=true creates a new user and inserts the credential row', async () => {
      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'register', meta: { displayName: 'alex' } });
      const credId = b64url('cred-bytes-here');
      const verified: VerifiedRegistration = {
        verified: true,
        registrationInfo: {
          credential: { id: credId, publicKey: new Uint8Array([7, 8, 9]), counter: 0 },
        },
      };
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({
        verifyRegistrationResponse: async () => verified,
      }));
      const result = await adapter.finishRegistration({ response: makeRegResponse(CHALLENGE, credId) });
      expect(result.displayName).toBe('alex');

      const userRow = createUsersRepo(db).findByDisplayName('alex');
      expect(userRow?.id).toBe(result.userId);

      const credRows = createCredentialsRepo(db).findByUserId(result.userId);
      expect(credRows.length).toBe(1);
      expect(credRows[0]?.counter).toBe(0);
      expect(credRows[0]?.transports).toBe('internal');
    });

    test('re-uses an existing user when display name already exists', async () => {
      const existing = createUsersRepo(db).insert({ displayName: 'alex' });
      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'register', meta: { displayName: 'alex' } });
      const verified: VerifiedRegistration = {
        verified: true,
        registrationInfo: {
          credential: { id: b64url('c1'), publicKey: new Uint8Array([1]), counter: 0 },
        },
      };
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({
        verifyRegistrationResponse: async () => verified,
      }));
      const result = await adapter.finishRegistration({ response: makeRegResponse(CHALLENGE, b64url('c1')) });
      expect(result.userId).toBe(existing.id);
    });
  });

  describe('finishAuthentication', () => {
    test('rejects when no pending challenge matches', async () => {
      const store = createChallengeStore();
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({}));
      const userHandle = new TextDecoder().decode(encodeUserHandle(1));
      await expect(adapter.finishAuthentication({ response: makeAuthResponse('bogus', b64url('c1'), userHandle) })).rejects.toThrow(/no pending authentication/);
    });

    test('rejects when challenge was set with kind=register', async () => {
      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'register', meta: { displayName: 'x' } });
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({}));
      const userHandle = new TextDecoder().decode(encodeUserHandle(1));
      await expect(adapter.finishAuthentication({ response: makeAuthResponse(CHALLENGE, b64url('c1'), userHandle) })).rejects.toThrow(/no pending authentication/);
    });

    test('rejects when the credential id is not stored', async () => {
      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'authenticate' });
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({}));
      // userHandle is auxiliary in our flow (we look up by credential id);
      // pass an arbitrary value here.
      await expect(adapter.finishAuthentication({ response: makeAuthResponse(CHALLENGE, b64url('unknown'), b64url('anything')) })).rejects.toThrow(/credential not found/);
    });

    test('rejects when the credential row points at a deleted user (FK rot)', async () => {
      const alex = createUsersRepo(db).insert({ displayName: 'alex' });
      const credentialId = new TextEncoder().encode('cred-bytes');
      createCredentialsRepo(db).insert({
        userId: alex.id,
        credentialId,
        publicKey: new Uint8Array([1]),
        counter: 0,
      });
      // Force the FK to dangle by deleting the user out of band (the ON DELETE
      // CASCADE on credentials means this would normally also remove the row;
      // simulate inconsistency via a raw DELETE with FKs off).
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`DELETE FROM users WHERE id = ${alex.id}`);
      db.exec('PRAGMA foreign_keys = ON');

      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'authenticate' });
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({}));
      const credIdB64 = Buffer.from(credentialId).toString('base64url');
      await expect(adapter.finishAuthentication({ response: makeAuthResponse(CHALLENGE, credIdB64, b64url('any')) })).rejects.toThrow(/user row missing/);
    });

    test('rejects on counter rollback', async () => {
      const user = createUsersRepo(db).insert({ displayName: 'alex' });
      const credentialId = new TextEncoder().encode('cred-bytes');
      createCredentialsRepo(db).insert({
        userId: user.id,
        credentialId,
        publicKey: new Uint8Array([1]),
        counter: 10,
      });
      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'authenticate' });
      const verified: VerifiedAuthentication = { verified: true, authenticationInfo: { newCounter: 5 } };
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({
        verifyAuthenticationResponse: async () => verified,
      }));
      const credIdB64 = Buffer.from(credentialId).toString('base64url');
      await expect(adapter.finishAuthentication({ response: makeAuthResponse(CHALLENGE, credIdB64, b64url('any')) })).rejects.toThrow(/counter rollback/);
    });

    test('happy path updates the counter and returns the user', async () => {
      const user = createUsersRepo(db).insert({ displayName: 'alex' });
      const credentialId = new TextEncoder().encode('cred-bytes');
      createCredentialsRepo(db).insert({
        userId: user.id,
        credentialId,
        publicKey: new Uint8Array([1]),
        counter: 5,
      });
      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'authenticate' });
      const verified: VerifiedAuthentication = { verified: true, authenticationInfo: { newCounter: 12 } };
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({
        verifyAuthenticationResponse: async () => verified,
      }));
      const credIdB64 = Buffer.from(credentialId).toString('base64url');
      const result = await adapter.finishAuthentication({ response: makeAuthResponse(CHALLENGE, credIdB64, b64url('any')) });
      expect(result.userId).toBe(user.id);
      expect(result.displayName).toBe('alex');

      const updated = createCredentialsRepo(db).findByCredentialId(credentialId);
      expect(updated?.counter).toBe(12);
    });

    test('rejects when verify returns verified=false', async () => {
      const user = createUsersRepo(db).insert({ displayName: 'alex' });
      const credentialId = new TextEncoder().encode('cred-bytes');
      createCredentialsRepo(db).insert({
        userId: user.id,
        credentialId,
        publicKey: new Uint8Array([1]),
        counter: 0,
      });
      const store = createChallengeStore();
      store.set(CHALLENGE, { kind: 'authenticate' });
      const verified: VerifiedAuthentication = { verified: false };
      const adapter = createWebAuthnAdapter(db, store, RP, libWith({
        verifyAuthenticationResponse: async () => verified,
      }));
      const userHandle = new TextDecoder().decode(encodeUserHandle(user.id));
      const credIdB64 = Buffer.from(credentialId).toString('base64url');
      await expect(adapter.finishAuthentication({ response: makeAuthResponse(CHALLENGE, credIdB64, userHandle) })).rejects.toThrow(/failed verification/);
    });
  });
});
