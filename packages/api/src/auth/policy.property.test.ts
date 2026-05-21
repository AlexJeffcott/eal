import { describe, test } from 'bun:test';
import fc from 'fast-check';
import { authorize, type Action, type Resource } from './policy.ts';
import type { Principal } from './principals.ts';

/**
 * Property-based assertions on the policy. fast-check generates hundreds of
 * (principal, resource, action) tuples and tries to falsify each property.
 * When it finds a counterexample, it shrinks to the minimal failing case.
 *
 * The enumerated decision-matrix tests in `policy.test.ts` cover the documented
 * truth table. These properties express the same rules as universal laws and
 * surface any case we forgot to enumerate.
 */

const principalArb: fc.Arbitrary<Principal> = fc.record({
  userId: fc.integer({ min: 1, max: 100 }),
  displayName: fc.string({ minLength: 1, maxLength: 30 }),
});

const taskArb: fc.Arbitrary<Resource> = fc.record({
  kind: fc.constant('task' as const),
  createdBy: fc.integer({ min: 1, max: 100 }),
});

const actionArb: fc.Arbitrary<Action> = fc.constantFrom<Action>('view', 'edit', 'delete');

describe('authorize / task (property-based)', () => {
  test('any signed-in principal can perform any action on any task', () => {
    fc.assert(
      fc.property(principalArb, taskArb, actionArb, (principal, resource, action) => {
        return authorize(principal, resource, action) === true;
      }),
    );
  });

  test('anonymous principal can never perform any action', () => {
    fc.assert(
      fc.property(taskArb, actionArb, (resource, action) => {
        return authorize(null, resource, action) === false;
      }),
    );
  });
});
