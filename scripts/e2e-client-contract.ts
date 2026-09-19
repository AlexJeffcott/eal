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
    // Capture is parallel on both sides — the same default the column carries.
    if (realTask.sequential !== false || mockTask.sequential !== false) {
      throw new Error(
        `createTask.sequential mismatch: real=${String(realTask.sequential)} mock=${String(mockTask.sequential)}`,
      );
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
      // The flag the Available view and next_actions both read. It is the one
      // field that is a boolean here and an INTEGER 0/1 in storage, so a mock
      // that returned the raw column would look right to every browser-tier
      // test and wrong to the real api.
      sequential: true,
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
    if (realUpdated.sequential !== true || mockUpdated.sequential !== true) {
      throw new Error(
        `updateTask.sequential mismatch: real=${String(realUpdated.sequential)} mock=${String(mockUpdated.sequential)}`,
      );
    }

    // ─── Step 5: getTask shape — { task, children } ────────────────────────
    const realDetail = await real.getTask(realTask.id);
    const mockDetail = await mock.getTask(mockTask.id);
    assertShape('getTask', realDetail, mockDetail);
    assertShape('getTask.task', realDetail.task, mockDetail.task);

    // ─── Step 6: listUsers shape — the assignee roster ─────────────────────
    mock.seedUsers([
      { id: seeded.userId, displayName: seeded.displayName, inIvrMenu: false },
    ]);
    const realUsers = await real.listUsers();
    const mockUsers = await mock.listUsers();
    if (realUsers.length === 0 || mockUsers.length === 0) {
      throw new Error(`listUsers should be non-empty: real=${realUsers.length} mock=${mockUsers.length}`);
    }
    assertShape('listUsers[0]', realUsers[0], mockUsers[0]);

    // ─── Step 7: completeTask shape — status flip on the same row ──────────
    const realDoneChange = await real.completeTask(realTask.id);
    const mockDoneChange = await mock.completeTask(mockTask.id);
    assertShape('completeTask', realDoneChange, mockDoneChange);
    const realDone = realDoneChange.task;
    const mockDone = mockDoneChange.task;
    assertShape('completeTask.task', realDone, mockDone);
    if (realDone.status !== 'done' || mockDone.status !== 'done') {
      throw new Error('completeTask did not flip status to done');
    }
    if (realDone.completedAt === null || mockDone.completedAt === null) {
      throw new Error('completeTask did not set completedAt');
    }
    if (realDoneChange.spawned.length !== 0 || mockDoneChange.spawned.length !== 0) {
      throw new Error('completeTask spawned a successor for a task that does not repeat');
    }

    // ─── Step 7b: setTaskStatus shape — the board's lane move ──────────────
    // The mock is what the browser tier drives, so a lane it moves cards into
    // differently from the api is a green tier that proves nothing.
    const realBlocked = (await real.setTaskStatus(realTask.id, 'blocked')).task;
    const mockBlocked = (await mock.setTaskStatus(mockTask.id, 'blocked')).task;
    assertShape('setTaskStatus', realBlocked, mockBlocked);
    if (realBlocked.status !== 'blocked' || mockBlocked.status !== 'blocked') {
      throw new Error(
        `setTaskStatus did not land in blocked: real=${realBlocked.status} mock=${mockBlocked.status}`,
      );
    }
    // Leaving Done clears the completion timestamp on both sides — the tie the
    // storage CHECK enforces server-side and the mock has to mirror.
    if (realBlocked.completedAt !== null || mockBlocked.completedAt !== null) {
      throw new Error(
        `setTaskStatus left a completedAt behind: real=${realBlocked.completedAt} mock=${mockBlocked.completedAt}`,
      );
    }

    // ─── Step 7c: a recurring task — the successor, and the accidental tick ─
    // The mock computes the date with the same `@eal/shared` function the api
    // does, so what this pins is everything around it: that both move the rule
    // onto the successor, and that both take an untouched successor back.
    const today = new Date().toISOString().slice(0, 10);
    const weekly = {
      title: 'bins',
      dueAt: today,
      recurrence: { every: 'days', interval: 7, basis: 'due' },
    } as const;
    const realBins = await real.createTask(weekly);
    const mockBins = await mock.createTask(weekly);
    assertShape('createTask (recurring)', realBins, mockBins);
    const realSpawn = await real.completeTask(realBins.id, { today });
    const mockSpawn = await mock.completeTask(mockBins.id, { today });
    assertShape('completeTask (recurring)', realSpawn, mockSpawn);
    const realNext = realSpawn.spawned[0];
    const mockNext = mockSpawn.spawned[0];
    if (realSpawn.spawned.length !== 1 || mockSpawn.spawned.length !== 1 || !realNext || !mockNext) {
      throw new Error(
        `a recurring completion should spawn one row: real=${realSpawn.spawned.length} mock=${mockSpawn.spawned.length}`,
      );
    }
    assertShape('completeTask.spawned[0]', realNext, mockNext);
    if (realNext.dueAt !== mockNext.dueAt) {
      throw new Error(`successor dueAt mismatch: real=${realNext.dueAt} mock=${mockNext.dueAt}`);
    }
    if (realNext.recurrence === null || mockNext.recurrence === null) {
      throw new Error('the successor does not carry the rule');
    }
    if (realSpawn.task.recurrence !== null || mockSpawn.task.recurrence !== null) {
      throw new Error('the completed occurrence still carries the rule');
    }
    const realUndo = await real.reopenTask(realBins.id);
    const mockUndo = await mock.reopenTask(mockBins.id);
    assertShape('reopenTask (recurring)', realUndo, mockUndo);
    if (realUndo.removed.length !== 1 || mockUndo.removed.length !== 1) {
      throw new Error(
        `reopen should take back one untouched successor: real=${realUndo.removed.length} mock=${mockUndo.removed.length}`,
      );
    }
    if (realUndo.task.recurrence === null || mockUndo.task.recurrence === null) {
      throw new Error('reopen did not return the rule to the reopened row');
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
