import type { ComponentChildren, JSX } from 'preact';
import {
  ActionForm,
  ActionInput,
  ActionSelect,
  Badge,
  Button,
  Card,
  Checkbox,
  Cluster,
  Code,
  Collapsible,
  Dropdown,
  Layout,
  Modal,
  Select,
  Skeleton,
  Surface,
  Tabs,
  Text,
  TextInput,
  Toggle,
} from '@fairfox/polly/ui';
import {
  $showcaseChecked,
  $showcaseCommitted,
  $showcaseDropdownOpen,
  $showcaseModalOpen,
  $showcaseSelectClearable,
  $showcaseSelectMulti,
  $showcaseSelectSingle,
  $showcaseTab,
  $showcaseText,
  showcaseForm,
} from './stores.ts';

/**
 * One catalogued example: a stage holding live component(s) and a caption
 * naming the configuration on show. `wide` spans every grid column for
 * specimens that need the room (layouts, forms, cards).
 */
function Specimen(props: { caption: string; wide?: boolean; children: ComponentChildren }) {
  return (
    <Surface
      variant="sunken"
      radius="md"
      border="default"
      padding="var(--polly-space-md)"
      className={props.wide ? 'showcase-specimen showcase-specimen--wide' : 'showcase-specimen'}
    >
      <Layout gap="var(--polly-space-sm)">
        <div class="showcase-stage">{props.children}</div>
        <Text size="xs" tone="muted" className="showcase-code">
          {props.caption}
        </Text>
      </Layout>
    </Surface>
  );
}

/** A neutral filler block for the layout specimens. */
function Box(props: { children: ComponentChildren }) {
  return (
    <Surface variant="raised" radius="sm" border="default" padding="var(--polly-space-sm)">
      <Text size="sm">{props.children}</Text>
    </Surface>
  );
}

const STAR: JSX.Element = (
  <span aria-hidden="true" class="showcase-icon">
    ★
  </span>
);

export interface ShowcaseSection {
  id: string;
  title: string;
  summary: string;
  render: () => JSX.Element;
}

