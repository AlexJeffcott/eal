import type { AnyElysia } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { GetPrincipalFn } from '../auth/principals.ts';
import type { TaskEvent } from '../handlers/tasks.http.ts';

/**
 * What an API app's routes are built against. Supplied by server-factory,
 * which owns the db handle, the principal resolver, and the WS broadcaster.
 */
export interface ApiAppContext {
  db: DatabaseClient;
  getPrincipal: GetPrincipalFn;
  broadcastTask: (event: TaskEvent) => void;
}

/**
 * An API app — a slice of database schema plus a route plugin — composed into
 * the server by server-factory. Global concerns (auth, users, the chat relay)
 * are NOT apps: they are always present regardless of which apps are installed.
 */
export interface ApiApp {
  id: string;
  /** This app's own tables/indexes, appended after the global schema. */
  schema: string;
  routes: (ctx: ApiAppContext) => AnyElysia;
}
