import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockEalClient, type MockEalClient } from '@eal/client-mock';
import { EAL_TOOLS } from './mcp.ts';

function tool(name: string) {
  const found = EAL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

describe('eal mcp tools', () => {
  let client: MockEalClient;

  beforeEach(() => {
    client = createMockEalClient();
    client.setCurrentUser({ userId: 1, displayName: 'alex' });
  });

  test('the tool set is non-destructive — there is no delete tool', () => {
    const names = EAL_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      'complete_task',
      'create_task',
      'get_task',
      'list_tasks',
      'next_actions',
      'place_call',
      'reopen_task',
      'set_task_status',
      'update_task',
    ]);
    expect(names.some((n) => n.includes('delete') || n.includes('remove'))).toBe(false);
  });

  test('create_task creates a task and reports it', async () => {
    const result = await tool('create_task').run(client, { title: 'Buy milk', notes: 'oat' });
    expect(result).toContain('Created');
    expect(result).toContain('Buy milk');
    expect(client.peekTasks().map((t) => t.title)).toEqual(['Buy milk']);
  });

  test('create_task without a title is a clear error', async () => {
    await expect(tool('create_task').run(client, {})).rejects.toThrow(/title is required/);
  });

  test('list_tasks renders matching tasks and a friendly empty message', async () => {
    expect(await tool('list_tasks').run(client, {})).toBe('No tasks match.');
    await client.createTask({ title: 'Walk Leo to school' });
    const listed = await tool('list_tasks').run(client, {});
    expect(listed).toContain('Walk Leo to school');
    // Level and status ride together: the assistant needs to know a row is a
    // project before it offers to file anything under it.
    expect(listed).toContain('[task/todo]');
  });

  test('list_tasks narrows to one level, and rejects a level it does not know', async () => {
    await client.createTask({ title: 'Renovate the kitchen', kind: 'project' });
    await client.createTask({ title: 'Walk Leo to school' });
    expect(await tool('list_tasks').run(client, { kind: 'project' })).toBe(
      '#1 [project/todo] Renovate the kitchen',
    );
    // Dropping an unknown level would list everything and call it a filter.
    await expect(tool('list_tasks').run(client, { kind: 'milestone' })).rejects.toThrow(
      /kind must be/,
    );
  });

  test('update_task promotes a captured task, keeping its id', async () => {
    const created = await client.createTask({ title: 'Renovate the kitchen' });
    const out = await tool('update_task').run(client, { id: created.id, kind: 'project' });
    expect(out).toContain(`#${created.id} [project/todo]`);
  });

  test('complete_task then reopen_task flips status both ways', async () => {
    const created = await client.createTask({ title: 'Call plumber' });
    expect(await tool('complete_task').run(client, { id: created.id })).toContain('Completed');
    expect(client.peekTasks()[0]?.status).toBe('done');
    expect(await tool('reopen_task').run(client, { id: created.id })).toContain('Reopened');
    expect(client.peekTasks()[0]?.status).toBe('todo');
  });

  test('set_task_status moves a task along the workflow axis', async () => {
    const created = await client.createTask({ title: 'Wait on the electrician' });
    const out = await tool('set_task_status').run(client, { id: created.id, status: 'blocked' });
    expect(out).toContain(`#${created.id} [task/blocked]`);
    expect(client.peekTasks()[0]?.status).toBe('blocked');
  });

  test('set_task_status rejects a state outside the four', async () => {
    const created = await client.createTask({ title: 'x' });
    await expect(
      tool('set_task_status').run(client, { id: created.id, status: 'started' }),
    ).rejects.toThrow(/must be "todo", "doing", "blocked" or "done"/);
  });

  test('list_tasks filters by one of the four states', async () => {
    const a = await client.createTask({ title: 'not started' });
    const b = await client.createTask({ title: 'under way' });
    await client.setTaskStatus(b.id, 'doing');
    expect(await tool('list_tasks').run(client, { status: 'doing' })).toBe(
      `#${b.id} [task/doing] under way`,
    );
    expect(await tool('list_tasks').run(client, { status: 'todo' })).toBe(
      `#${a.id} [task/todo] not started`,
    );
  });

  test('update_task changes the title', async () => {
    const created = await client.createTask({ title: 'old' });
    const result = await tool('update_task').run(client, { id: created.id, title: 'new' });
    expect(result).toContain('new');
    expect(client.peekTasks()[0]?.title).toBe('new');
  });

  test('create_task and update_task set the order a container hands work out in', async () => {
    const created = await tool('create_task').run(client, {
      title: 'Renovate the kitchen',
      kind: 'project',
      sequential: true,
    });
    // The flag is said on the line the assistant reads back, because nothing
    // else about the row shows it and it changes what next_actions answers.
    expect(created).toContain('[project/todo] (sequential) Renovate the kitchen');
    const id = client.peekTasks()[0]?.id ?? 0;
    expect(await tool('update_task').run(client, { id, sequential: false })).toContain(
      '[project/todo] Renovate the kitchen',
    );
    // Parallel is the default, so it is not printed — a word on every container
    // meaning "nothing unusual" would crowd out the ones that mean something.
    expect(await tool('update_task').run(client, { id, sequential: false })).not.toContain(
      'parallel',
    );
  });

  test('a non-boolean sequential is refused rather than dropped', async () => {
    // Dropped, it would report success having changed nothing — and "nothing
    // changed" and "the project now hands out one step at a time" read the same
    // in the reply.
    await expect(
      tool('create_task').run(client, { title: 'x', sequential: 'yes' }),
    ).rejects.toThrow(/sequential must be true or false/);
    const created = await client.createTask({ title: 'y' });
    await expect(
      tool('update_task').run(client, { id: created.id, sequential: 1 }),
    ).rejects.toThrow(/sequential must be true or false/);
  });

  test('next_actions answers "what should I do next" across the whole tree', async () => {
    const project = await client.createTask({
      title: 'Renovate the kitchen',
      kind: 'project',
      sequential: true,
    });
    const one = await client.createTask({ title: 'Strip the wallpaper', parentId: project.id });
    await client.createTask({ title: 'Paint the ceiling', parentId: project.id });
    const loose = await client.createTask({ title: 'Book the dentist' });

    // The sequential project offers its first step and nothing else; the
    // container itself is not an action while it holds work.
    expect(await tool('next_actions').run(client, {})).toBe(
      `#${one.id} [task/todo] Strip the wallpaper\n#${loose.id} [task/todo] Book the dentist`,
    );

    // Finishing the first step advances the project to the second.
    await client.completeTask(one.id);
    const after = await tool('next_actions').run(client, {});
    expect(after).toContain('Paint the ceiling');
    expect(after).not.toContain('Strip the wallpaper');

    // A blocked step hands out nothing, which is the honest answer.
    await client.setTaskStatus(loose.id, 'blocked');
    const blocked = await tool('next_actions').run(client, {});
    expect(blocked).not.toContain('Book the dentist');
  });

  test('next_actions says so plainly when there is nothing available', async () => {
    const t = await client.createTask({ title: 'Wait for the plasterer' });
    await client.setTaskStatus(t.id, 'blocked');
    expect(await tool('next_actions').run(client, {})).toBe(
      'Nothing is available. Everything left is blocked, deferred, or waiting on a step before it.',
    );
  });

  // The two sentences a person actually says, as the rule each should become.
  test('create_task takes "every Tuesday" and "every 5 days after I do it"', async () => {
    const bins = await tool('create_task').run(client, {
      title: 'Put the bins out',
      due_at: '2026-09-22',
      recurrence: { every: 'week', days: ['tue'], basis: 'due' },
    });
    expect(bins).toBe('Created #1 [task/todo] Put the bins out (due 2026-09-22) (repeats: Every Tuesday)');
    const plants = await tool('create_task').run(client, {
      title: 'Water the plants',
      recurrence: { every: 'days', interval: 5, basis: 'completed' },
    });
    expect(plants).toContain('(repeats: Every 5 days after done)');
    expect(client.peekTasks().map((t) => t.recurrence)).toEqual([
      { every: 'week', days: ['tue'], basis: 'due' },
      { every: 'days', interval: 5, basis: 'completed' },
    ]);
  });

  test('a rule the api would refuse is refused before it is sent, in the same words', async () => {
    await expect(
      tool('create_task').run(client, { title: 'x', recurrence: { every: 'week', days: ['tuesday'], basis: 'due' } }),
    ).rejects.toThrow('recurrence.days must hold only mon, tue, wed, thu, fri, sat, sun');
    await expect(
      tool('create_task').run(client, { title: 'x', recurrence: { every: 'days', interval: 5 } }),
    ).rejects.toThrow('recurrence.basis must be "due" or "completed"');
    expect(client.peekTasks()).toEqual([]);
  });

  test('update_task sets a rule, and null ends the series', async () => {
    const created = await client.createTask({ title: 'Bins' });
    const set = await tool('update_task').run(client, {
      id: created.id,
      recurrence: { every: 'month', day: 31, basis: 'due' },
    });
    expect(set).toContain('(repeats: Monthly on the 31st)');
    const ended = await tool('update_task').run(client, { id: created.id, recurrence: null });
    expect(ended).not.toContain('repeats');
    expect(client.peekTasks()[0]?.recurrence).toBeNull();
  });

  test('complete_task on a recurring task reports both facts: done, and the next one', async () => {
    const created = await client.createTask({
      title: 'Bins',
      dueAt: '2026-09-22',
      recurrence: { every: 'days', interval: 7, basis: 'due' },
    });
    const out = await tool('complete_task').run(client, { id: created.id });
    const [first, second] = out.split('\n');
    expect(first).toBe(`Completed #${created.id} [task/done] Bins (due 2026-09-22)`);
    expect(second).toMatch(/^It repeats\. Next occurrence: #2 \[task\/todo\] Bins \(due \d{4}-\d{2}-\d{2}\) \(repeats: Every 7 days\)$/);
  });

  test('reopen_task says when it took an untouched next occurrence back', async () => {
    const created = await client.createTask({
      title: 'Bins',
      dueAt: '2026-09-22',
      recurrence: { every: 'days', interval: 7, basis: 'due' },
    });
    await tool('complete_task').run(client, { id: created.id });
    const out = await tool('reopen_task').run(client, { id: created.id });
    expect(out).toContain('was untouched, so it was removed (#2) and this task repeats again');
    expect(client.peekTasks().map((t) => t.id)).toEqual([created.id]);
  });

  test('set_task_status into done reports the next occurrence too', async () => {
    const created = await client.createTask({
      title: 'Bins',
      recurrence: { every: 'weekdays', basis: 'completed' },
    });
    const out = await tool('set_task_status').run(client, { id: created.id, status: 'done' });
    expect(out).toContain('It repeats. Next occurrence: #2');
  });

  test('the recurrence schema tells an assistant which basis a sentence means', () => {
    const schema = JSON.stringify(tool('create_task').inputSchema);
    // Not a style check: `basis` is the one field nobody says out loud, and an
    // assistant given no example guesses "due" for the plants.
    expect(schema).toContain('every Tuesday');
    expect(schema).toContain('every 5 days after I do it');
    expect(schema).toContain('\\"basis\\":\\"completed\\"');
  });

  test('numeric-id tools reject a missing id', async () => {
    await expect(tool('complete_task').run(client, {})).rejects.toThrow(/id must be a number/);
    await expect(tool('get_task').run(client, { id: 'seven' })).rejects.toThrow(/id must be a number/);
  });
});
