// Browser tier — component test against MockEalClient. NOT real-api coverage.
// See ./README.md for tier scope and where real-api coverage lives.
import { describe, test, expect, waitFor, done } from '@fairfox/polly/test/browser';
import { installEventDelegation } from '@fairfox/polly/actions';
import { render } from 'preact';
import { createMockEalClient } from '@eal/client-mock';
import type { Message } from '@eal/client';
import { App } from '../../src/shell/app.tsx';
import { createStores, resetStoresForTest } from '../../src/stores.ts';
import {
  $agentOnline,
  $chatBusy,
  $chatError,
  $chatInput,
  $chatMessages,
  $chatStreaming,
  $currentUser,
} from '../../src/shell/stores.ts';
import { ACTION_REGISTRY } from '../../src/actions/registry.ts';

import '@fairfox/polly/ui/theme.css';
import '@fairfox/polly/ui/styles.css';
import '@fairfox/polly/ui/components.css';
import '../../src/shell/shell.css';

const root =
  document.getElementById('app') ??
  (() => {
    const el = document.createElement('div');
    el.id = 'app';
    document.body.appendChild(el);
    return el;
  })();

const mock = createMockEalClient();
const stores = createStores(mock);
installEventDelegation((dispatch) => {
  const handler = ACTION_REGISTRY[dispatch.action];
  if (handler) void handler({ ...dispatch, stores });
});

function msg(id: number, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, createdBy: 1, createdAt: '2026-05-20T00:00:00Z' };
}

function signedIn(): void {
  resetStoresForTest();
  mock.reset();
  // The chat-event handler — the same one main.tsx installs in production.
  mock.subscribeChatEvents((event) => {
    switch (event.type) {
      case 'chat:user':
        $chatMessages.value = [...$chatMessages.value, event.message];
        return;
      case 'chat:chunk':
        $chatStreaming.value = ($chatStreaming.value ?? '') + event.delta;
        return;
      case 'chat:done':
        $chatMessages.value = [...$chatMessages.value, event.message];
        $chatStreaming.value = null;
        $chatBusy.value = false;
        return;
      case 'chat:error':
        $chatError.value = event.message;
        $chatStreaming.value = null;
        $chatBusy.value = false;
        return;
    }
  });
  // The agent-status handler — the same one main.tsx installs in production.
  mock.subscribeAgentStatus((online) => {
    $agentOnline.value = online;
  });
  $currentUser.value = { userId: 1, displayName: 'Alex' };
  render(<App />, root);
}

function click(selector: string): void {
  document.querySelector<HTMLButtonElement>(selector)?.click();
}

