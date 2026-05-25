import { Elysia } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';

export interface FamilyPhoneRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
}

export function familyPhoneHttpRoutes(ctx: FamilyPhoneRoutesContext) {
  const devices = createFamilyPhoneDevicesRepo(ctx.db);
  return new Elysia({ prefix: '/api/family-phone' })
    .get('/devices', ({ request }) => {
      const principal = ctx.getPrincipal(request);
      if (!principal) return { error: 'unauthenticated' };
      return { devices: devices.listByUserId(principal.userId) };
    });
}
