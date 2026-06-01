import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import {
  createPstnContactsRepo,
  type PstnContactRow,
} from '../db/repos/family-phone-pstn-contacts.ts';
import { AuthError } from './auth.shared.ts';

export interface PstnContactsRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
}

/** Wire-shape PSTN contact (camelCase, allow flags as booleans). */
export interface PstnContact {
  id: number;
  e164: string;
  label: string;
  allowIn: boolean;
  allowOut: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toPstnContact(row: PstnContactRow): PstnContact {
  return {
    id: row.id,
    e164: row.e164,
    label: row.label,
    allowIn: row.allow_in === 1,
    allowOut: row.allow_out === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requirePrincipal(ctx: PstnContactsRoutesContext, request: Request): Principal {
  const p = ctx.getPrincipal(request);
  if (!p) throw new AuthError(401, 'unauthenticated');
  return p;
}

/**
 * Strict E.164: a `+`, a non-zero leading digit, then 6-14 more digits.
 * Reject anything the trunk could not actually dial — typos, formatted
 * national numbers, embedded spaces. Validation happens here so the repo
 * stays a thin store.
 */
const E164 = /^\+[1-9]\d{6,14}$/;

export function pstnContactsHttpRoutes(ctx: PstnContactsRoutesContext) {
  const contacts = createPstnContactsRepo(ctx.db);

  return new Elysia({ prefix: '/api/family-phone' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .get('/pstn-contacts', ({ request }) => {
      requirePrincipal(ctx, request);
      return { contacts: contacts.listAll().map(toPstnContact) };
    })
    .post(
      '/pstn-contacts',
      ({ body, request, set }) => {
        requirePrincipal(ctx, request);
        const label = body.label.trim();
        if (label.length === 0) {
          set.status = 400;
          return { error: 'label must not be empty' };
        }
        if (!E164.test(body.e164)) {
          set.status = 400;
          return { error: 'e164 must be a valid E.164 number (e.g. +441234567890)' };
        }
        if (contacts.findByE164(body.e164)) {
          set.status = 409;
          return { error: `a contact for ${body.e164} already exists` };
        }
        const inserted = contacts.insert({
          e164: body.e164,
          label,
          allowIn: body.allowIn,
          allowOut: body.allowOut,
        });
        return { contact: toPstnContact(inserted) };
      },
      {
        body: t.Object({
          e164: t.String(),
          label: t.String(),
          allowIn: t.Boolean(),
          allowOut: t.Boolean(),
        }),
      },
    )
    .patch(
      '/pstn-contacts/:id',
      ({ body, params, request, set }) => {
        requirePrincipal(ctx, request);
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) {
          set.status = 400;
          return { error: 'contact id must be a positive integer' };
        }
        const label = body.label.trim();
        if (label.length === 0) {
          set.status = 400;
          return { error: 'label must not be empty' };
        }
        const updated = contacts.update({
          id,
          label,
          allowIn: body.allowIn,
          allowOut: body.allowOut,
        });
        if (!updated) {
          set.status = 404;
          return { error: `contact ${id} not found` };
        }
        return { contact: toPstnContact(updated) };
      },
      {
        body: t.Object({
          label: t.String(),
          allowIn: t.Boolean(),
          allowOut: t.Boolean(),
        }),
      },
    )
    .delete('/pstn-contacts/:id', ({ params, request, set }) => {
      requirePrincipal(ctx, request);
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        set.status = 400;
        return { error: 'contact id must be a positive integer' };
      }
      if (!contacts.deleteById(id)) {
        set.status = 404;
        return { error: `contact ${id} not found` };
      }
      return { deleted: true };
    });
}
