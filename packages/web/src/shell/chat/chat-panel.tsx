import { Badge, Button, Layout, Modal, Surface, Text, TextInput } from '@fairfox/polly/ui';
import {
  $chatBusy,
  $chatError,
  $chatInput,
  $chatMessages,
  $chatOpen,
  $chatStreaming,
} from '../stores.ts';

/**
 * The global assistant chat — a right-edge sheet overlay, one continuous thread
 * like a messaging app. Opened by the top bar's Assistant button, dismissed by
 * Escape, the backdrop, or Close. The transcript scrolls inside its own region
 * (`#chat-transcript`); main.tsx keeps it pinned to the latest message. "Clear"
 * resets the thread. All mutation flows through the `chat:*` actions and the WS
 * relay. The sheet is the same at every width; see `shell.css`.
 */

function MessageBubble({ role, content }: { role: 'user' | 'assistant'; content: string }) {
  const isUser = role === 'user';
  return (
    <div data-chat-message data-chat-role={role}>
      <Surface variant="callout" padding="var(--polly-space-sm) var(--polly-space-md)">
        <Layout gap="var(--polly-space-xs)">
          <span>
            <Badge variant={isUser ? 'info' : 'success'}>{isUser ? 'You' : 'Assistant'}</Badge>
          </span>
          <span data-chat-content class="eal-prewrap">
            {content}
          </span>
        </Layout>
      </Surface>
    </div>
  );
}

export function ChatPanel() {
  const messages = $chatMessages.value;
  const streaming = $chatStreaming.value;
  const busy = $chatBusy.value;
  const error = $chatError.value;
  const hasContent = messages.length > 0 || streaming !== null;

  return (
    <Modal.Root
      when={$chatOpen}
      onClose={() => {
        $chatOpen.value = false;
      }}
      aria-label="Assistant"
    >
      <Modal.Backdrop />
      <Modal.Content className="shell-sheet">
        <Layout rows="auto 1fr auto" height="100%" data-chat-panel>
          <Layout
            columns="1fr auto"
            gap="var(--polly-space-md)"
            alignItems="center"
            padding="var(--polly-space-lg)"
          >
            <h2>Assistant</h2>
            <Layout
              inline
              columns={hasContent ? 'auto auto' : 'auto'}
              gap="var(--polly-space-xs)"
              alignItems="center"
            >
              {hasContent ? (
                <Button tier="tertiary" size="small" data-action="chat:clear" label="Clear" />
              ) : null}
              <Button tier="tertiary" size="small" data-action="chat:toggle" label="Close" />
            </Layout>
          </Layout>

          {!hasContent ? (
            <Layout padding="0 var(--polly-space-lg)">
              <p data-chat-empty>
                <Text tone="muted">
                  Ask the assistant to plan your day, summarise what’s due, or change tasks for
                  you.
                </Text>
              </p>
            </Layout>
          ) : (
            <div id="chat-transcript" data-chat-transcript class="shell-chat-transcript">
              <Layout gap="var(--polly-space-sm)">
                {messages.map((m) => (
                  <MessageBubble key={m.id} role={m.role} content={m.content} />
                ))}
                {streaming !== null ? (
                  <div data-chat-streaming>
                    <MessageBubble
                      role="assistant"
                      content={streaming.length > 0 ? streaming : '…'}
                    />
                  </div>
                ) : null}
                {busy && streaming === null ? (
                  <Text as="p" tone="muted">The assistant is thinking…</Text>
                ) : null}
              </Layout>
            </div>
          )}

          <Layout gap="var(--polly-space-sm)" padding="var(--polly-space-lg)">
            {error ? (
              <span data-chat-error>
                <Badge variant="danger">{error}</Badge>
              </span>
            ) : null}
            <div data-chat-input-form>
              <Layout columns="1fr auto" gap="var(--polly-space-sm)" alignItems="center">
                <TextInput
                  id="chat-input"
                  name="text"
                  value={$chatInput}
                  placeholder="Message the assistant and press Enter"
                />
                <Button
                  tier="primary"
                  color="info"
                  data-action="chat:send"
                  label={busy ? 'Sending…' : 'Send'}
                />
              </Layout>
            </div>
          </Layout>
        </Layout>
      </Modal.Content>
    </Modal.Root>
  );
}
