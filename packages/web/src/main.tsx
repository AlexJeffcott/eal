import { render } from 'preact';
import { installEventDelegation } from '@fairfox/polly/actions';
import { createEalClient, type ChatBrowserEvent, type Task, type TaskEvent } from '@eal/client';
import { App } from './shell/app.tsx';
import { ErrorBoundary, FatalErrorFallback } from './shell/error-boundary.tsx';
import { CLI_PAIR_PATH } from './shell/auth/cli-pair.tsx';
import { createStores, type AppStores } from './stores.ts';
import {
  $chatBusy,
  $chatError,
  $chatMessages,
  $chatOpen,
  $chatStreaming,
  $cliPairCode,
  $cliPairLabel,
} from './shell/stores.ts';
import { $tasksById } from './apps/tasks/stores.ts';
import { bindShowcaseForm } from './apps/showcase/stores.ts';
import { ACTION_REGISTRY } from './actions/registry.ts';
import { bootstrapDevices } from './apps/devices/actions.ts';
import { refreshAgentRules } from './apps/agent-rules/actions.ts';
import { installTaskUrlSync } from './apps/tasks/url-sync.ts';
import { $route } from './shell/router.ts';
import { installServiceWorker } from './platform/service-worker.ts';
import { installRouter } from './shell/router.ts';

import '@fairfox/polly/ui/theme.css';
import '@fairfox/polly/ui/styles.css';
import '@fairfox/polly/ui/components.css';
import './shell/shell.css';
import './apps/tasks/tasks.css';
import './apps/showcase/showcase.css';
import './apps/devices/devices.css';
import './apps/family-phone/family-phone.css';

/**
 * Apply a server-canonical task event to the local store. Used for both:
 *  - the initial GET /api/v1/tasks population (each row becomes a task:created
 *    style insert into the map);
 *  - subsequent WS broadcasts that reconcile optimistic local mutations.
 */
function applyTaskEvent(event: TaskEvent): void {
  const next = new Map($tasksById.value);
  if (event.type === 'task:tree-cloned') {
    for (const t of event.payload.tasks) next.set(t.id, t);
  } else {
    next.set(event.payload.id, event.payload);
  }
  $tasksById.value = next;
}

function seedTasks(tasks: readonly Task[]): void {
  const next = new Map<number, Task>();
  for (const t of tasks) next.set(t.id, t);
  $tasksById.value = next;
}

/**
 * Apply a relayed chat event to the chat stores. `chat:user` and `chat:done`
 * append canonical persisted rows; `chat:chunk` grows the live streaming reply;
 * `chat:error` surfaces a failure. `chat:done`/`chat:error` end the busy span.
 */
function applyChatEvent(event: ChatBrowserEvent): void {
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
}

/** How close to the bottom still counts as "following the conversation". */
const CHAT_STICK_THRESHOLD_PX = 80;

/**
 * Keep the chat transcript pinned to the latest message — but only while the
 * reader is at the bottom. Once they scroll up, new content no longer yanks
 * them down. The transcript element (`#chat-transcript`) comes and goes as the
 * panel toggles, so everything is looked up live.
 */
function installChatAutoScroll(): void {
  let stickToBottom = true;

  const transcript = (): HTMLElement | null => document.getElementById('chat-transcript');

  // `scroll` doesn't bubble — capture catches the transcript's own scrolls.
  document.addEventListener(
    'scroll',
    (e) => {
      const el = transcript();
      if (el && e.target === el) {
        stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < CHAT_STICK_THRESHOLD_PX;
      }
    },
    true,
  );

  const follow = (): void => {
    requestAnimationFrame(() => {
      const el = transcript();
      if (el && stickToBottom) el.scrollTop = el.scrollHeight;
    });
  };

  $chatMessages.subscribe(follow);
  $chatStreaming.subscribe(follow);
  $chatOpen.subscribe(() => {
    // Opening the panel should land on the most recent message.
    stickToBottom = true;
    follow();
  });
}

/**
 * Fetch the signed-in user's server state into the local stores. Each fetch is
 * independent and non-fatal — a failure surfaces in its own panel rather than
 * blocking the others.
 */
async function seedSessionData(stores: AppStores): Promise<void> {
  try {
    seedTasks(await stores.client.listTasks());
  } catch (err) {
    stores.$tasksError.value = err instanceof Error ? err.message : String(err);
  }
  try {
    stores.$chatMessages.value = await stores.client.listMessages();
  } catch (err) {
    stores.$chatError.value = err instanceof Error ? err.message : String(err);
  }
  try {
    stores.$householdUsers.value = await stores.client.listUsers();
  } catch {
    stores.$householdUsers.value = [];
  }
  try {
    stores.$devices.value = await stores.client.listFamilyPhoneDevices();
  } catch (err) {
    stores.$devicesError.value = err instanceof Error ? err.message : String(err);
  }
  // Rehydrate a previously-paired device on this tab — if IndexedDB has one,
  // its WS reconnects automatically and the user is ready to call.
  await bootstrapDevices(stores);
}

/**
 * Refresh the agent-rules panel data when the user navigates to it.
 * The list is small; refetching on every visit keeps the UI honest
 * against scheduler ticks that happened while the user was on
 * another page.
 */