describe('ChatPanel (browser)', () => {
  test('the assistant sheet is closed until opened from the top bar', async () => {
    signedIn();
    expect(document.querySelector('[data-chat-panel]')).toBeNull();

    click('[data-action="chat:toggle"]');
    await waitFor(() => document.querySelector('[data-chat-input-form]') !== null);
    expect(document.querySelector('[data-chat-empty]')).not.toBeNull();
  });

  test('with no assistant online the composer is disabled and says why', async () => {
    // The relay routes chat to a connected `eal agent` process; with none, a
    // sent message comes back as an error the person reads only after typing.
    signedIn();
    mock.emitAgentStatus(false);
    click('[data-action="chat:toggle"]');
    await waitFor(() => document.querySelector('[data-chat-input-form]') !== null);

    const notice = document.querySelector('[data-chat-offline]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent ?? '').toContain('eal agent');
    expect(
      document.querySelector<HTMLButtonElement>('[data-action="chat:send"]')?.disabled,
    ).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#chat-input')?.disabled).toBe(true);
  });

  test('the composer recovers on its own when an assistant connects', async () => {
    // The machine at home comes back. No reload, no re-open of the sheet.
    signedIn();
    mock.emitAgentStatus(false);
    click('[data-action="chat:toggle"]');
    await waitFor(() => document.querySelector('[data-chat-offline]') !== null);

    mock.emitAgentStatus(true);
    await waitFor(() => document.querySelector('[data-chat-offline]') === null);
    expect(
      document.querySelector<HTMLButtonElement>('[data-action="chat:send"]')?.disabled,
    ).toBe(false);
  });

  test('sending a message records it, clears the input, and enters the busy state', async () => {
    signedIn();
    click('[data-action="chat:toggle"]');
    await waitFor(() => document.querySelector('[data-chat-input-form]') !== null);

    $chatInput.value = 'what is due today?';
    click('[data-action="chat:send"]');

    await waitFor(() => $chatBusy.value === true);
    expect(mock.peekSentChats()).toEqual(['what is due today?']);
    expect($chatInput.value).toBe('');
  });

  test('a relayed reply streams in and lands as an assistant bubble', async () => {
    signedIn();
    click('[data-action="chat:toggle"]');
    await waitFor(() => document.querySelector('[data-chat-input-form]') !== null);

    mock.emitChatEvent({ type: 'chat:user', message: msg(1, 'user', 'plan my day') });
    await waitFor(() => document.querySelector('[data-chat-message]') !== null);

    mock.emitChatEvent({ type: 'chat:chunk', delta: 'You have ' });
    mock.emitChatEvent({ type: 'chat:chunk', delta: 'two tasks.' });
    await waitFor(
      () => document.querySelector('[data-chat-streaming]')?.textContent?.includes('You have two tasks.') === true,
    );

    mock.emitChatEvent({ type: 'chat:done', message: msg(2, 'assistant', 'You have two tasks.') });
    await waitFor(() => document.querySelector('[data-chat-streaming]') === null);

    const bubbles = document.querySelectorAll('[data-chat-message]');
    expect(bubbles.length).toBe(2);
    expect(bubbles[1]?.getAttribute('data-chat-role')).toBe('assistant');
    expect($chatBusy.value).toBe(false);
  });

  test('a relayed chat:error surfaces and clears the busy state', async () => {
    signedIn();
    click('[data-action="chat:toggle"]');
    await waitFor(() => document.querySelector('[data-chat-input-form]') !== null);
    $chatBusy.value = true;

    mock.emitChatEvent({ type: 'chat:error', message: 'No assistant is online — start `eal agent`.' });
    await waitFor(() => document.querySelector('[data-chat-error]') !== null);

    expect(document.querySelector('[data-chat-error]')?.textContent).toContain('No assistant is online');
    expect($chatBusy.value).toBe(false);
  });

  test('a pre-existing conversation renders when the panel opens', async () => {
    signedIn();
    $chatMessages.value = [msg(1, 'user', 'hello'), msg(2, 'assistant', 'hi Alex')];
    click('[data-action="chat:toggle"]');
    await waitFor(() => document.querySelector('[data-chat-transcript]') !== null);

    const bubbles = document.querySelectorAll('[data-chat-message]');
    expect(bubbles.length).toBe(2);
    expect(bubbles[0]?.textContent).toContain('hello');
    expect(bubbles[1]?.textContent).toContain('hi Alex');
  });

  test('Clear is hidden while the thread is empty', async () => {
    signedIn();
    click('[data-action="chat:toggle"]');
    await waitFor(() => document.querySelector('[data-chat-input-form]') !== null);
    expect(document.querySelector('[data-action="chat:clear"]')).toBeNull();
  });

  test('Clear appears once there are messages and resets the thread', async () => {
    signedIn();
    $chatMessages.value = [msg(1, 'user', 'hello'), msg(2, 'assistant', 'hi Alex')];
    click('[data-action="chat:toggle"]');
    await waitFor(() => document.querySelector('[data-chat-transcript]') !== null);
    expect(document.querySelector('[data-action="chat:clear"]')).not.toBeNull();

    click('[data-action="chat:clear"]');
    await waitFor(() => $chatMessages.value.length === 0);
    expect(document.querySelector('[data-chat-empty]')).not.toBeNull();
    expect(document.querySelector('[data-action="chat:clear"]')).toBeNull();
  });
});

done();
