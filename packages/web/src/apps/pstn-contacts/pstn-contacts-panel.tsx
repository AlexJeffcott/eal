import {
  ActionInput,
  ActionSelect,
  Badge,
  Button,
  Cluster,
  Layout,
  Surface,
  Text,
} from '@fairfox/polly/ui';
import { Show } from '@preact/signals/utils';
import type { HouseholdMember, PstnContact } from '@eal/client';
import {
  $pstnContacts,
  $pstnContactsError,
  $pstnDraftAllowIn,
  $pstnDraftAllowOut,
  $pstnDraftE164,
  $pstnDraftIntendedUserId,
  $pstnDraftLabel,
  $pstnEditingId,
} from './stores.ts';
import { $householdUsers } from '../tasks/stores.ts';

function ErrorBanner(props: { error: string }) {
  return (
    <Surface variant="callout" padding="var(--polly-space-sm)">
      <Cluster gap="var(--polly-space-sm)" justify="space-between">
        <Badge variant="danger">{props.error}</Badge>
        <Button
          tier="tertiary"
          label="Dismiss"
          data-action="pstn-contacts:dismiss-error"
        />
      </Cluster>
    </Surface>
  );
}

/**
 * The new/edit-contact form. Reads $pstnEditingId reactively so the same
 * card flips between "New contact" and "Edit contact" without an extra
 * mount cycle. E.164 is disabled in edit mode — the server enforces the
 * immutability and the disabled input mirrors it in the UI.
 */
function ContactFormCard() {
  const editingId = $pstnEditingId.value;
  const isEditing = editingId !== null;
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-md)" data-pstn-contacts-form>
        <Text as="h2" weight="bold">
          {isEditing ? 'Edit contact' : 'New contact'}
        </Text>
        <Text tone="muted">
          E.164 only — the leading `+`, then the country code, then the number.
          The number is immutable once saved; rename or delete to change it.
        </Text>

        <Layout gap="var(--polly-space-sm)">
          <ActionInput
            saveOn="input"
            value={$pstnDraftE164.value}
            action="pstn-contacts:set-e164"
            placeholder="+441234567890"
            ariaLabel="E.164 phone number"
            disabled={isEditing}
          />

          <ActionInput
            saveOn="input"
            value={$pstnDraftLabel.value}
            action="pstn-contacts:set-label"
            placeholder="Friendly label (e.g. Nonna)"
            ariaLabel="Friendly label"
          />

          <Cluster gap="var(--polly-space-sm)">
            <Button
              tier={$pstnDraftAllowIn.value ? 'primary' : 'tertiary'}
              size="small"
              label={$pstnDraftAllowIn.value ? 'Inbound: on' : 'Inbound: off'}
              data-action="pstn-contacts:toggle-allow-in"
            />
            <Button
              tier={$pstnDraftAllowOut.value ? 'primary' : 'tertiary'}
              size="small"
              label={$pstnDraftAllowOut.value ? 'Outbound: on' : 'Outbound: off'}
              data-action="pstn-contacts:toggle-allow-out"
            />
          </Cluster>

          <Layout gap="var(--polly-space-xs)">
            <Text tone="muted">
              Calling for — inbound rings only this person and any
              voicemail lands in their inbox. Leave as "Anyone" to use
              the DTMF menu instead.
            </Text>
            <ActionSelect
              value={
                $pstnDraftIntendedUserId.value === null
                  ? 'none'
                  : String($pstnDraftIntendedUserId.value)
              }
              options={[
                { value: 'none', label: 'Anyone (use DTMF menu)' },
                ...$householdUsers.value.map((u: HouseholdMember) => ({
                  value: String(u.id),
                  label: u.displayName,
                })),
              ]}
              action="pstn-contacts:set-intended-user"
            />
          </Layout>

          <Cluster gap="var(--polly-space-sm)">
            {isEditing ? (
              <>
                <Button
                  tier="primary"
                  label="Save"
                  data-action="pstn-contacts:save-edit"
                />
                <Button
                  tier="tertiary"
                  label="Cancel"
                  data-action="pstn-contacts:cancel-edit"
                />
              </>
            ) : (
              <Button
                tier="primary"
                label="Create contact"
                data-action="pstn-contacts:create"
              />
            )}
          </Cluster>
        </Layout>
      </Layout>
    </Surface>
  );
}

function intendedUserLabel(contact: PstnContact, users: HouseholdMember[]): string | null {
  if (contact.intendedUserId === null) return null;
  const u = users.find((x) => x.id === contact.intendedUserId);
  return u?.displayName ?? `user #${contact.intendedUserId}`;
}

