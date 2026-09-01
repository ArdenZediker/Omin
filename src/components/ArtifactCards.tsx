// 会话内产物卡片：AI 执行产出的文件/网页/技能以卡片行展示在消息下方
import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { Check, Copy, FolderOpen } from "lucide-react";
import type { Artifact } from "../chat/artifacts";
import { ARTIFACT_TYPE_LABEL } from "../chat/artifacts";
import { ArtifactTypeIcon } from "./artifacts/ArtifactIcon";

/** 用系统默认应用打开产物文件。 */
export function openArtifactPath(path: string): void {
  if (!path) return;
  void open(path).catch(() => {
    // 打开失败静默：产物路径可能已被移动/删除
  });
}

export default function ArtifactCards({ artifacts }: { artifacts: Artifact[] }) {
  if (!artifacts.length) return null;
  return (
    <div className="artifact-cards">
      {artifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} />
      ))}
    </div>
  );
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!artifact.content) return;
    void navigator.clipboard.writeText(artifact.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const canOpen = Boolean(artifact.path);
  const canCopy = Boolean(!canOpen && artifact.content);

  return (
    <div className="artifact-card" title={artifact.path ?? artifact.title}>
      <span className="artifact-card__icon">
        <ArtifactTypeIcon type={artifact.type} size={18} />
      </span>
      <span className="artifact-card__copy">
        <strong>{artifact.title}</strong>
        <span>
          {ARTIFACT_TYPE_LABEL[artifact.type]}
          {artifact.size ? ` · ${(artifact.size / 1024).toFixed(1)} KB` : ""}
        </span>
      </span>
      {canOpen ? (
        <button
          type="button"
          className="artifact-card__action"
          title="打开文件"
          aria-label="打开文件"
          onClick={() => openArtifactPath(artifact.path as string)}
        >
          <FolderOpen size={14} strokeWidth={1.9} />
        </button>
      ) : canCopy ? (
        <button
          type="button"
          className="artifact-card__action"
          title={copied ? "已复制" : "复制内容"}
          aria-label={copied ? "已复制" : "复制内容"}
          onClick={handleCopy}
        >
          {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.9} />}
        </button>
      ) : null}
    </div>
  );
}