function installAgentRulesRouteSync(stores: AppStores): void {
  $route.subscribe((path) => {
    if (path === '/agent-rules' && stores.$currentUser.value !== null) {
      void refreshAgentRules(stores);
    }
  });
}

/**
 * Seed the signed-in user's data whenever authentication completes — at boot
 * for an existing session, and after an in-session register or sign-in. Keying
 * off `$currentUser` keeps the auth actions ignorant of seeding, and means a
 * returning user's tasks/roster/chat populate without a page reload.
 */
function installSessionSeeding(stores: AppStores): void {
  let seededUserId: number | null = null;
  stores.$currentUser.subscribe((user) => {
    if (user === null) {
      seededUserId = null;
      return;
    }
    if (user.userId === seededUserId) return;
    seededUserId = user.userId;
    void seedSessionData(stores);
  });
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('no #app element to mount into');

  const client = createEalClient(window.location.origin);
  const stores = createStores(client);

  // The showcase app's <ActionForm> needs its form bound to the live stores
  // before a submit can run; the form itself is module-scoped and has none.
  bindShowcaseForm(stores);

  installEventDelegation((dispatch) => {
    const handler = ACTION_REGISTRY[dispatch.action];
    if (!handler) return;
    void handler({ ...dispatch, stores });
  });

  client.subscribeTaskEvents(applyTaskEvent);
  client.subscribeChatEvents(applyChatEvent);

  // The shell router and the tasks filter↔URL bridge. `installTaskUrlSync` is
  // route-aware — it stays dormant off `/tasks`, so the cli-pair page keeps its
  // `?code=` query untouched.
  installRouter();
  installTaskUrlSync();
  installAgentRulesRouteSync(stores);

  // Register the notifications service worker. Best-effort — failures
  // are logged and notifications stay disabled for the session.
  void installServiceWorker();

  // Global Q shortcut: focus the quick-add input from anywhere on the page.
  // GTD-style capture should require one keystroke; the user shouldn't have to
  // click into the input first. Ignores keystrokes when the user is already
  // typing in some other input.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'q' && e.key !== 'Q') return;
    const target = e.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
    }
    const input = document.getElementById('tasks-quick-add');
    if (input instanceof HTMLInputElement) {
      e.preventDefault();
      input.focus();
    }
  });

  // Enter in the quick-add input dispatches the same `tasks:quick-add` action
  // that the "Add" button uses. We avoid wrapping the input in a <form>
  // entirely so there's no risk of a default browser submission slipping
  // through when polly's async action handler defers its preventDefault.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id !== 'tasks-quick-add') return;
    e.preventDefault();
    const handler = ACTION_REGISTRY['tasks:quick-add'];
    if (!handler) return;
    void handler({
      element: target,
      event: e,
      data: {},
      stores,
    });
  });

  // Enter in the chat input sends the message — same `chat:send` action the
  // Send button dispatches.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id !== 'chat-input') return;
    e.preventDefault();
    const handler = ACTION_REGISTRY['chat:send'];
    if (!handler) return;
    void handler({ element: target, event: e, data: {}, stores });
  });

  // Chat transcript auto-scroll. The transcript follows new content while the
  // reader is at the bottom, and leaves them alone once they scroll up to read
  // history. Components can't use hooks here (polly $state replaces them), so
  // this is imperative glue keyed off the chat signals — same pattern as the
  // filter url-sync.
  installChatAutoScroll();

  // Seed tasks / roster / chat whenever a user becomes authenticated — at boot
  // and after an in-session register or sign-in. Installed before $currentUser
  // is ever set so the very first transition is caught.
  installSessionSeeding(stores);

  // Pre-fill the pairing form from the URL query so users who follow the link
  // their CLI printed don't have to retype the code or the device label.
  if (window.location.pathname === CLI_PAIR_PATH) {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) $cliPairCode.value = code;
    const label = params.get('label');
    if (label) $cliPairLabel.value = label;
  }

  // The outermost boundary: if the shell chrome itself throws, there is no
  // trustworthy UI left — the fallback is a bare page whose only action is a
  // full reload.
  render(
    <ErrorBoundary fallback={<FatalErrorFallback />}>
      <App />
    </ErrorBoundary>,
    root,
  );

  // Auth gate: connect the WS only once a session is established, surfacing
  // failures via $wsState / $wsError. $currentUser is flipped last — the DOM
  // transition and the seeding subscription both fire on that write, after the
  // broadcast plumbing is live.
  const me = await client.getCurrentUser();
  if (me) {
    stores.$wsState.value = 'connecting';
    stores.$wsError.value = null;
    try {
      await client.connect();
      stores.$wsState.value = 'connected';
    } catch (err) {
      stores.$wsState.value = 'error';
      stores.$wsError.value = err instanceof Error ? err.message : String(err);
    }
  }
  stores.$currentUser.value = me;
}

// Register the service worker if the browser supports it. The SW currently
// only exists to satisfy Chrome's install-criteria heuristic — no caching,
// no push handling — but living at the root scope means a future offline
// or push story slots in without re-registering.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
    // Service worker registration failures are non-fatal; the app works
    // without it, just without the Add-to-Home-Screen banner on Android.
    console.warn('service worker registration failed', err);
  });
}

void bootstrap();
