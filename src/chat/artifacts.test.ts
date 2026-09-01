import { beforeEach, describe, expect, it, vi } from "vitest";

// mock SQLite 存储为内存实现，验证产物读写/过滤/截断/上限
const memoryStore = new Map<string, string>();

vi.mock("../app/sqliteStorage", () => ({
  readSqliteBackedJson: <T>(key: string, fallback: T): T => {
    const raw = memoryStore.get(key);
    if (!raw) return fallback;
    try {
      if (Array.isArray(fallback)) return JSON.parse(raw) as T;
      return { ...(fallback as object), ...JSON.parse(raw) } as T;
    } catch {
      return fallback;
    }
  },
  saveSqliteBackedValue: (key: string, value: string) => {
    memoryStore.set(key, value);
  },
}));

import {
  ARTIFACT_TYPE_LABEL,
  appendArtifact,
  artifactsForProject,
  clearProjectArtifacts,
  loadArtifacts,
  removeArtifact,
  saveArtifacts,
} from "./artifacts";

describe("artifacts 产物模型", () => {
  beforeEach(() => {
    memoryStore.clear();
  });

  it("appendArtifact 落库并可按项目过滤", () => {
    const a = appendArtifact({ type: "docx", title: "周报.docx", path: "C:/out/周报.docx", projectId: "p1", sessionId: "s1" });
    appendArtifact({ type: "web", title: "搜索「React」", content: "结果摘要", projectId: "p2", sessionId: "s2" });

    const p1 = artifactsForProject("p1");
    expect(p1).toHaveLength(1);
    expect(p1[0].id).toBe(a.id);
    expect(p1[0].path).toBe("C:/out/周报.docx");
    expect(artifactsForProject("p2")).toHaveLength(1);
    expect(artifactsForProject("p3")).toHaveLength(0);
  });

  it("文本类产物内容截断到 20000 字符", () => {
    appendArtifact({ type: "web", title: "长文", content: "x".repeat(50000), projectId: "p1" });
    const [artifact] = artifactsForProject("p1");
    expect(artifact.content?.length).toBe(20000);
  });

  it("无 path 时字段回落为 null，size 保留", () => {
    appendArtifact({ type: "skill", title: "技能：周报", path: "~/.dsh/skills/report/SKILL.md", size: 1024, projectId: "p1" });
    const [artifact] = artifactsForProject("p1");
    expect(artifact.size).toBe(1024);
    expect(artifact.content).toBeNull();
  });

  it("removeArtifact / clearProjectArtifacts 删除", () => {
    const a = appendArtifact({ type: "docx", title: "A", projectId: "p1" });
    appendArtifact({ type: "web", title: "B", projectId: "p1" });
    removeArtifact(a.id);
    expect(artifactsForProject("p1")).toHaveLength(1);
    clearProjectArtifacts("p1");
    expect(artifactsForProject("p1")).toHaveLength(0);
  });

  it("saveArtifacts 上限 500 条", () => {
    const list = Array.from({ length: 600 }, (_, i) => ({
      id: `id-${i}`,
      projectId: "p1",
      sessionId: null,
      type: "text" as const,
      title: `t${i}`,
      path: null,
      content: null,
      size: null,
      createdAt: i,
    }));
    saveArtifacts(list);
    expect(loadArtifacts()).toHaveLength(500);
    expect(loadArtifacts()[0].id).toBe("id-599");
  });

  it("类型标签覆盖全部产物类型", () => {
    expect(Object.keys(ARTIFACT_TYPE_LABEL)).toHaveLength(9);
    expect(ARTIFACT_TYPE_LABEL.docx).toBe("文档");
    expect(ARTIFACT_TYPE_LABEL.skill).toBe("技能");
  });
});
