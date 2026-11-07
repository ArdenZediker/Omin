import { describe, expect, it } from "vitest";
import { isKnowledgeContentQuery, isKnowledgeInventoryQuery } from "./knowledgeContext";

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
    expect(isKnowledgeContentQuery("主要内容是什么")).toBe(true);
    expect(isKnowledgeContentQuery("请总结这个文档")).toBe(true);
  });

  it("不把文件名查询误判为内容查询", () => {
    expect(isKnowledgeContentQuery("有什么文件")).toBe(false);
    expect(isKnowledgeContentQuery("列出文档")).toBe(false);
    expect(isKnowledgeInventoryQuery("文件写的什么")).toBe(false);
  });
});
