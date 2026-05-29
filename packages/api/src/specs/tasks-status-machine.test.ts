import { beforeEach, describe, expect, test } from 'bun:test';
import { clearStateRegistry } from '@fairfox/polly/state';
import {
  complete,
  reopen,
  restore,
  softDelete,
  taskStatusMachine,
} from './tasks-status-machine.ts';

/**
 * Shadow-model transition tests. See tasks-status-machine.ts for the
 * anchoring banner — the production handlers in tasks.http.ts now carry
 * the same requires / ensures / guarded assignments these helpers encode,
 * so `bun devctl verify` proves the model holds on every reachable
 * interleaving. These tests pin the helpers themselves.
 */

function reset(): void {
  clearStateRegistry();
  taskStatusMachine.value = { status: 'open' };
}

describe('tasks-status-machine — happy path transitions', () => {
  beforeEach(reset);

  test('starts open', () => {
    expect(taskStatusMachine.value.status).toBe('open');
  });

  test('complete moves open → done', () => {
    complete();
    expect(taskStatusMachine.value.status).toBe('done');
  });

  test('reopen moves done → open', () => {
    complete();
    reopen();
    expect(taskStatusMachine.value.status).toBe('open');
  });

  test('softDelete moves open → deleted', () => {
    softDelete();
    expect(taskStatusMachine.value.status).toBe('deleted');
  });

  test('softDelete moves done → deleted', () => {
    complete();
    softDelete();
    expect(taskStatusMachine.value.status).toBe('deleted');
  });

  test('restore moves deleted → open (predictable resurrection)', () => {
    complete();
    softDelete();
    restore();
    expect(taskStatusMachine.value.status).toBe('open');
  });
});
