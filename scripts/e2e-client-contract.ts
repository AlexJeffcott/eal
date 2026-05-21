#!/usr/bin/env bun
/**
 * Client/mock contract test.
 *
 * Runs the same observable call sequence against a real `EalClient` (talking
 * to a booted api) AND against a `MockEalClient` (seeded to match the real
 * world). Asserts both produce the same shape of result for every step.
 *
 * Why this matters: the browser-tier tests that use `MockEalClient` test
 * "I set X, the SPA renders X" — they never verify that the real client's
 * flow produces the same shape the mock returns. If the real `createTask`
 * started returning a field the mock doesn't, mock-driven tests would still
 * pass while the SPA broke against the real api. This script binds them.
 *
 * Methods NOT covered here: registerPasskey / signInWithPasskey (a real
 * WebAuthn ceremony — covered by playwright + the passkey-multi script); and
 * the chat/agent WS methods (sendChat, subscribeChatEvents, connectAsAgent,
 * sendChatReply) — those need a live relay + agent and are covered end-to-end
 * by e2e-chat.ts.
 */
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createEalClient,
  type CurrentUser,
  type UpdateTaskInput,
} from '../packages/client/src/index.ts';
import { createMockEalClient } from '../packages/client-mock/src/index.ts';
import { bootApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/client-contract');
const DB_PATH = resolve(ARTIFACTS, 'client-contract.sqlite');
const FIXED_PORT = '4105';

function assertShape(label: string, real: unknown, mock: unknown): void {
  const ra = real === null ? 'null' : typeof real;
  const ma = mock === null ? 'null' : typeof mock;
  if (ra !== ma) throw new Error(`${label}: real returned ${ra}, mock returned ${ma}`);
  if (real === null || mock === null) {
    if (real !== mock) throw new Error(`${label}: real=${String(real)} mock=${String(mock)}`);
    return;
  }
  if (typeof real !== 'object' || typeof mock !== 'object') return;
  const realKeys = Object.keys(real).sort();
  const mockKeys = Object.keys(mock).sort();
  if (realKeys.join(',') !== mockKeys.join(',')) {
    throw new Error(`${label}: key set mismatch — real=[${realKeys.join(',')}] mock=[${mockKeys.join(',')}]`);
  }
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });

  const seeded = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'contract' });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });

  try {
    const real = createEalClient(api.url, { token: seeded.token });
    const mock = createMockEalClient();
    mock.setCurrentUser({ userId: seeded.userId, displayName: seeded.displayName });

    // ─── Step 1: getCurrentUser shape ───────────────────────────────────────
    const realMe = await real.getCurrentUser();
    const mockMe = await mock.getCurrentUser();
    assertShape('getCurrentUser', realMe, mockMe);
    if (realMe?.displayName !== mockMe?.displayName) {
      throw new Error(`displayName mismatch: real=${realMe?.displayName} mock=${mockMe?.displayName}`);
    }

    // ─── Step 2: createTask shape ───────────────────────────────────────────
    // Both clients see the same row shape. The mock invents fields locally;
    // the real client persists via the api. Field-set equality is the contract.
    const realTask = await real.createTask({ title: 'contract-test' });
    const mockTask = await mock.createTask({ title: 'contract-test' });
    assertShape('createTask', realTask, mockTask);
    if (realTask.title !== mockTask.title) {
      throw new Error(`createTask.title mismatch: real=${realTask.title} mock=${mockTask.title}`);
    }
    if (realTask.status !== mockTask.status) {
      throw new Error(`createTask.status mismatch: real=${realTask.status} mock=${mockTask.status}`);
    }
    if (realTask.createdBy !== mockTask.createdBy) {
      throw new Error(`createTask.createdBy mismatch: real=${realTask.createdBy} mock=${mockTask.createdBy}`);
    }

    // ─── Step 3: listTasks shape (single row each) ─────────────────────────
    const realList = await real.listTasks();
    const mockList = await mock.listTasks();
    if (realList.length === 0 || mockList.length === 0) {
      throw new Error(`listTasks should be non-empty after create: real=${realList.length} mock=${mockList.length}`);
    }
    assertShape('listTasks[0]', realList[0], mockList[0]);

    // ─── Step 4: updateTask shape — every editor field round-trips ─────────
    // This is what the task detail editor relies on; the browser tier only
    // ever exercised the mock's updateTask.
    const updatePatch: UpdateTaskInput = {
      notes: 'contract note',
      dueAt: '2026-07-01',
      deferUntil: '2026-06-15',
      assignedTo: seeded.userId,
    };
    const realUpdated = await real.updateTask(realTask.id, updatePatch);
    const mockUpdated = await mock.updateTask(mockTask.id, updatePatch);
    assertShape('updateTask', realUpdated, mockUpdated);
    if (realUpdated.notes !== mockUpdated.notes) {
      throw new Error(`updateTask.notes mismatch: real=${realUpdated.notes} mock=${mockUpdated.notes}`);
    }
    if (realUpdated.dueAt !== mockUpdated.dueAt) {
      throw new Error(`updateTask.dueAt mismatch: real=${realUpdated.dueAt} mock=${mockUpdated.dueAt}`);
    }
    if (realUpdated.deferUntil !== mockUpdated.deferUntil) {
      throw new Error(`updateTask.deferUntil mismatch: real=${realUpdated.deferUntil} mock=${mockUpdated.deferUntil}`);
    }
    if (realUpdated.assignedTo !== mockUpdated.assignedTo) {
      throw new Error(`updateTask.assignedTo mismatch: real=${realUpdated.assignedTo} mock=${mockUpdated.assignedTo}`);
    }

    // ─── Step 5: getTask shape — { task, children } ────────────────────────
    const realDetail = await real.getTask(realTask.id);
    const mockDetail = await mock.getTask(mockTask.id);
    assertShape('getTask', realDetail, mockDetail);
    assertShape('getTask.task', realDetail.task, mockDetail.task);

    // ─── Step 6: listUsers shape — the assignee roster ─────────────────────
    mock.seedUsers([{ id: seeded.userId, displayName: seeded.displayName }]);
    const realUsers = await real.listUsers();
    const mockUsers = await mock.listUsers();
    if (realUsers.length === 0 || mockUsers.length === 0) {
      throw new Error(`listUsers should be non-empty: real=${realUsers.length} mock=${mockUsers.length}`);
    }
    assertShape('listUsers[0]', realUsers[0], mockUsers[0]);

    // ─── Step 7: completeTask shape — status flip on the same row ──────────
    const realDone = await real.completeTask(realTask.id);
    const mockDone = await mock.completeTask(mockTask.id);
    assertShape('completeTask', realDone, mockDone);
    if (realDone.status !== 'done' || mockDone.status !== 'done') {
      throw new Error('completeTask did not flip status to done');
    }
    if (realDone.completedAt === null || mockDone.completedAt === null) {
      throw new Error('completeTask did not set completedAt');
    }

    // ─── Step 8: deleteTask shape — soft delete, row stays ─────────────────
    const realGone = await real.deleteTask(realTask.id);
    const mockGone = await mock.deleteTask(mockTask.id);
    assertShape('deleteTask', realGone, mockGone);
    if (realGone.deletedAt === null || mockGone.deletedAt === null) {
      throw new Error('deleteTask did not set deletedAt');
    }

    // ─── Step 9: signOut → getCurrentUser=null ─────────────────────────────
    await real.signOut();
    await mock.signOut();
    const realMeAfter: CurrentUser | null = await real.getCurrentUser();
    const mockMeAfter: CurrentUser | null = await mock.getCurrentUser();
    assertShape('getCurrentUser after signOut', realMeAfter, mockMeAfter);
    if (realMeAfter !== null) throw new Error(`real getCurrentUser after signOut should be null, got ${JSON.stringify(realMeAfter)}`);
    if (mockMeAfter !== null) throw new Error(`mock getCurrentUser after signOut should be null, got ${JSON.stringify(mockMeAfter)}`);

    console.log('e2e-client-contract: OK');
    return 0;
  } catch (err) {
    console.error('e2e-client-contract: FAIL', err);
    return 1;
  } finally {
    await api.kill();
  }
}

process.exit(await main());
