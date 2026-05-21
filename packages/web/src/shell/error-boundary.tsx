import { Component, type ComponentChild, type ComponentChildren } from 'preact';
import { Button, Layout, Surface, Text } from '@fairfox/polly/ui';

interface ErrorBoundaryProps {
  /** Shown once a render error is caught, in place of `children`. */
  fallback: ComponentChildren;
  children: ComponentChildren;
}

interface ErrorBoundaryState {
  failed: boolean;
}

/**
 * Catches render-time errors in its subtree and shows `fallback` in place of
 * the blank screen Preact would otherwise leave behind.
 *
 * Preact has no hook for this — a class component with `componentDidCatch` is
 * the one sanctioned way, so the project's no-hooks, signals-first style does
 * not apply here.
 *
 * Scope: this catches errors thrown during render and lifecycle only — never
 * async or event-handler failures. Those surface through the action layer
 * (e.g. `$tasksError`); an error boundary complements that layer, it does not
 * replace it.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  override componentDidCatch(error: unknown): void {
    console.error('eal: a render error was caught by an error boundary', error);
    this.setState({ failed: true });
  }

  override render(): ComponentChild {
    return <>{this.state.failed ? this.props.fallback : this.props.children}</>;
  }
}

/**
 * Fallback for the boundary around the mounted app (the shell's `<Body>`). It
 * renders inside the shell chrome — the top bar and nav still work — so a
 * crashed app is an isolated dead end the user steps back out of.
 */
export function AppErrorFallback() {
  return (
    <Surface variant="raised" padding="var(--polly-space-xl)" data-app-error-page>
      <Layout gap="var(--polly-space-lg)">
        <Layout gap="var(--polly-space-xs)">
          <h2>This page hit an error</h2>
          <Text tone="muted">
            Something here failed to render. The rest of eal is unaffected — head back and
            pick up where you left off.
          </Text>
        </Layout>
        <Button
          tier="primary"
          color="info"
          data-action="shell:navigate"
          data-action-path="/"
          label="Back to home"
        />
      </Layout>
    </Surface>
  );
}

/**
 * Fallback for the outermost boundary around the whole app. The shell itself
 * has failed, so there is no chrome to lean on and in-app routing cannot be
 * trusted — recovery is a real navigation to `/`, i.e. a full reload.
 */
export function FatalErrorFallback() {
  return (
    <Surface variant="raised" padding="var(--polly-space-xl)" data-fatal-error-page>
      <Layout gap="var(--polly-space-lg)">
        <Layout gap="var(--polly-space-xs)">
          <h2>Something went wrong</h2>
          <Text tone="muted">
            eal hit an unexpected error and can't continue. Reloading the page usually
            clears it.
          </Text>
        </Layout>
        <Button tier="primary" color="info" href="/" label="Reload eal" />
      </Layout>
    </Surface>
  );
}
