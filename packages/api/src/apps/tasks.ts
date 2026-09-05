import { tasksHttpRoutes } from '../handlers/tasks.http.ts';
import type { ApiApp } from './types.ts';

/** The tasks app's own tables. References the global `users` table. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  notes         TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL CHECK (status IN ('todo','doing','blocked','done')),
  defer_until   TEXT,
  due_at        TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  deleted_at    TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_position ON tasks (parent_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to     ON tasks (assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status          ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_defer_until     ON tasks (defer_until);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at      ON tasks (deleted_at);
`;

/** The tasks app — the first eal app. */
export const tasksApp: ApiApp = {
  id: 'tasks',
  schema: SCHEMA,
  routes: (ctx) =>
    tasksHttpRoutes({
      db: ctx.db,
      getPrincipal: ctx.getPrincipal,
      broadcastTask: ctx.broadcastTask,
    }),
};
