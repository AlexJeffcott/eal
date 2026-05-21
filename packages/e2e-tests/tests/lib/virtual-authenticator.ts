import type { Page } from '@playwright/test';

export interface VirtualAuthenticator {
  authenticatorId: string;
  cdp: import('@playwright/test').CDPSession;
}

/**
 * Attach a CDP-based virtual authenticator to the given page. The authenticator
 * supports discoverable (resident) credentials, simulates user verification,
 * and auto-confirms presence so the WebAuthn ceremony completes without
 * manual user interaction.
 */
export async function attachVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { authenticatorId, cdp };
}
