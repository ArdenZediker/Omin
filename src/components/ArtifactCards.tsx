// 会话内产物卡片：AI 执行产出的文件/网页/技能以卡片行展示在消息下方
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-shell";
import { Check, Copy, FolderOpen, FolderSearch, TriangleAlert } from "lucide-react";
import type { Artifact } from "../chat/artifacts";
import { ARTIFACT_TYPE_LABEL } from "../chat/artifacts";
import { ArtifactTypeIcon } from "./artifacts/ArtifactIcon";

/** 校验产物路径在本机是否真实存在（虚拟路径/文件已删除 → false）。 */
export async function checkArtifactPath(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    return await invoke<boolean>("path_exists", { path });
  } catch {
    return false;
  }
}

/** 用系统默认应用打开产物文件；返回是否成功（失败不再静默）。 */
export async function openArtifactPath(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    await open(path);
    return true;
  } catch {
    return false;
  }
}

/** 在系统文件管理器中显示产物所在位置；返回是否成功。 */
export async function revealArtifactPath(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    await revealItemInDir(path);
    return true;
  } catch {
    return false;
  }
}

type PathState = "checking" | "exists" | "missing";

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
  const [pathState, setPathState] = useState<PathState>("checking");
  const [actionError, setActionError] = useState<string | null>(null);

  const path = artifact.path;
  const isFile = Boolean(path);
  const canCopy = Boolean(!isFile && artifact.content);

  // 挂载时校验产物路径是否真实存在；不存在则禁用打开并给出可见提示
  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setPathState("missing");
      return;
    }
    void checkArtifactPath(path).then((exists) => {
      if (!cancelled) setPathState(exists ? "exists" : "missing");
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const handleOpen = useCallback(async () => {
    setActionError(null);
    if (!path) return;
    if (pathState !== "exists") {
      setActionError("文件不存在：可能是虚拟路径或已被移动/删除");
      return;
    }
    const ok = await openArtifactPath(path);
    if (!ok) setActionError("打开失败：系统无法用默认应用打开该文件");
  }, [path, pathState]);

  const handleReveal = useCallback(async () => {
    setActionError(null);
    if (!path) return;
    if (pathState !== "exists") {
      setActionError("文件不存在：可能是虚拟路径或已被移动/删除");
      return;
    }
    const ok = await revealArtifactPath(path);
    if (!ok) setActionError("定位失败：文件可能已被移动或删除");
  }, [path, pathState]);

  const handleCopy = () => {
    if (!artifact.content) return;
    void navigator.clipboard.writeText(artifact.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div
      className={`artifact-card ${isFile && pathState === "missing" ? "artifact-card--missing" : ""}`}
      title={artifact.path ?? artifact.title}
    >
      <span className="artifact-card__icon">
        <ArtifactTypeIcon type={artifact.type} size={18} />
      </span>
      <button
        type="button"
        className="artifact-card__copy"
        title={isFile ? (pathState === "missing" ? "文件不存在" : "打开文件") : "复制内容"}
        onClick={isFile ? handleOpen : handleCopy}
        disabled={isFile && pathState === "missing"}
      >
        <strong>{artifact.title}</strong>
        <span>
          {ARTIFACT_TYPE_LABEL[artifact.type]}
          {artifact.size ? ` · ${(artifact.size / 1024).toFixed(1)} KB` : ""}
          {isFile && pathState === "missing" ? " · 文件不存在" : ""}
        </span>
      </button>
      {actionError ? (
        <span className="artifact-card__error">
          <TriangleAlert size={11} strokeWidth={2} />
          {actionError}
        </span>
      ) : null}
      {isFile ? (
        <span className="artifact-card__actions">
          <button
            type="button"
            className="artifact-card__action"
            title={pathState === "missing" ? "文件不存在" : "打开文件"}
            aria-label="打开文件"
            disabled={pathState === "missing"}
            onClick={handleOpen}
          >
            <FolderOpen size={14} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className="artifact-card__action"
            title={pathState === "missing" ? "文件不存在" : "在文件夹中显示"}
            aria-label="在文件夹中显示"
            disabled={pathState === "missing"}
            onClick={handleReveal}
          >
            <FolderSearch size={14} strokeWidth={1.9} />
          </button>
        </span>
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
