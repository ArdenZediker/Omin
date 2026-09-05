// Omni - 产物（Artifact）模型与持久化
// 产物 = AI 执行过程中生成的可交付内容（Office 文件、网页抓取、技能安装等），
// 在会话内以卡片展示，并进入右侧「产物」聚合抽屉，可打开/定位来源会话。

import { readSqliteBackedJson, saveSqliteBackedValue } from "../app/sqliteStorage";

export type ArtifactType = "docx" | "xlsx" | "pptx" | "web" | "skill" | "expert" | "image" | "code" | "text" | "file";

/** 未绑定项目会话的产物统一归属 key */
export const NO_PROJECT_ARTIFACT_KEY = "__no_project__";

export interface Artifact {
  id: string;
  projectId: string;
  sessionId: string | null;
  type: ArtifactType;
  title: string;
  /** 本地文件路径（可打开）；文本类产物为 null */
  path: string | null;
  /** 外部 URL（网页/搜索类产物可点击打开） */
  url: string | null;
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
  url?: string | null;
  content?: string | null;
  size?: number | null;
}

export const ARTIFACTS_KEY = "omni_artifacts_v1";
export const ARTIFACT_PANEL_STATE_KEY = "omni_artifact_panel_state_v1";
const MAX_ARTIFACTS = 500;
const MAX_ARTIFACT_CONTENT = 20000;

export interface ArtifactPanelState {
  activeTabId: "overview" | string;
  openArtifactIds: string[];
}

const DEFAULT_ARTIFACT_PANEL_STATE: ArtifactPanelState = {
  activeTabId: "overview",
  openArtifactIds: [],
};

export function loadArtifactPanelState(): ArtifactPanelState {
  const state = readSqliteBackedJson<ArtifactPanelState>(ARTIFACT_PANEL_STATE_KEY, DEFAULT_ARTIFACT_PANEL_STATE);
  return {
    activeTabId: typeof state.activeTabId === "string" ? state.activeTabId : "overview",
    openArtifactIds: Array.isArray(state.openArtifactIds) ? state.openArtifactIds : [],
  };
}

export function saveArtifactPanelState(state: ArtifactPanelState): void {
  saveSqliteBackedValue(ARTIFACT_PANEL_STATE_KEY, JSON.stringify(state));
}

export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  docx: "文档",
  xlsx: "表格",
  pptx: "演示",
  web: "网页",
  skill: "技能",
  expert: "专家",
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
    url: spec.url ?? null,
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

/**
 * 按「项目 + 会话」双重维度过滤产物。
 * 项目为空时回退到 NO_PROJECT_ARTIFACT_KEY；sessionId 为空时返回空数组（避免全量泄露）。
 */
export function artifactsForSession(
  projectId: string | null | undefined,
  sessionId: string | null | undefined
): Artifact[] {
  if (!sessionId) return [];
  const effectiveProjectId = projectId || NO_PROJECT_ARTIFACT_KEY;
  return loadArtifacts().filter(
    (a) => a.projectId === effectiveProjectId && a.sessionId === sessionId
  );
}

export function removeArtifact(id: string): void {
  saveArtifacts(loadArtifacts().filter((a) => a.id !== id));
}

export function clearProjectArtifacts(projectId: string): void {
  saveArtifacts(loadArtifacts().filter((a) => a.projectId !== projectId));
}

/** 清空指定项目/会话下的全部产物 */
export function clearSessionArtifacts(
  projectId: string | null | undefined,
  sessionId: string | null | undefined
): void {
  if (!sessionId) return;
  const effectiveProjectId = projectId || NO_PROJECT_ARTIFACT_KEY;
  saveArtifacts(
    loadArtifacts().filter(
      (a) => !(a.projectId === effectiveProjectId && a.sessionId === sessionId)
    )
  );
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

/** 跨组件请求：在右侧「产物」面板中以标签页打开指定产物 */
export const OPEN_ARTIFACT_EVENT = "omni:open-artifact";

let pendingOpenArtifactId: string | null = null;
/** 与 pendingOpenArtifactId 配对的行号定位（可空）；消费 id 时一并消费 */
let pendingOpenArtifactLine: number | null = null;

export function requestOpenArtifactInPanel(artifactId: string, line?: number): void {
  pendingOpenArtifactId = artifactId;
  pendingOpenArtifactLine = typeof line === "number" && Number.isFinite(line) && line >= 1 ? line : null;
  try {
    window.dispatchEvent(new CustomEvent(OPEN_ARTIFACT_EVENT, { detail: { artifactId, line: pendingOpenArtifactLine } }));
  } catch {
    // 非浏览器环境忽略
  }
}

/** 在产物面板挂载时消费待打开的产物 id（一次有效） */
export function consumePendingOpenArtifactId(): string | null {
  const id = pendingOpenArtifactId;
  pendingOpenArtifactId = null;
  return id;
}

/** 与 consumePendingOpenArtifactId 成对调用：取出本次打开请求携带的行号定位（一次有效） */
export function consumePendingOpenArtifactLine(): number | null {
  const line = pendingOpenArtifactLine;
  pendingOpenArtifactLine = null;
  return line;
}

/**
 * 把工作区文件登记为「文件」产物（按绝对路径去重）并在右侧产物面板打开，
 * 可携带行号定位（配合 /search_files 命中行点击跳转）。
 */
export function openWorkspaceFileInArtifacts(opts: {
  path: string;
  line?: number;
  projectId: string;
  sessionId?: string | null;
}): Artifact {
  const existing = loadArtifacts().find((a) => a.type === "file" && a.path === opts.path);
  const artifact = existing ?? appendArtifact({
    type: "file",
    title: opts.path.split(/[\\/]/).pop() || opts.path,
    path: opts.path,
    projectId: opts.projectId,
    sessionId: opts.sessionId ?? null,
  });
  requestOpenArtifactInPanel(artifact.id, opts.line);
  return artifact;
}
