import { Elysia } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';

export interface FamilyPhoneRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
  /**
   * Live set of currently-online device ids. Family-phone's WS handler
   * mutates this on auth/close so the directory endpoint can paint
   * presence without an extra round-trip.
   */
  onlineDevices: Set<number>;
}

export function familyPhoneHttpRoutes(ctx: FamilyPhoneRoutesContext) {
  const devices = createFamilyPhoneDevicesRepo(ctx.db);
  return new Elysia({ prefix: '/api/family-phone' })
    .get('/devices', ({ request }) => {
      const principal = ctx.getPrincipal(request);
      if (!principal) return { error: 'unauthenticated' };
      const rows = devices.listAllWithOwner().map((d) => ({
        id: d.id,
        user_id: d.user_id,
        label: d.label,
        kind: d.kind,
        created_at: d.created_at,
        paired_at: d.paired_at,
        owner_display_name: d.owner_display_name,
        online: ctx.onlineDevices.has(d.id),
      }));
      return { devices: rows };
    });
}