function ContactRow(props: { contact: PstnContact; users: HouseholdMember[] }) {
  const { contact } = props;
  const intended = intendedUserLabel(contact, props.users);
  return (
    <Surface variant="plain" padding="var(--polly-space-sm)">
      <Layout gap="var(--polly-space-xs)" data-pstn-row data-pstn-row-id={String(contact.id)}>
        <Cluster gap="var(--polly-space-sm)" justify="space-between">
          <Cluster gap="var(--polly-space-sm)">
            <Text weight="medium" data-pstn-row-label>{contact.label}</Text>
            <Text tone="muted" data-pstn-row-e164>{contact.e164}</Text>
            {intended !== null && <Badge variant="info">→ {intended}</Badge>}
          </Cluster>
          <Cluster gap="var(--polly-space-xs)">
            <Button
              tier="tertiary"
              label="Edit"
              data-action="pstn-contacts:start-edit"
              data-action-contact-id={String(contact.id)}
            />
            <Button
              tier="tertiary"
              color="danger"
              label="Delete"
              data-action="pstn-contacts:delete"
              data-action-contact-id={String(contact.id)}
            />
          </Cluster>
        </Cluster>
        <Cluster gap="var(--polly-space-xs)">
          <Badge variant={contact.allowIn ? 'success' : 'default'}>
            {contact.allowIn ? 'Inbound on' : 'Inbound off'}
          </Badge>
          <Badge variant={contact.allowOut ? 'success' : 'default'}>
            {contact.allowOut ? 'Outbound on' : 'Outbound off'}
          </Badge>
        </Cluster>
      </Layout>
    </Surface>
  );
}

/**
 * Reads $pstnContacts directly so signal updates re-render this card
 * (not the whole panel). Pinning the read inside `Show`'s predicate and
 * inside the map below makes the subscription explicit at render time.
 */
function IvrMenuCard() {
  const users = $householdUsers.value;
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-sm)">
        <Text as="h2" weight="bold">Inbound DTMF menu</Text>
        <Text tone="muted">
          When an unknown number calls the household trunk, the IVR
          reads out a press-N menu of the people opted in here. Strangers
          can then route themselves to a specific person instead of
          ringing every handset.
        </Text>
        <Show
          when={() => users.length > 0}
          fallback={<Text tone="muted">No household members yet.</Text>}
        >
          <Layout gap="var(--polly-space-xs)">
            {users.map((u) => (
              <Cluster
                key={u.id}
                gap="var(--polly-space-sm)"
                justify="space-between"
                className="pstn-contacts-ivr-row"
              >
                <Text>{u.displayName}</Text>
                <Button
                  tier={u.inIvrMenu ? 'primary' : 'tertiary'}
                  size="small"
                  label={u.inIvrMenu ? 'In menu' : 'Off menu'}
                  data-action="pstn-contacts:toggle-ivr-menu"
                  data-action-user-id={String(u.id)}
                  data-action-current={String(u.inIvrMenu)}
                />
              </Cluster>
            ))}
          </Layout>
        </Show>
      </Layout>
    </Surface>
  );
}

function ContactsListCard() {
  const contacts = $pstnContacts.value;
  const users = $householdUsers.value;
  return (
    <Surface variant="callout" padding="var(--polly-space-md)">
      <Layout gap="var(--polly-space-sm)" data-pstn-list>
        <Cluster gap="var(--polly-space-sm)" justify="space-between">
          <Text as="h2" weight="bold">Contacts</Text>
          <Button tier="tertiary" label="Refresh" data-action="pstn-contacts:refresh" />
        </Cluster>
        <Show
          when={() => $pstnContacts.value.length > 0}
          fallback={
            <Text tone="muted" data-pstn-empty>
              No contacts yet. Add one above.
            </Text>
          }
        >
          <Layout gap="var(--polly-space-xs)">
            {contacts.map((c) => (
              <ContactRow key={c.id} contact={c} users={users} />
            ))}
          </Layout>
        </Show>
      </Layout>
    </Surface>
  );
}

export function PstnContactsPanel() {
  return (
    <Layout gap="var(--polly-space-lg)" data-pstn-contacts-panel>
      <Surface variant="plain" padding="var(--polly-space-md)">
        <Text as="h1" weight="bold">PSTN contacts</Text>
        <Text tone="muted">
          The household's phonebook for external numbers. Inbound rings the
          household when a contact's <em>Inbound</em> is on; outbound dials
          only when <em>Outbound</em> is on.
        </Text>
      </Surface>

      <Show when={$pstnContactsError}>
        {(err) => <ErrorBanner error={err} />}
      </Show>

      <ContactFormCard />
      <ContactsListCard />
      <IvrMenuCard />
    </Layout>
  );
}
