import { Button } from '@fairfox/polly/ui';

export function SignOut() {
  return (
    <Button
      tier="tertiary"
      data-action="auth:sign-out"
      label={<span data-sign-out>Sign out</span>}
    />
  );
}
