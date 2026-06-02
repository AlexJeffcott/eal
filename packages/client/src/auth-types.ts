export interface CurrentUser {
  readonly userId: number;
  readonly displayName: string;
}

/** A household member as seen in the assignee roster. */
export interface HouseholdMember {
  readonly id: number;
  readonly displayName: string;
  /** Phase 7D — true when this user is included in the inbound
   *  DTMF IVR menu strangers hear. Defaults to false. */
  readonly inIvrMenu: boolean;
}

export interface CliPairStartResult {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly verificationUrl: string;
  readonly pollIntervalMs: number;
  readonly expiresAt: string;
}

export type CliPairPollResult =
  | { readonly status: 'pending' }
  | {
      readonly status: 'authorized';
      readonly token: string;
      readonly user: CurrentUser;
    }
  | { readonly status: 'expired' };

export interface CliPairClaimInput {
  readonly userCode: string;
  readonly label: string;
}
