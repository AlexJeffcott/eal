import { describe, expect, test } from 'bun:test';
import { authorize, type Action, type Resource } from './policy.ts';
import type { Principal } from './principals.ts';

const alex: Principal = { userId: 1, displayName: 'alex' };
const leo: Principal = { userId: 2, displayName: 'leo' };

function task(createdBy: number): Resource {
  return { kind: 'task', createdBy };
}

describe('authorize / task', () => {
  const cases: Array<{
    label: string;
    principal: Principal | null;
    resource: Resource;
    action: Action;
    expected: boolean;
  }> = [
    // Anonymous gets nothing — the auth-by-default gate prevents anon WS / API
    // access, and policy backs that up at the seam.
    { label: 'anonymous cannot view a task', principal: null, resource: task(1), action: 'view', expected: false },
    { label: 'anonymous cannot edit a task', principal: null, resource: task(1), action: 'edit', expected: false },
    { label: 'anonymous cannot delete a task', principal: null, resource: task(1), action: 'delete', expected: false },

    // Any authenticated household member can act on any task — the household
    // trust model is documented in docs/tasks-v1.md.
    { label: 'creator can view their own task', principal: alex, resource: task(1), action: 'view', expected: true },
    { label: 'creator can edit their own task', principal: alex, resource: task(1), action: 'edit', expected: true },
    { label: 'creator can delete their own task', principal: alex, resource: task(1), action: 'delete', expected: true },
    { label: 'non-creator can view someone else\'s task', principal: leo, resource: task(1), action: 'view', expected: true },
    { label: 'non-creator can edit someone else\'s task', principal: leo, resource: task(1), action: 'edit', expected: true },
    { label: 'non-creator can delete someone else\'s task', principal: leo, resource: task(1), action: 'delete', expected: true },
  ];

  for (const c of cases) {
    test(c.label, () => {
      expect(authorize(c.principal, c.resource, c.action)).toBe(c.expected);
    });
  }
});
