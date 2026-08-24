import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { WebAuthnAdapter } from '../auth/webauthn.ts';
import type { SessionsRepo } from '../auth/sessions.ts';
import type { Principal } from '../auth/principals.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

export interface RegisterOptionsResult {
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface RegisterVerifyResult {
  token: string;
  user: { id: number; displayName: string };
}

export interface LoginOptionsResult {
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface LoginVerifyResult {
  token: string;
  user: { id: number; displayName: string };
}

export interface MeResult {
  userId: number;
  displayName: string;
}

export interface AuthDeps {
  webauthn: WebAuthnAdapter;
  sessions: SessionsRepo;
}

export async function registerOptionsCore(
  deps: AuthDeps,
  input: { displayName: string },
): Promise<RegisterOptionsResult> {
  if (!input.displayName || input.displayName.trim().length === 0) {
    throw new AuthError(400, 'displayName is required');
  }
  return deps.webauthn.startRegistration({ displayName: input.displayName });
}

export async function registerVerifyCore(
  deps: AuthDeps,
  input: { response: RegistrationResponseJSON },
): Promise<RegisterVerifyResult> {
  const { userId, displayName } = await deps.webauthn.finishRegistration({ response: input.response });
  const { token } = deps.sessions.mint({ userId, ttlMs: SESSION_TTL_MS, label: 'spa' });
  return { token, user: { id: userId, displayName } };
}

export async function loginOptionsCore(deps: AuthDeps): Promise<LoginOptionsResult> {
  return deps.webauthn.startAuthentication();
}

export async function loginVerifyCore(
  deps: AuthDeps,
  input: { response: AuthenticationResponseJSON },
): Promise<LoginVerifyResult> {
  const { userId, displayName } = await deps.webauthn.finishAuthentication({ response: input.response });
  const { token } = deps.sessions.mint({ userId, ttlMs: SESSION_TTL_MS, label: 'spa' });
  return { token, user: { id: userId, displayName } };
}

export function logoutCore(
  deps: AuthDeps,
  input: { token: string },
): { revoked: boolean } {
  return { revoked: deps.sessions.revoke(input.token) };
}

export function meCore(principal: Principal | null): MeResult | null {
  if (!principal) return null;
  return { userId: principal.userId, displayName: principal.displayName };
}

export class AuthError extends Error {
  override readonly name = 'AuthError';
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
