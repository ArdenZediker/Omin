import { Check, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { DEFAULT_PROJECT_GROUP_LABEL } from "../mainChatViewUtils";

type ProjectGroupManagerDialogProps = {
  /** 自定义分组名列表（不含系统默认分组）。 */
  groupNames: string[];
  /** 新建分组输入框的草稿值。 */
  draft: string;
  onDraftChange: (value: string) => void;
  /** 是否处于「新建分组」输入态。 */
  createMode: boolean;
  onCreateModeChange: (value: boolean) => void;
  /** 正在重命名的分组名，null 表示无。 */
  editingGroupName: string | null;
  onEditingGroupNameChange: (value: string | null) => void;
  editingDraft: string;
  onEditingDraftChange: (value: string) => void;
  onCreateGroup: () => void;
  onRenameGroup: (groupName: string) => void;
  onDeleteGroup: (groupName: string) => void;
  onClose: () => void;
};

/**
 * 项目分组管理弹窗。
 *
 * 从 MainChatView 抽出的纯展示组件：所有状态仍由 MainChatView 持有，
 * 这里只负责渲染与回调转发，行为与拆分前保持一致。
 */
export default function ProjectGroupManagerDialog({
  groupNames,
  draft,
  onDraftChange,
  createMode,
  onCreateModeChange,
  editingGroupName,
  onEditingGroupNameChange,
  editingDraft,
  onEditingDraftChange,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onClose,
}: ProjectGroupManagerDialogProps) {
  return (
    <div className="omni-confirm-overlay" onClick={onClose}>
      <div
        className="omni-confirm-dialog chat-history-panel__group-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="chat-history-panel__group-dialog-header">
          <div className="chat-history-panel__group-dialog-title">分组管理</div>
          <button
            type="button"
            className="chat-history-panel__group-dialog-close"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="chat-history-panel__group-dialog-body">
          <div className="chat-history-panel__group-manager-list">
            <div className="chat-history-panel__group-manager-item chat-history-panel__group-manager-item--default">
              <div className="chat-history-panel__group-manager-row">
                <span className="chat-history-panel__group-manager-handle" aria-hidden="true">
                  <GripVertical size={14} strokeWidth={1.9} />
                </span>
                <span>{DEFAULT_PROJECT_GROUP_LABEL}</span>
              </div>
              <span className="chat-history-panel__group-manager-badge">系统</span>
            </div>
            {groupNames.length === 0 ? (
              <div className="chat-history-panel__group-manager-empty">还没有自定义分组</div>
            ) : (
              groupNames.map((groupName) => (
                <div key={groupName} className="chat-history-panel__group-manager-item">
                  {editingGroupName === groupName ? (
                    <>
                      <div className="chat-history-panel__group-manager-row">
                        <span className="chat-history-panel__group-manager-handle" aria-hidden="true">
                          <GripVertical size={14} strokeWidth={1.9} />
                        </span>
                        <input
                          className="chat-history-panel__group-manager-inline-input"
                          value={editingDraft}
                          onChange={(event) => onEditingDraftChange(event.target.value)}
                          onBlur={() => onRenameGroup(groupName)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              onRenameGroup(groupName);
                            }
                          }}
                          autoFocus
                        />
                      </div>
                      <div className="chat-history-panel__group-manager-actions">
                        <button type="button" onClick={() => onRenameGroup(groupName)}>
                          <Check size={14} strokeWidth={2} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="chat-history-panel__group-manager-row">
                        <span className="chat-history-panel__group-manager-handle" aria-hidden="true">
                          <GripVertical size={14} strokeWidth={1.9} />
                        </span>
                        <span>{groupName}</span>
                      </div>
                      <div className="chat-history-panel__group-manager-actions">
                        <button
                          type="button"
                          onClick={() => {
                            onEditingGroupNameChange(groupName);
                            onEditingDraftChange(groupName);
                          }}
                        >
                          <Pencil size={14} strokeWidth={1.9} />
                        </button>
                        <button type="button" onClick={() => onDeleteGroup(groupName)}>
                          <Trash2 size={14} strokeWidth={1.9} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
        <div className="chat-history-panel__group-dialog-footer">
          {createMode ? (
            <div className="chat-history-panel__group-create chat-history-panel__group-create--dialog">
              <input
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                placeholder="添加新分组"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onCreateGroup();
                    onCreateModeChange(false);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  onCreateGroup();
                  onCreateModeChange(false);
                }}
              >
                <Check size={14} strokeWidth={2} />
                <span>确认添加</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="chat-history-panel__group-add-button"
              onClick={() => onCreateModeChange(true)}
            >
              <Plus size={14} strokeWidth={1.9} />
              <span>添加新分组</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
