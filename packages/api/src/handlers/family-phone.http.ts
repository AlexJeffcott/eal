import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';

const MAX_LABEL_LENGTH = 60;

export interface FamilyPhoneRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
  /**
   * Live set of currently-online device ids. Family-phone's WS handler
   * mutates this on auth/close so the directory endpoint can paint
   * presence without an extra round-trip.
   */
  onlineDevices: Set<number>;
  /**
   * Called after any mutation that changes the directory's shape — a row
   * deleted, in future a row inserted. Implementation broadcasts to
   * connected family-phone WS clients so their panels can re-fetch.
   */
  onDirectoryChanged: () => void;
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
    })
    .delete('/devices/:id', ({ params, request, set }) => {
      const principal = ctx.getPrincipal(request);
      if (!principal) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        set.status = 400;
        return { error: 'device id must be a positive integer' };
      }
      const device = devices.findById(id);
      if (!device) {
        set.status = 404;
        return { error: 'device not found' };
      }
      // Only the owning user may delete their own device. A future household-
      // admin model could lift this; for now ownership equals delete rights.
      if (device.user_id !== principal.userId) {
        set.status = 403;
        return { error: 'you do not own this device' };
      }
      const removed = devices.deleteById(id);
      // The presence set forgets a deleted device on its own when the WS
      // closes. We also forget it eagerly so the next directory read does
      // not paint a stale online dot.
      ctx.onlineDevices.delete(id);
      if (removed) ctx.onDirectoryChanged();
      return { deleted: removed };
    })
    .patch(
      '/devices/:id',
      ({ params, body, request, set }) => {
        const principal = ctx.getPrincipal(request);
        if (!principal) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) {
          set.status = 400;
          return { error: 'device id must be a positive integer' };
        }
        const label = body.label.trim();
        if (label.length === 0) {
          set.status = 400;
          return { error: 'label must not be empty' };
        }
        if (label.length > MAX_LABEL_LENGTH) {
          set.status = 400;
          return { error: `label must be ${MAX_LABEL_LENGTH} characters or fewer` };
        }
        const device = devices.findById(id);
        if (!device) {
          set.status = 404;
          return { error: 'device not found' };
        }
        // Same ownership rule as delete — a user can only rename
        // their own devices. The household-admin lift lives with the
        // delete carve-out for whenever we add admin roles.
        if (device.user_id !== principal.userId) {
          set.status = 403;
          return { error: 'you do not own this device' };
        }
        const updated = devices.renameById(id, label);
        if (!updated) {
          set.status = 500;
          return { error: 'rename failed' };
        }
        ctx.onDirectoryChanged();
        return {
          device: {
            id: updated.id,
            user_id: updated.user_id,
            label: updated.label,
            kind: updated.kind,
            created_at: updated.created_at,
            paired_at: updated.paired_at,
          },
        };
      },
      { body: t.Object({ label: t.String() }) },
    );
}
