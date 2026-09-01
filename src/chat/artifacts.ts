// Omni - 产物（Artifact）模型与持久化
// 产物 = AI 执行过程中生成的可交付内容（Office 文件、网页抓取、技能安装等），
// 在会话内以卡片展示，并进入右侧「产物」聚合抽屉，可打开/定位来源会话。

import { readSqliteBackedJson, saveSqliteBackedValue } from "../app/sqliteStorage";

export type ArtifactType = "docx" | "xlsx" | "pptx" | "web" | "skill" | "image" | "code" | "text" | "file";

export interface Artifact {
  id: string;
  projectId: string;
  sessionId: string | null;
  type: ArtifactType;
  title: string;
  /** 本地文件路径（可打开）；文本类产物为 null */
  path: string | null;
  /** 文本类产物的内容（抓取正文 / 搜索结果），截断存储 */
  content: string | null;
  /** 文件大小（字节） */
  size: number | null;
  createdAt: number;
}

/** 工具执行成功后上报的产物描述（execute 返回值携带） */
export interface ArtifactSpec {
  type: ArtifactType;
  title: string;
  path?: string | null;
  content?: string | null;
  size?: number | null;
}

const ARTIFACTS_KEY = "omni_artifacts_v1";
const MAX_ARTIFACTS = 500;
const MAX_ARTIFACT_CONTENT = 20000;

export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  docx: "文档",
  xlsx: "表格",
  pptx: "演示",
  web: "网页",
  skill: "技能",
  image: "图片",
  code: "代码",
  text: "文本",
  file: "文件",
};

export function loadArtifacts(): Artifact[] {
  try {
    const list = readSqliteBackedJson<Artifact[]>(ARTIFACTS_KEY, []);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveArtifacts(list: Artifact[]): void {
  // 约定新在前；按 createdAt 降序防御性排序后截断，保留最新 MAX_ARTIFACTS 条
  const trimmed = [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ARTIFACTS);
  try {
    saveSqliteBackedValue(ARTIFACTS_KEY, JSON.stringify(trimmed));
  } catch {
    // 持久化失败不阻断主流程
  }
}

export function appendArtifact(spec: ArtifactSpec & { projectId: string; sessionId?: string | null }): Artifact {
  const artifact: Artifact = {
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: spec.projectId,
    sessionId: spec.sessionId ?? null,
    type: spec.type,
    title: spec.title,
    path: spec.path ?? null,
    content: typeof spec.content === "string" ? spec.content.slice(0, MAX_ARTIFACT_CONTENT) : null,
    size: spec.size ?? null,
    createdAt: Date.now(),
  };
  const list = loadArtifacts();
  list.unshift(artifact);
  saveArtifacts(list);
  return artifact;
}

export function artifactsForProject(projectId: string): Artifact[] {
  return loadArtifacts().filter((a) => a.projectId === projectId);
}

export function removeArtifact(id: string): void {
  saveArtifacts(loadArtifacts().filter((a) => a.id !== id));
}

export function clearProjectArtifacts(projectId: string): void {
  saveArtifacts(loadArtifacts().filter((a) => a.projectId !== projectId));
}

/** 产物变更事件：工具执行落库后派发，聚合抽屉监听刷新 */
export const ARTIFACTS_CHANGED_EVENT = "omni:artifacts-changed";

export function notifyArtifactsChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED_EVENT));
  } catch {
    // 非浏览器环境忽略
  }
}
