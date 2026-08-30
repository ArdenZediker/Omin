import type { RefObject } from "react";
import { Check, Plus } from "lucide-react";
import type { Project } from "../../chat/types";
import { DEFAULT_PROJECT_GROUP_LABEL } from "../mainChatViewUtils";

type ProjectMoveGroupMenuProps = {
  /** 正在移动分组的项目 id。 */
  projectId: string;
  position: { top: number; left: number };
  containerRef: RefObject<HTMLDivElement | null>;
  projects: Project[];
  /** 自定义分组名列表（不含系统默认分组）。 */
  groupNames: string[];
  onSelectGroup: (projectId: string, groupName: string | null) => void;
  /** 选择完成或跳转分组管理前的统一收尾（关闭菜单等）。 */
  onDismiss: () => void;
  onOpenGroupManager: () => void;
};

/**
 * 项目卡片「移动到分组」的浮动菜单。
 *
 * 从 MainChatView 抽出的纯展示组件，定位与状态仍由 MainChatView 控制。
 */
export default function ProjectMoveGroupMenu({
  projectId,
  position,
  containerRef,
  projects,
  groupNames,
  onSelectGroup,
  onDismiss,
  onOpenGroupManager,
}: ProjectMoveGroupMenuProps) {
  const currentProject = projects.find((project) => project.id === projectId);
  const currentGroupName = currentProject?.groupName?.trim() || DEFAULT_PROJECT_GROUP_LABEL;

  return (
    <div
      ref={containerRef}
      className="chat-history-panel__project-submenu chat-history-panel__project-submenu--floating"
      style={{ top: position.top, left: position.left }}
      onClick={(event) => event.stopPropagation()}
    >
      {[DEFAULT_PROJECT_GROUP_LABEL, ...groupNames].map((groupName) => {
        const isActive = currentGroupName === groupName;
        return (
          <button
            key={`${projectId}-${groupName}-choice`}
            type="button"
            className={isActive ? "chat-history-panel__project-group-choice--active" : ""}
            onClick={(event) => {
              event.stopPropagation();
              onSelectGroup(
                projectId,
                groupName === DEFAULT_PROJECT_GROUP_LABEL ? null : groupName,
              );
              onDismiss();
            }}
          >
            {isActive ? (
              <Check size={13} strokeWidth={2.2} />
            ) : (
              <span
                className="chat-history-panel__project-group-choice-spacer"
                aria-hidden="true"
              />
            )}
            <span>{groupName}</span>
            <span className="chat-history-panel__project-group-choice-tail" aria-hidden="true" />
          </button>
        );
      })}
      <div className="chat-history-panel__project-dropdown-divider" />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
          onOpenGroupManager();
        }}
      >
        <span className="chat-history-panel__project-dropdown-main">
          <Plus size={13} strokeWidth={1.9} />
          <span>添加新分组</span>
        </span>
      </button>
    </div>
  );
}
