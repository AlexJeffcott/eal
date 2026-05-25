import { Button, Cluster, ConfirmDialog, Layout, Surface, Text, Toast } from '@fairfox/polly/ui';
import { $showcaseTheme } from './stores.ts';
import { THEMES } from './actions.ts';
import { SHOWCASE_SECTIONS, type ShowcaseSection } from './specimens.tsx';

/** A capitalised label for a theme option. */
function themeLabel(theme: string): string {
  return theme.charAt(0).toUpperCase() + theme.slice(1);
}

/** One catalogued component: a labelled landmark with a grid of specimens. */
function Section(props: { section: ShowcaseSection }) {
  const { section } = props;
  const headingId = `${section.id}-heading`;
  return (
    <Surface
      as="section"
      id={section.id}
      variant="plain"
      className="showcase-section"
      aria-labelledby={headingId}
    >
      <Layout gap="var(--polly-space-sm)">
        <h2 id={headingId} class="showcase-section-title">
          {section.title}
        </h2>
        <Text as="p" tone="muted">
          {section.summary}
        </Text>
        <Layout
          columns="repeat(auto-fill, minmax(min(100%, 14rem), 1fr))"
          gap="var(--polly-space-md)"
        >
          {section.render()}
        </Layout>
      </Layout>
    </Surface>
  );
}

/**
 * The component showcase — a public, web-only app that catalogues every
 * `@fairfox/polly/ui` primitive in its configurations. A single scrollable
 * page so an accessibility pass or a visual-regression run covers the whole
 * library in one sweep; an in-page nav jumps between component sections.
 *
 * `data-polly-theme` on the panel root forces light/dark for the subtree, so
 * both palettes can be inspected without changing the OS setting.
 */
export function ShowcasePanel() {
  const theme = $showcaseTheme.value;
  return (
    <Surface
      variant="raised"
      padding="clamp(var(--polly-space-sm), 3vw, var(--polly-space-xl))"
      data-showcase-panel="true"
      data-polly-theme={theme === 'system' ? undefined : theme}
    >
      <Layout gap="var(--polly-space-lg)">
        <Layout gap="var(--polly-space-sm)">
          <h1 class="showcase-title">Component showcase</h1>
          <Text as="p" tone="muted">
            Every <Text weight="medium">@fairfox/polly/ui</Text> primitive, in its
            configurations — a reference for building eal apps, and a single
            surface for accessibility and visual-regression checks.
          </Text>
        </Layout>

        <Surface variant="callout" radius="md" padding="var(--polly-space-md)">
          <Cluster gap="var(--polly-space-sm)" align="center">
            <Text size="sm" tone="muted">
              Theme
            </Text>
            {THEMES.map((t) => (
              <Button
                key={t}
                size="small"
                tier={t === theme ? 'primary' : 'tertiary'}
                data-action="showcase:set-theme"
                data-action-theme={t}
                label={themeLabel(t)}
              />
            ))}
          </Cluster>
        </Surface>

        <nav aria-label="Components">
          <Cluster gap="var(--polly-space-xs)">
            {SHOWCASE_SECTIONS.map((section) => (
              <Button
                key={section.id}
                size="small"
                tier="tertiary"
                href={`#${section.id}`}
                label={section.title}
              />
            ))}
          </Cluster>
        </nav>

        <Layout gap="var(--polly-space-xl)">
          {SHOWCASE_SECTIONS.map((section) => (
            <Section key={section.id} section={section} />
          ))}
        </Layout>
      </Layout>

      {/* Mounted once for the Toast and ConfirmDialog specimens — both portal
       *  into the shell's OverlayRoot. */}
      <Toast.Viewport />
      <ConfirmDialog.Host />
    </Surface>
  );
}
