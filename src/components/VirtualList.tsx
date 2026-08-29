import { useRef, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/**
 * 通用虚拟列表（P2-#16）：仅渲染视口附近窗口内的行，避免大对话 / 大文档列表
 * 一次性挂载上千节点导致卡顿。基于 `@tanstack/react-virtual` 实现，支持变高行
 * （内部按实际测量高度动态修正）。
 *
 * 用法：
 * ```tsx
 * <VirtualList
 *   items={messages}
 *   estimateSize={96}
 *   getKey={(m) => m.id}
 *   renderItem={(m) => <ChatMessage key={m.id} message={m} />}
 * />
 * ```
 */
export type VirtualListProps<T> = {
  items: T[];
  estimateSize?: number;
  overscan?: number;
  className?: string;
  style?: CSSProperties;
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
};

export function VirtualList<T>({
  items,
  estimateSize = 80,
  overscan = 6,
  className,
  style,
  getKey,
  renderItem,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className={className}
      style={{ overflowY: "auto", position: "relative", ...style }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index];
          return (
            <div
              key={getKey(item, virtualRow.index)}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
