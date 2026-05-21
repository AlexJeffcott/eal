import type { Principal } from './principals.ts';

export type Action = 'view' | 'edit' | 'delete';

/**
 * Day-one resource catalogue. Adding a new resource kind extends this union
 * and the switch in `authorize()`. The seam is a pure function — callers do
 * not see the implementation.
 */
export type Resource =
  | { kind: 'task'; createdBy: number };

/**
 * Day-one rules for `task`:
 *
 * - Any signed-in household member may view, edit, or delete any task.
 *   The household model assumes shared trust between members (see
 *   docs/tasks-v1.md "Scope recommendation").
 * - Anonymous principals may not view, edit, or delete.
 *
 * `createdBy` is on the resource shape so a future "creator-only delete" rule
 * can land without changing the call sites. When rules grow past ~15 cases,
 * migrate the body to CASL while keeping this signature stable.
 */
export function authorize(
  principal: Principal | null,
  resource: Resource,
  action: Action,
): boolean {
  switch (resource.kind) {
    case 'task': {
      void action;
      void resource.createdBy;
      return principal !== null;
    }
  }
}
