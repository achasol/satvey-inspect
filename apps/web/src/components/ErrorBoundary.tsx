import { Component, type ReactNode } from 'react';
import { Button } from './ui';

/** Browser drafts remain in IndexedDB when a rendering error requires a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main lang="nl" style={{ maxWidth: 640, margin: '10vh auto', padding: 24 }}>
          <h1>Satvey kon dit scherm niet openen</h1>
          <p role="alert">
            Laad de toepassing opnieuw. Opgeslagen lokale concepten blijven bewaard.
          </p>
          <Button onClick={() => window.location.reload()}>Opnieuw laden</Button>
        </main>
      );
    return this.props.children;
  }
}
