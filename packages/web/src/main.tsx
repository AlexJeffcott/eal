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
import { bootstrapTaskReminders } from './apps/tasks/actions.ts';
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
 * Whether a seed has been started for the current session. `installWsResync`
 * reads it to tell the two first-`connected` cases apart — see there.
 */
let seedAttempted = false;

/**
 * Fetch the signed-in user's server state into the local stores. Each fetch is
 * independent and non-fatal — a failure surfaces in its own panel rather than
 * blocking the others.
 */
async function seedSessionData(stores: AppStores): Promise<void> {
  seedAttempted = true;
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
    stores.$agentOnline.value = await stores.client.getAgentStatus();
  } catch {
    // A failed read must not claim the assistant is down: the WS announcement
    // corrects this the moment an agent connects or the last one leaves.
    stores.$agentOnline.value = true;
  }
  try {
    stores.$devices.value = await stores.client.listFamilyPhoneDevices();
  } catch (err) {
    stores.$devicesError.value = err instanceof Error ? err.message : String(err);
  }
  // What this browser already knows about reminders, and a refreshed
  // subscription if permission is already granted. Never asks for it — that
  // needs a tap (apps/tasks/actions.ts).
  await bootstrapTaskReminders(stores);
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
 * Refresh voicemails when the user lands on the family-phone panel.
 * The directory broadcast does not carry voicemail events, so a pure
 * fetch on entry is the simplest source of truth. The action handler
 * itself dispatches the load — keeps the orchestration in one place.
 */
function installFamilyPhoneRouteSync(stores: AppStores): void {
  $route.subscribe((path) => {
    if (
      path === '/family-phone' &&
      stores.$currentUser.value !== null &&
      stores.$pairedThisSession.value !== null
    ) {
      const handler = ACTION_REGISTRY['family-phone:load-voicemails'];
      if (handler) {
        void handler({
          stores,
          event: new Event('route-change'),
          data: {},
          element: document.body,
        });
      }
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
      seedAttempted = false;
      return;
    }
    if (user.userId === seededUserId) return;
    seededUserId = user.userId;
    void seedSessionData(stores);
  });
}

/**
 * Mirror the socket's own connection state into `$wsState`, and re-seed the
 * stores after every reconnect.
 *
 * The server keeps no per-client event log — a broadcast sent while a socket is
 * down is gone. A phone that suspends its tab therefore comes back to a stale
 * list unless something refetches, and before this the app also kept *reading*
 * `connected` the whole time. Re-seeding is cheap at household scale: one
 * `listTasks`, one `listMessages`, one roster, one device list.
 *
 * A `connected` that arrives before any seed has started is skipped: that is
 * the ordinary boot, where `installSessionSeeding` seeds on the `$currentUser`
 * transition a moment later, and seeding twice is pure waste. An offline cold
 * boot is the other order — the user comes from the saved copy, the seed runs
 * and fails with no network, and the first `connected` arrives afterwards. That
 * one must seed, or the list stays empty until the next drop.
 */
function installWsResync(stores: AppStores): void {
  stores.client.subscribeConnectionState((state) => {
    stores.$wsState.value = state;
    if (state !== 'connected') return;
    if (!seedAttempted) return;
    stores.$wsError.value = null;
    stores.$tasksError.value = null;
    void seedSessionData(stores);
  });

  // A suspended tab has nothing running to notice its socket died, so the
  // backoff timer only resumes when the tab does. Coming back to the app must
  // not then wait out a 30-second delay before the list is true again.
  const wakeUp = (): void => {
    if (stores.client.connectionState() === 'connected') return;
    stores.client.reconnectNow();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    wakeUp();
  });
  window.addEventListener('online', wakeUp);
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
  client.subscribeAgentStatus((online) => {
    stores.$agentOnline.value = online;
  });

  // The shell router and the tasks filter↔URL bridge. `installTaskUrlSync` is
  // route-aware — it stays dormant off `/tasks`, so the cli-pair page keeps its
  // `?code=` query untouched.
  installRouter();
  installTaskUrlSync();
  installAgentRulesRouteSync(stores);
  installFamilyPhoneRouteSync(stores);

  // Register the service worker: the offline shell cache and notifications.
  // Best-effort — failures are logged, and both stay off for the session.
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

  // Track the socket and re-seed after a drop. Installed before the first
  // `connect()` below, so no transition is missed.
  installWsResync(stores);

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
    // `$wsState` follows the socket through `installWsResync` — the client
    // reports `connecting`, `connected`, `reconnecting` and `error` itself.
    // Only the error *text* belongs to the shell.
    stores.$wsError.value = null;
    try {
      await client.connect();
    } catch (err) {
      stores.$wsError.value = err instanceof Error ? err.message : String(err);
    }
  }
  stores.$currentUser.value = me;
}

void bootstrap();
