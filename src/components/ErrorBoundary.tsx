import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义降级界面；不传则使用内置的通用错误卡片。 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 全局错误边界：捕获子树渲染期抛出的异常，避免单点崩溃直接白屏整个应用。
 * 注意：错误边界无法捕获事件回调、异步任务（Promise/setTimeout）中的错误，
 * 那些仍需要调用方自行 try/catch。本组件只兜住 React 渲染阶段。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Omni] 渲染期未捕获异常：", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    return (
      <div className="omni-error-boundary">
        <div className="omni-error-boundary__card">
          <h2 className="omni-error-boundary__title">界面出错了</h2>
          <p className="omni-error-boundary__hint">
            渲染时发生未预期的错误。你可以尝试恢复，或重启应用。
          </p>
          <pre className="omni-error-boundary__detail">{error.message}</pre>
          <div className="omni-error-boundary__actions">
            <button className="omni-error-boundary__button" type="button" onClick={this.reset}>
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
