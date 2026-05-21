// Browser tier — exercises the ErrorBoundary against a real Preact render.
// See ./README.md for tier scope.
import { describe, test, expect, waitFor, done } from '@fairfox/polly/test/browser';
import { render } from 'preact';
import { ErrorBoundary } from '../../src/shell/error-boundary.tsx';

/** A fresh, isolated container per test — the boundary holds state, so tests
 *  must not share an instance. */
function freshRoot(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function Healthy() {
  return <p data-healthy>all good</p>;
}

function Boom(): never {
  throw new Error('boom — a deliberate render error for the boundary test');
}

describe('ErrorBoundary', () => {
  test('renders its children when they do not throw', () => {
    const root = freshRoot();
    render(
      <ErrorBoundary fallback={<p data-fallback>fallback</p>}>
        <Healthy />
      </ErrorBoundary>,
      root,
    );
    expect(root.querySelector('[data-healthy]')).not.toBeNull();
    expect(root.querySelector('[data-fallback]')).toBeNull();
  });

  test('shows the fallback when a child throws during render', async () => {
    const root = freshRoot();
    render(
      <ErrorBoundary fallback={<p data-fallback>fallback</p>}>
        <Boom />
      </ErrorBoundary>,
      root,
    );
    await waitFor(() => root.querySelector('[data-fallback]') !== null);
    expect(root.querySelector('[data-healthy]')).toBeNull();
  });
});

done();
