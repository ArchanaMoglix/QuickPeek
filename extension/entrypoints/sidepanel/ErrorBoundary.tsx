import { Component, type ReactNode } from 'react';

// Panel mein koi galti (crash) ho to kaala khaali dabba nahi, ek message aur Reload button
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error('[Quick Peek] panel crashed:', error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <p className="crash-title">Something went wrong in Quick Peek.</p>
        <p className="crash-detail">{this.state.error.message}</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
