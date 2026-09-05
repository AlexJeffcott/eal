import { beforeEach, describe, expect, test } from 'bun:test';
import { clearStateRegistry } from '@fairfox/polly/state';
import {
  complete,
  reopen,
  restore,
  setStatus,
  softDelete,
  taskStatusMachine,
} from './tasks-status-machine.ts';

/**
 * Shadow-model transition tests. See tasks-status-machine.ts for the
 * anchoring banner — the production handlers in tasks.http.ts carry the same
 * requires / ensures / guarded assignments these helpers encode, so
 * `bun devctl verify` proves the model holds on every reachable interleaving.
 * These tests pin the helpers themselves.
 */

function reset(): void {
  clearStateRegistry();
  taskStatusMachine.value = { status: 'todo' };
}

const LIVE = ['todo', 'doing', 'blocked'] as const;

describe('tasks-status-machine — happy path transitions', () => {
  beforeEach(reset);

  test('starts todo', () => {
    expect(taskStatusMachine.value.status).toBe('todo');
  });

  test('complete moves any unfinished state → done', () => {
    for (const from of LIVE) {
      reset();
      setStatus(from);
      complete();
      expect(taskStatusMachine.value.status).toBe('done');
    }
  });

  test('reopen moves done → todo, not back to the lane it came from', () => {
    setStatus('blocked');
    complete();
    reopen();
    expect(taskStatusMachine.value.status).toBe('todo');
  });

  test('setStatus reaches every lane from every lane', () => {
    const lanes = ['todo', 'doing', 'blocked', 'done'] as const;
    for (const from of lanes) {
      for (const to of lanes) {
        reset();
        setStatus(from);
        setStatus(to);
        expect(taskStatusMachine.value.status).toBe(to);
      }
    }
  });

  test('softDelete moves any workflow state → deleted', () => {
    for (const from of [...LIVE, 'done'] as const) {
      reset();
      setStatus(from);
      softDelete();
      expect(taskStatusMachine.value.status).toBe('deleted');
    }
  });

  test('restore moves deleted → todo (predictable resurrection)', () => {
    setStatus('doing');
    complete();
    softDelete();
    restore();
    expect(taskStatusMachine.value.status).toBe('todo');
  });
});
