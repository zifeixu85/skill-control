"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

export function ErrorFallback({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="gate" role="alert">
      <div className="empty error">
        <b>这一部分出了点问题</b>
        <p>{message || "显示时发生了意外错误。"}其他页面不受影响，可以重新加载这一部分再试。</p>
        <div className="empty-action">
          <button type="button" className="btn" onClick={onRetry}>
            重新加载
          </button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  children: ReactNode;
  /** Shown instead of the default fallback (e.g. nothing for an overlay). */
  quiet?: boolean;
}

interface State {
  error: Error | null;
}

/** Keeps one broken page or drawer from unmounting the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Skill Control UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.quiet) {
      return (
        <div className="drawer">
          <ErrorFallback message={this.state.error.message} onRetry={() => this.setState({ error: null })} />
        </div>
      );
    }
    return <ErrorFallback message={this.state.error.message} onRetry={() => this.setState({ error: null })} />;
  }
}
