import { beforeEach, describe, test } from 'bun:test';
import fc from 'fast-check';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createSessionsRepo } from './sessions.ts';
import { getPrincipal } from './principals.ts';

function req(headers: Record<string, string>): Request {
  return new Request('https://example.invalid/test', { headers });
}

describe('getPrincipal (property-based)', () => {
  let db: DatabaseClient;
  let validToken: string;
  let userId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    userId = createUsersRepo(db).insert({ displayName: 'alex' }).id;
    validToken = createSessionsRepo(db).mint({ userId, ttlMs: 60_000 }).token;
  });

  test('any non-Bearer authorization header returns null', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.toLowerCase().startsWith('bearer ')),
        (header) => {
          return getPrincipal(req({ authorization: header }), db) === null;
        },
      ),
    );
  });

  test('any unknown Bearer token returns null', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s !== validToken && /^\S+$/.test(s)),
        (token) => {
          return getPrincipal(req({ authorization: `Bearer ${token}` }), db) === null;
        },
      ),
    );
  });

  test('the real bearer is recognised regardless of header casing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('Bearer', 'bearer', 'BEARER', 'BeArEr'),
        (scheme) => {
          const principal = getPrincipal(req({ authorization: `${scheme} ${validToken}` }), db);
          return principal !== null && principal.userId === userId;
        },
      ),
    );
  });

  test('the parser is tolerant of outer whitespace and any HTTP-valid intra-token whitespace', () => {
    // Note: the Request/Headers constructor sanitizes CR/LF in header values
    // (HTTP header-injection guard), so only spaces and tabs survive into the
    // value that reaches the parser. The property covers exactly those.
    fc.assert(
      fc.property(
        fc.constantFrom(' ', '  ', '\t'),
        fc.constantFrom('', ' ', '  '),
        (inner, outer) => {
          const header = `${outer}Bearer${inner}${validToken}${outer}`;
          const principal = getPrincipal(req({ authorization: header }), db);
          return principal !== null && principal.userId === userId;
        },
      ),
    );
  });
});
