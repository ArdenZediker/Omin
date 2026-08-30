import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

type KnowledgeBaseDetailBoundaryProps = {
  /** 返回文档列表。 */
  onBackToList: () => void;
  /** 清除错误并重新挂载详情内容。 */
  onRetry: () => void;
  children: ReactNode;
};

type KnowledgeBaseDetailBoundaryState = {
  hasError: boolean;
  errorMessage: string | null;
};

/**
 * 知识库文档详情页的局部错误边界。
 *
 * 详情页会渲染 PDF / DOCX / 图片等第三方解析结果，单个文档解析异常
 * 不应连带整个知识库视图白屏，因此在这里就地兜住并提供重试入口。
 */
export default class KnowledgeBaseDetailBoundary extends Component<
  KnowledgeBaseDetailBoundaryProps,
  KnowledgeBaseDetailBoundaryState
> {
  state: KnowledgeBaseDetailBoundaryState = {
    hasError: false,
    errorMessage: null,
  };

  static getDerivedStateFromError(error: unknown) {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : "文档详情渲染失败",
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("知识库详情页渲染失败", error, errorInfo);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <section className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] p-6">
        <div className="max-w-md space-y-4 text-center">
          <div className="text-lg font-semibold text-[var(--omni-app-text)]">文档详情渲染失败</div>
          <div className="text-sm leading-6 text-[var(--omni-app-muted)]">
            {this.state.errorMessage ?? "请返回列表后重新打开。"}
          </div>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, errorMessage: null });
                this.props.onRetry();
              }}
              className="rounded-lg border border-[var(--omni-panel-border)] bg-[var(--omni-app-bg)] px-3 py-1.5 text-sm text-[var(--omni-app-text)] hover:bg-[var(--omni-soft-bg)]"
            >
              重新打开
            </button>
            <button
              type="button"
              onClick={this.props.onBackToList}
              className="rounded-lg border border-slate-950 bg-slate-950 px-3 py-1.5 text-sm text-white hover:bg-slate-800"
            >
              返回列表
            </button>
          </div>
        </div>
      </section>
    );
  }
}
