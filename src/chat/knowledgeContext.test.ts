import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { embedKnowledgeText } from "./knowledgeEmbedding";
import {
  buildKnowledgeContextBlock,
  isKnowledgeContentQuery,
  isKnowledgeInventoryQuery,
} from "./knowledgeContext";
import type {
  KnowledgeLibraryPayload,
  SearchKnowledgeChunkResult,
} from "./knowledgeTypes";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./knowledgeEmbedding", () => ({
  embedKnowledgeText: vi.fn(),
}));

describe("知识库文件目录问题识别", () => {
  it("识别中文文件列表问题", () => {
    expect(isKnowledgeInventoryQuery("有什么文件")).toBe(true);
    expect(isKnowledgeInventoryQuery("新知识库里有哪些文档")).toBe(true);
    expect(isKnowledgeInventoryQuery("列出全部资料")).toBe(true);
  });

  it("不把普通知识问答误判为目录查询", () => {
    expect(isKnowledgeInventoryQuery("这个项目怎么启动")).toBe(false);
    expect(isKnowledgeInventoryQuery("解释一下这个文件的作用")).toBe(false);
  });
});

describe("知识库文档内容问题识别", () => {
  it("识别需要读取文档内容的问题", () => {
    expect(isKnowledgeContentQuery("文件写了什么")).toBe(true);
    expect(isKnowledgeContentQuery("写了些什么")).toBe(true);
    expect(isKnowledgeContentQuery("里面讲了些什么")).toBe(true);
    expect(isKnowledgeContentQuery("文档里说的是什么")).toBe(true);
    expect(isKnowledgeContentQuery("主要内容是什么")).toBe(true);
    expect(isKnowledgeContentQuery("请总结这个文档")).toBe(true);
  });

  it("不把文件名查询误判为内容查询", () => {
    expect(isKnowledgeContentQuery("有什么文件")).toBe(false);
    expect(isKnowledgeContentQuery("列出文档")).toBe(false);
    expect(isKnowledgeInventoryQuery("文件写的什么")).toBe(false);
  });
});

const collectionId = "collection-platform";
const library: KnowledgeLibraryPayload = {
  collections: [{
    id: collectionId,
    name: "新知识库",
    description: "",
    retrievalMode: "hybrid",
  }],
  documents: [{
    id: "document-platform",
    collectionId,
    sourceName: "平台数据目录申请表模板.docx",
    sourcePath: "D:/docs/平台数据目录申请表模板.docx",
    processingStatus: "searchable",
    chunkCount: 1,
    tags: [],
    favorite: false,
    accessCount: 0,
    contentPreview: "",
  }],
};

describe("知识库上下文装配", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(embedKnowledgeText).mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("“写了些什么”会直接读取所选知识库文档内容", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "load_knowledge_library_command") {
        return library;
      }
      if (command === "load_knowledge_document_command") {
        return {
          document: library.documents[0],
          chunks: [{
            id: "chunk-platform",
            documentId: "document-platform",
            chunkIndex: 0,
            title: "申请说明",
            content: "该模板用于申请新增平台数据目录，并登记数据来源、责任人和更新频率。",
            chunkType: "text",
          }],
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await buildKnowledgeContextBlock({
      model: "test-model",
      messages: [{ role: "user", content: "写了些什么" }],
      knowledgeCollectionId: collectionId,
    });

    expect(result?.block).toContain("【指定知识库文档内容】");
    expect(result?.block).toContain("平台数据目录申请表模板.docx");
    expect(result?.block).toContain("申请新增平台数据目录");
    expect(result?.sources).toHaveLength(1);
    expect(embedKnowledgeText).not.toHaveBeenCalled();
  });

  it("纯向量低分命中不会被旧的 2.4 关键词阈值误杀", async () => {
    vi.mocked(embedKnowledgeText).mockResolvedValue({
      provider: "siliconflow",
      baseUrl: "https://api.siliconflow.cn/v1",
      modelKey: "siliconflow:BAAI/bge-m3:test",
      model: "BAAI/bge-m3",
      embedding: [0.1, 0.2, 0.3],
    });
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "load_knowledge_library_command") {
        return library;
      }
      if (command === "search_knowledge_chunks_command") {
        return [{
          chunk: {
            id: "chunk-platform",
            documentId: "document-platform",
            collectionId,
            chunkIndex: 0,
            content: "该模板用于申请新增平台数据目录。",
            createdAt: 1,
          },
          score: 0.686,
          sourceName: "平台数据目录申请表模板.docx",
          sourcePath: "D:/docs/平台数据目录申请表模板.docx",
          collectionName: "新知识库",
          tags: [],
          favorite: false,
          accessCount: 0,
        }] satisfies SearchKnowledgeChunkResult[];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await buildKnowledgeContextBlock({
      model: "test-model",
      messages: [{ role: "user", content: "这份材料主要用来做什么" }],
      knowledgeCollectionId: collectionId,
    });

    expect(result?.sources).toHaveLength(1);
    expect(result?.block).toContain("该模板用于申请新增平台数据目录");
  });

  it("所选知识库无命中时明确禁止拿工作区文件替代", async () => {
    vi.mocked(embedKnowledgeText).mockResolvedValue(null);
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "load_knowledge_library_command") {
        return library;
      }
      if (command === "search_knowledge_chunks_command") {
        return [] satisfies SearchKnowledgeChunkResult[];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await buildKnowledgeContextBlock({
      model: "test-model",
      messages: [{ role: "user", content: "这份材料主要用来做什么" }],
      knowledgeCollectionId: collectionId,
    });

    expect(result?.sources).toHaveLength(0);
    expect(result?.block).toContain("没有找到达到相关度门槛的片段");
    expect(result?.block).toContain("不要改读工作区文件来替代");
  });

  it("普通问答不继承隐性知识库时不会发起全库检索", async () => {
    const result = await buildKnowledgeContextBlock({
      model: "test-model",
      messages: [{ role: "user", content: "这份材料主要用来做什么" }],
    });

    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(embedKnowledgeText).not.toHaveBeenCalled();
  });

  it("上传附件时不继承项目绑定的知识库", async () => {
    const result = await buildKnowledgeContextBlock({
      model: "test-model",
      messages: [{
        role: "user",
        content: "对比两个文件讲了些什么",
        attachments: [{
          path: "C:/attachments/a.docx",
          name: "a.docx",
          size: 1000,
        }],
      }],
      knowledgeCollectionId: collectionId,
    });

    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(embedKnowledgeText).not.toHaveBeenCalled();
  });

  it("上传附件且显式选择知识库时仍然只检索所选库", async () => {
    vi.mocked(embedKnowledgeText).mockResolvedValue(null);
    vi.mocked(invoke).mockImplementation(async (command: string, payload?: unknown) => {
      if (command === "load_knowledge_library_command") {
        return library;
      }
      if (command === "search_knowledge_chunks_command") {
        expect((payload as { input: { collectionId?: string } }).input.collectionId).toBe(collectionId);
        return [] satisfies SearchKnowledgeChunkResult[];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await buildKnowledgeContextBlock({
      model: "test-model",
      messages: [{
        role: "user",
        content: "对比两个文件讲了些什么",
        selectedKnowledgeCollection: { id: collectionId, name: "新知识库" },
        attachments: [{
          path: "C:/attachments/a.docx",
          name: "a.docx",
          size: 1000,
        }],
      }],
    });

    expect(result?.block).toContain("没有找到达到相关度门槛的片段");
    expect(result?.block).toContain("仍应单独分析附件");
  });
});
