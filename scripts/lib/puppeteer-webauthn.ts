import type { Browser, Page, CDPSession } from 'puppeteer';

export interface VirtualAuthenticator {
  authenticatorId: string;
  cdp: CDPSession;
}

interface CdpCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

interface GetCredentialsResponse {
  credentials: CdpCredential[];
}

interface AddAuthenticatorResponse {
  authenticatorId: string;
}

/**
 * Attach a CDP Virtual Authenticator to a puppeteer page so the browser can
 * speak WebAuthn without a real biometric device. Returns the authenticator
 * id and the CDP session so callers can later extract / inject credentials.
 */
export async function attachVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.target().createCDPSession();
  await cdp.send('WebAuthn.enable');
  const result = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })) as AddAuthenticatorResponse;
  return { authenticatorId: result.authenticatorId, cdp };
}

export async function getCredentials(va: VirtualAuthenticator): Promise<CdpCredential[]> {
  const response = (await va.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: va.authenticatorId,
  })) as GetCredentialsResponse;
  return response.credentials;
}

export async function addCredential(va: VirtualAuthenticator, credential: CdpCredential): Promise<void> {
  await va.cdp.send('WebAuthn.addCredential', {
    authenticatorId: va.authenticatorId,
    credential,
  });
}

export async function closeBrowserQuietly(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  await browser.close().catch(() => {});
}
