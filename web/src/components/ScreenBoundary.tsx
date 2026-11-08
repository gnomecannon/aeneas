import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * One screen that throws while rendering shows what broke, with the rest of the app still there. Without it
 * React unmounts the whole tree and the window goes blank (a hub answer in a shape the screen did not expect
 * did this to Status). `resetKey` is the route: going to another screen clears the error.
 */
export class ScreenBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null; key: string }> {
  state: { error: Error | null; key: string } = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[screen] ${this.props.resetKey}: ${error.message}`, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" role="alert">
        <h2>This screen could not be shown</h2>
        <p className="muted small">{this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