export const SHOWCASE_SECTIONS: readonly ShowcaseSection[] = [
  {
    id: 'badge',
    title: 'Badge',
    summary: 'Small inline status chip. One variant per semantic tone.',
    render: () => (
      <>
        <Specimen caption='variant="default"'>
          <Badge variant="default">Default</Badge>
        </Specimen>
        <Specimen caption='variant="info"'>
          <Badge variant="info">Info</Badge>
        </Specimen>
        <Specimen caption='variant="success"'>
          <Badge variant="success">Success</Badge>
        </Specimen>
        <Specimen caption='variant="warning"'>
          <Badge variant="warning">Warning</Badge>
        </Specimen>
        <Specimen caption='variant="danger"'>
          <Badge variant="danger">Danger</Badge>
        </Specimen>
      </>
    ),
  },
  {
    id: 'button',
    title: 'Button',
    summary: 'Interactive control. Tier sets importance, color overlays meaning, size sets scale.',
    render: () => (
      <>
        <Specimen caption="tier: primary / secondary / tertiary">
          <Button tier="primary" label="Primary" />
          <Button tier="secondary" label="Secondary" />
          <Button tier="tertiary" label="Tertiary" />
        </Specimen>
        <Specimen caption="color: default / info / success / warning / danger">
          <Button color="default" label="Default" />
          <Button color="info" label="Info" />
          <Button color="success" label="Success" />
          <Button color="warning" label="Warning" />
          <Button color="danger" label="Danger" />
        </Specimen>
        <Specimen caption="size: small / normal / large">
          <Button size="small" label="Small" />
          <Button size="normal" label="Normal" />
          <Button size="large" label="Large" />
        </Specimen>
        <Specimen caption="disabled">
          <Button label="Disabled" disabled />
        </Specimen>
        <Specimen caption="icon + label">
          <Button icon={STAR} label="With icon" />
        </Specimen>
        <Specimen caption="circle">
          <Button circle aria-label="Star" label={STAR} />
        </Specimen>
        <Specimen caption="href — renders an <a>">
          <Button href="#button" tier="secondary" label="Link button" />
        </Specimen>
        <Specimen caption="fullWidth" wide>
          <Button fullWidth tier="primary" label="Full-width button" />
        </Specimen>
      </>
    ),
  },
  {
    id: 'text',
    title: 'Text',
    summary: 'Typographic primitive — tone, size, weight, italic, and leading.',
    render: () => (
      <>
        <Specimen caption="tone: default / muted / danger / warning / success">
          <Text tone="default">Default</Text>
          <Text tone="muted">Muted</Text>
          <Text tone="danger">Danger</Text>
          <Text tone="warning">Warning</Text>
          <Text tone="success">Success</Text>
        </Specimen>
        <Specimen caption="size: xs / sm / md / lg / xl">
          <Text size="xs">xs</Text>
          <Text size="sm">sm</Text>
          <Text size="md">md</Text>
          <Text size="lg">lg</Text>
          <Text size="xl">xl</Text>
        </Specimen>
        <Specimen caption="weight: normal / medium / bold">
          <Text weight="normal">Normal</Text>
          <Text weight="medium">Medium</Text>
          <Text weight="bold">Bold</Text>
        </Specimen>
        <Specimen caption="italic">
          <Text italic>Italic emphasis</Text>
        </Specimen>
        <Specimen caption='leading="loose" — multi-line body copy' wide>
          <Text as="p" leading="loose">
            A paragraph rendered with loose leading. Polly's Text primitive backs
            every span, paragraph, label, and caption so consumers never reach for
            a raw style attribute to set tone, size, weight, or line height.
          </Text>
        </Specimen>
      </>
    ),
  },
  {
    id: 'code',
    title: 'Code',
    summary: 'Monospace code — inline by default, or a wrapped block.',
    render: () => (
      <>
        <Specimen caption="inline">
          <Text>
            Run <Code>eal agent</Code> to start the assistant.
          </Text>
        </Specimen>
        <Specimen caption="block" wide>
          <Code block>{'const showcase: WebApp = {\n  access: "public",\n};'}</Code>
        </Specimen>
      </>
    ),
  },
  {
    id: 'surface',
    title: 'Surface',
    summary: 'Owns visual chrome — background, border, radius, shadow, positioning.',
    render: () => (
      <>
        {(['plain', 'raised', 'sunken', 'bubble', 'chip', 'callout'] as const).map((v) => (
          <Specimen key={v} caption={`variant="${v}"`}>
            <Surface variant={v} padding="var(--polly-space-md)">
              <Text size="sm">{v}</Text>
            </Surface>
          </Specimen>
        ))}
        <Specimen caption="radius: none / sm / md / lg / full">
          {(['none', 'sm', 'md', 'lg', 'full'] as const).map((r) => (
            <Surface
              key={r}
              variant="raised"
              border="default"
              radius={r}
              padding="var(--polly-space-sm)"
            >
              <Text size="xs">{r}</Text>
            </Surface>
          ))}
        </Specimen>
        <Specimen caption="border: none / default / strong">
          {(['none', 'default', 'strong'] as const).map((b) => (
            <Surface key={b} border={b} radius="md" padding="var(--polly-space-sm)">
              <Text size="xs">{b}</Text>
            </Surface>
          ))}
        </Specimen>
        <Specimen caption="shadow: sm / md / lg">
          {(['sm', 'md', 'lg'] as const).map((s) => (
            <Surface key={s} variant="raised" shadow={s} radius="md" padding="var(--polly-space-sm)">
              <Text size="xs">{s}</Text>
            </Surface>
          ))}
        </Specimen>
      </>
    ),
  },
  {
    id: 'card',
    title: 'Card',
    summary: 'Compound of Surfaces — a raised Root wrapping Header, Body, and Footer slots.',
    render: () => (
      <Specimen caption="Card.Root > Header / Body / Footer" wide>
        <Card.Root padding="0">
          <Card.Header padding="var(--polly-space-md)">
            <Text weight="bold">Card header</Text>
          </Card.Header>
          <Card.Body padding="var(--polly-space-md)">
            <Text>
              The body slot carries the main content. Each slot accepts the full
              SurfaceProps, so it can be retinted or repadded without reaching
              past the primitive.
            </Text>
          </Card.Body>
          <Card.Footer padding="var(--polly-space-md)">
            <Button size="small" tier="primary" label="Footer action" />
          </Card.Footer>
        </Card.Root>
      </Specimen>
    ),
  },
  {
    id: 'skeleton',
    title: 'Skeleton',
    summary: 'Shimmering placeholder for loading states. Animation honours reduced-motion.',
    render: () => (
      <>
        <Specimen caption='variant="text"'>
          <Skeleton variant="text" />
        </Specimen>
        <Specimen caption='variant="rect"'>
          <Skeleton variant="rect" />
        </Specimen>
        <Specimen caption='variant="circle"'>
          <Skeleton variant="circle" />
        </Specimen>
        <Specimen caption="custom width + height">
          <Skeleton variant="rect" width="100%" height={64} />
        </Specimen>
      </>
    ),
  },
  {
    id: 'collapsible',
    title: 'Collapsible',
    summary: 'Native <details>/<summary> disclosure — keyboard and screen-reader behaviour free.',
    render: () => (
      <>
        <Specimen caption="closed by default" wide>
          <Collapsible summary="Show more detail">
            <Text>This content is revealed when the disclosure is opened.</Text>
          </Collapsible>
        </Specimen>
        <Specimen caption="defaultOpen" wide>
          <Collapsible summary="Open from the start" defaultOpen>
            <Text>This collapsible renders expanded on first paint.</Text>
          </Collapsible>
        </Specimen>
      </>
    ),
  },
  {
    id: 'layout',
    title: 'Layout',
    summary: 'The grid primitive. Props map to CSS custom properties — no hand-written flex or grid.',
    render: () => (
      <>
        <Specimen caption='columns="1fr 1fr 1fr"' wide>
          <Layout columns="1fr 1fr 1fr" gap="var(--polly-space-sm)">
            <Box>1fr</Box>
            <Box>1fr</Box>
            <Box>1fr</Box>
          </Layout>
        </Specimen>
        <Specimen caption='columns="auto 1fr auto"' wide>
          <Layout columns="auto 1fr auto" gap="var(--polly-space-sm)" alignItems="center">
            <Box>auto</Box>
            <Box>1fr</Box>
            <Box>auto</Box>
          </Layout>
        </Specimen>
        <Specimen caption="stackOnMobile — collapses to one column ≤640px" wide>
          <Layout columns="1fr 1fr" gap="var(--polly-space-sm)" stackOnMobile>
            <Box>Side by side, then stacked</Box>
            <Box>Side by side, then stacked</Box>
          </Layout>
        </Specimen>
      </>
    ),
  },
  {
    id: 'cluster',
    title: 'Cluster',
    summary: 'Wrapping row of variable-width items — chips, tags, button groups. Reflows as space runs out.',
    render: () => (
      <Specimen caption="gap — items wrap onto new rows" wide>
        <Cluster gap="var(--polly-space-xs)">
          {['Groceries', 'Errands', 'Home', 'Garden', 'Finance', 'Travel', 'Health', 'Admin'].map(
            (tag) => (
              <Badge key={tag} variant="info">
                {tag}
              </Badge>
            ),
          )}
        </Cluster>
      </Specimen>
    ),
  },
  {
    id: 'tabs',
    title: 'Tabs',
    summary: 'Horizontal nav with an active-tab accent. Dispatches an action per tab.',
    render: () => (
      <Specimen caption="interactive — one tab disabled" wide>
        <Tabs
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'activity', label: 'Activity' },
            { id: 'settings', label: 'Settings' },
            { id: 'archived', label: 'Archived', disabled: true },
          ]}
          activeTab={$showcaseTab.value}
          action="showcase:set-tab"
          aria-label="Showcase tabs"
        />
      </Specimen>
    ),
  },
  {
    id: 'checkbox',
    title: 'Checkbox',
    summary: 'Native checkbox in a label. A plain boolean is controlled; a Signal binds itself.',
    render: () => (
      <>
        <Specimen caption="unchecked">
          <Checkbox label="Unchecked" checked={false} />
        </Specimen>
        <Specimen caption="checked">
          <Checkbox label="Checked" checked={true} />
        </Specimen>
        <Specimen caption="disabled">
          <Checkbox label="Disabled" checked={true} disabled />
        </Specimen>
        <Specimen caption="checked={signal} — click to toggle">
          <Checkbox label="Bound to a signal" checked={$showcaseChecked} />
        </Specimen>
      </>
    ),
  },
  {
    id: 'toggle',
    title: 'Toggle',
    summary: 'Switch-role checkbox. Passive — the caller drives the checked state.',
    render: () => (
      <>
        <Specimen caption="off">
          <Toggle label="Off" checked={false} />
        </Specimen>
        <Specimen caption="on">
          <Toggle label="On" checked={true} />
        </Specimen>
        <Specimen caption="disabled">
          <Toggle label="Disabled" checked={true} disabled />
        </Specimen>
      </>
    ),
  },
  {
    id: 'text-input',
    title: 'TextInput',
    summary:
      'Signal-friendly native input. A plain string is uncontrolled; a Signal is controlled. ' +
      'inputType picks the native keyboard and validation; error renders a linked message.',
    render: () => (
      <>
        <Specimen caption='variant="single" with placeholder'>
          <TextInput name="demo-single" placeholder="Type here…" />
        </Specimen>
        <Specimen caption='variant="multi"'>
          <TextInput name="demo-multi" variant="multi" rows={3} placeholder="Multiple lines…" />
        </Specimen>
        <Specimen caption='inputType="email"'>
          <TextInput name="demo-email" inputType="email" placeholder="ada@example.com" />
        </Specimen>
        <Specimen caption='inputType="number" with min/max/step'>
          <TextInput name="demo-number" inputType="number" min={0} max={10} step={1} value="5" />
        </Specimen>
        <Specimen caption="error — linked message, marks invalid">
          <TextInput name="demo-error" value="not-an-email" error="Enter a valid email address." />
        </Specimen>
        <Specimen caption="title — native hover tooltip">
          <TextInput name="demo-title" placeholder="Hover me" title="A hint beyond the placeholder." />
        </Specimen>
        <Specimen caption="invalid">
          <TextInput name="demo-invalid" value="not-an-email" invalid />
        </Specimen>
        <Specimen caption="disabled">
          <TextInput name="demo-disabled" value="Disabled" disabled />
        </Specimen>
        <Specimen caption="readOnly">
          <TextInput name="demo-readonly" value="Read only" readOnly />
        </Specimen>
        <Specimen caption="value={signal} — controlled">
          <TextInput name="demo-controlled" value={$showcaseText} />
        </Specimen>
      </>
    ),
  },
  {
    id: 'select',
    title: 'Select',
    summary:
      'Dropdown of options bound to a Signal<Set>. Single replaces, multi toggles. ' +
      'clearable prepends an "Any …" row so an optional filter has a path back to unset.',
    render: () => (
      <>
        <Specimen caption="single-select">
          <Select
            label="Pick one"
            options={[
              { value: 'comet', label: 'Comet' },
              { value: 'nebula', label: 'Nebula' },
              { value: 'quasar', label: 'Quasar' },
            ]}
            selected={$showcaseSelectSingle}
          />
        </Specimen>
        <Specimen caption="clearable — single-select with an “Any …” row">
          <Select
            label="Filter by"
            placeholder="Any object"
            clearable
            options={[
              { value: 'comet', label: 'Comet' },
              { value: 'nebula', label: 'Nebula' },
              { value: 'quasar', label: 'Quasar' },
            ]}
            selected={$showcaseSelectClearable}
          />
        </Specimen>
        <Specimen caption="multiSelect">
          <Select
            label="Pick several"
            multiSelect
            options={[
              { value: 'comet', label: 'Comet' },
              { value: 'nebula', label: 'Nebula' },
              { value: 'quasar', label: 'Quasar' },
            ]}
            selected={$showcaseSelectMulti}
          />
        </Specimen>
      </>
    ),
  },
  {
    id: 'dropdown',
    title: 'Dropdown',
    summary:
      'Low-level trigger + popover plumbing. The primitive itself has no chrome — ' +
      'consumers (Select, ActionSelect) wrap it with the styled trigger and caret.',
    render: () => (
      <Specimen caption="trigger dressed via triggerClassName + data-open">
        <Dropdown
          isOpen={$showcaseDropdownOpen}
          triggerClassName="showcase-dropdown-trigger"
          trigger={
            <>
              <span>Open menu</span>
              <span class="showcase-dropdown-caret" aria-hidden="true" />
            </>
          }
        >
          <Layout gap="var(--polly-space-xs)" padding="var(--polly-space-xs)">
            <Text>First item</Text>
            <Text>Second item</Text>
            <Text>Third item</Text>
          </Layout>
        </Dropdown>
      </Specimen>
    ),
  },
  {
    id: 'action-input',
    title: 'ActionInput',
    summary: 'Dual-mode view/edit field. Click to edit; commit dispatches an action.',
    render: () => (
      <>
        <Specimen caption='saveOn="blur"'>
          <ActionInput
            value="Click to edit, commits on blur"
            action="showcase:commit"
            saveOn="blur"
            ariaLabel="Blur-commit demo"
          />
        </Specimen>
        <Specimen caption='saveOn="enter"'>
          <ActionInput
            value="Edit and press Enter"
            action="showcase:commit"
            saveOn="enter"
            ariaLabel="Enter-commit demo"
          />
        </Specimen>
        <Specimen caption='inputType="date"'>
          <ActionInput
            value="2026-05-22"
            action="showcase:commit"
            inputType="date"
            saveOn="blur"
            ariaLabel="Date demo"
          />
        </Specimen>
        <Specimen caption='variant="multi"'>
          <ActionInput
            value="A longer, multi-line value"
            action="showcase:commit"
            variant="multi"
            saveOn="blur"
            ariaLabel="Multi-line demo"
          />
        </Specimen>
        <Specimen caption="last committed value" wide>
          <Text tone="muted">
            Last committed: <Code>{$showcaseCommitted.value}</Code>
          </Text>
        </Specimen>
      </>
    ),
  },
  {
    id: 'action-select',
    title: 'ActionSelect',
    summary: 'Single-select that commits a plain string value through the action system.',
    render: () => (
      <>
        <Specimen caption="commits via action">
          <ActionSelect
            label="Priority"
            value="medium"
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
            action="showcase:commit"
          />
        </Specimen>
        <Specimen caption="disabled — renders as static text">
          <ActionSelect
            label="Priority"
            value="high"
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
            action="showcase:commit"
            disabled
          />
        </Specimen>
      </>
    ),
  },
  {
    id: 'action-form',
    title: 'ActionForm',
    summary: 'Wraps a native form with the action pattern — submit dispatches the form handler.',
    render: () => (
      <Specimen caption="form with TextInput fields + a submit Button" wide>
        <ActionForm form={showcaseForm} aria-label="Showcase demo form">
          <Layout gap="var(--polly-space-sm)">
            <Text as="label" size="sm" tone="muted" htmlFor="showcase-form-name">
              Full name
            </Text>
            <TextInput id="showcase-form-name" name="fullName" placeholder="Ada Lovelace" />
            <Text as="label" size="sm" tone="muted" htmlFor="showcase-form-email">
              Email
            </Text>
            <TextInput id="showcase-form-email" name="email" placeholder="ada@example.com" />
            <Button type="submit" tier="primary" color="info" label="Submit" />
          </Layout>
        </ActionForm>
      </Specimen>
    ),
  },
  {
    id: 'modal',
    title: 'Modal',
    summary: 'Compound dialog — focus trap, Escape handling, portal, scroll lock.',
    render: () => (
      <Specimen caption="opens a portalled dialog">
        <Button
          tier="primary"
          data-action="showcase:modal-open"
          label="Open modal"
        />
        <Modal.Root
          when={$showcaseModalOpen}
          onClose={() => {
            $showcaseModalOpen.value = false;
          }}
          aria-label="title"
        >
          <Modal.Backdrop />
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>Modal title</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Text>
                Focus is trapped inside the dialog, Escape closes it, the backdrop
                click closes it, and the body scroll is locked while it is open.
              </Text>
            </Modal.Body>
            <Modal.Footer>
              <Modal.Close>
                <Button tier="primary" label="Done" />
              </Modal.Close>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </Specimen>
    ),
  },
  {
    id: 'confirm-dialog',
    title: 'ConfirmDialog',
    summary: 'Promise-returning confirmation. confirm() resolves true or false.',
    render: () => (
      <>
        <Specimen caption="confirm() — standard">
          <Button tier="secondary" data-action="showcase:confirm" label="Confirm an action" />
        </Specimen>
        <Specimen caption="confirm({ danger: true })">
          <Button
            tier="secondary"
            color="danger"
            data-action="showcase:confirm"
            data-action-danger="true"
            label="Confirm a deletion"
          />
        </Specimen>
      </>
    ),
  },
  {
    id: 'toast',
    title: 'Toast',
    summary: 'Renders the global errorState signal. Severity sets the aria-live politeness.',
    render: () => (
      <Specimen caption="push a toast at each severity" wide>
        <Cluster gap="var(--polly-space-sm)">
          <Button
            tier="secondary"
            color="info"
            data-action="showcase:toast"
            data-action-severity="info"
            label="Info toast"
          />
          <Button
            tier="secondary"
            color="warning"
            data-action="showcase:toast"
            data-action-severity="warning"
            label="Warning toast"
          />
          <Button
            tier="secondary"
            color="danger"
            data-action="showcase:toast"
            data-action-severity="error"
            label="Error toast"
          />
        </Cluster>
      </Specimen>
    ),
  },
];
