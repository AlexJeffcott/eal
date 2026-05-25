import { Elysia } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';

export interface FamilyPhoneRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
}

interface DeviceRow {
  id: number;
  user_id: number;
  label: string;
  kind: string;
  created_at: string;
}

export function familyPhoneHttpRoutes(ctx: FamilyPhoneRoutesContext) {
  return new Elysia({ prefix: '/api/family-phone' })
    .get('/devices', ({ request }) => {
      const principal = ctx.getPrincipal(request);
      if (!principal) return { error: 'unauthenticated' };
      const rows = ctx.db
        .query<DeviceRow, [number]>(
          `SELECT id, user_id, label, kind, created_at
             FROM family_phone_devices
            WHERE user_id = ?
            ORDER BY id ASC`,
        )
        .all(principal.userId);
      return { devices: rows };
    });
}
