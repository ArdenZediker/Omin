import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatInput from "./ChatInput";
import type { KnowledgeCollection } from "../chat/knowledgeTypes";
import { BUILTIN_SESSION_STATE_KEY } from "../chat/builtinCommandState";
import { modelRegistry } from "../adapters/registry";
import type { ExpertTeam } from "../plugins/expertTeams";

const knowledgeCollections: KnowledgeCollection[] = [
  {
    id: "collection-product",
    name: "产品知识库",
    description: "产品说明与使用规范",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "collection-contract",
    name: "合同知识库",
    description: "合同模板与审阅规则",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

function renderChatInput(
  onSend = vi.fn(),
  experts: Parameters<typeof ChatInput>[0]["experts"] = [],
  currentModel?: string,
) {
  render(
    <ChatInput
      knowledgeCollections={knowledgeCollections}
      experts={experts}
      currentModel={currentModel}
      onSend={onSend}
      isLoading={false}
      onStop={vi.fn()}
    />
  );
  return onSend;
}

describe("ChatInput", () => {
  beforeEach(() => {
    localStorage.removeItem(BUILTIN_SESSION_STATE_KEY);
  });

  it("点击编辑区右侧空白时仍然聚焦输入框", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");
    const editor = textarea.closest(".chat-composer__editor-wrap");

    expect(editor).not.toBeNull();
    expect(textarea).not.toHaveFocus();
    fireEvent.pointerDown(editor!);
    expect(textarea).toHaveFocus();
  });

  it("首次显示输入区时权限和模型卡片保持关闭", () => {
    renderChatInput(vi.fn(), [], "gpt-4o");

    expect(screen.queryByText("权限控制")).not.toBeInTheDocument();
    expect(document.querySelector(".model-selector__dropdown")).not.toBeInTheDocument();
  });

  it("输入 / 时先显示 DSH 式添加与指令，再显示工具与技能", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: {
        value: "/",
        selectionStart: 1,
      },
    });

    expect(screen.getByRole("listbox", { name: "斜杠命令" })).toBeInTheDocument();
    expect(screen.getByText("添加")).toBeInTheDocument();
    expect(screen.getByText("指令")).toBeInTheDocument();
    expect(screen.getByText("工具")).toBeInTheDocument();
    expect(screen.getByText("技能")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\/目标/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\/压缩/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /\/feedback/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /\/export(?!_)/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\/read_file/ })).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options.every((option) => option.querySelector(".chat-composer__suggestion-command-icon"))).toBe(true);

    const duplicateToolName = screen.getByRole("option", { name: /\/search_sessions/ });
    expect(duplicateToolName.querySelector(".chat-composer__suggestion-title")).not.toBeInTheDocument();

    const distinctSkillTitle = screen.getByRole("option", { name: /\/code-review/ });
    expect(distinctSkillTitle.querySelector(".chat-composer__suggestion-title")).toHaveTextContent("代码审查");
  });

  it("六个内置命令在斜杠菜单中显示中文命令名", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: { value: "/", selectionStart: 1 },
    });

    const builtins = [
      ["文件", "/file"],
      ["目标", "/goal"],
      ["计划", "/plan"],
      ["压缩", "/compact"],
      ["权限", "/permission"],
      ["模型", "/model"],
    ];

    for (const [title, command] of builtins) {
      const option = screen.getByRole("option", { name: new RegExp(`/${title}`) });
      expect(option).not.toHaveTextContent(command);
    }
  });

  it("选择中文指令后输入框使用同一中文命令", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: { value: "/", selectionStart: 1 },
    });
    fireEvent.click(screen.getByRole("option", { name: /\/目标/ }));

    expect(textarea).toHaveValue("/目标 ");
  });

  it("输入命令参数和输入法组词时保持命令颜色装饰", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: { value: "/goal ni'hao", selectionStart: 12 },
    });
    fireEvent.compositionStart(textarea);

    expect(textarea).toHaveClass("chat-composer__textarea--command-active");
    expect(document.querySelector(".chat-composer__command-highlight")).toHaveTextContent("/goal");

    fireEvent.compositionEnd(textarea);

    expect(textarea).toHaveClass("chat-composer__textarea--command-active");
    expect(document.querySelector(".chat-composer__command-highlight")).toHaveTextContent("/goal");
  });

  it("计划指令立即切换会话级计划模式，并在后续请求注入计划约束", async () => {
    const onSend = renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, { target: { value: "/pl", selectionStart: 3 } });
    fireEvent.click(screen.getByRole("option", { name: /\/计划/ }));

    expect(screen.getByTitle("退出计划模式")).toHaveTextContent("计划模式");
    expect(textarea).toHaveValue("");

    fireEvent.change(textarea, { target: { value: "先给实施方案", selectionStart: 6 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith(
      "先给实施方案",
      undefined,
      expect.objectContaining({
        hiddenContext: expect.stringContaining("【计划模式】"),
      }),
    );
  });

  it("直接输入 DSH 式中文命令别名也能执行", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, { target: { value: "/计划", selectionStart: 3 } });
    expect(document.querySelector(".chat-composer__command-highlight")).toHaveTextContent("/计划");

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(screen.getByTitle("退出计划模式")).toHaveTextContent("计划模式");
    expect(textarea).toHaveValue("");
  });

  it("权限指令直接打开现有权限面板", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, { target: { value: "/per", selectionStart: 4 } });
    fireEvent.click(screen.getByRole("option", { name: /\/权限/ }));

    expect(screen.getByText("权限控制")).toBeInTheDocument();
    expect(textarea).toHaveValue("");
  });

  it("压缩指令会调用真实压缩流程并替换当前会话消息", async () => {
    vi.spyOn(modelRegistry, "chat").mockResolvedValue({
      content: "较早的讨论已经完成，当前只保留最近问题继续推进。",
      model: "test-model",
    } as Awaited<ReturnType<typeof modelRegistry.chat>>);
    const onReplaceSessionMessages = vi.fn();
    render(
      <ChatInput
        sessionId="session-compact"
        currentModel="test-model"
        messages={[
          { role: "system", content: "system" },
          { role: "user", content: "较早需求" },
          { role: "assistant", content: "较早答复" },
          { role: "user", content: "最近问题" },
        ]}
        onReplaceSessionMessages={onReplaceSessionMessages}
        onSend={vi.fn()}
        isLoading={false}
        onStop={vi.fn()}
      />
    );
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, { target: { value: "/comp", selectionStart: 5 } });
    fireEvent.click(screen.getByRole("option", { name: /\/压缩/ }));

    await waitFor(() => expect(onReplaceSessionMessages).toHaveBeenCalledOnce());
    expect(onReplaceSessionMessages.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: expect.stringContaining("【历史对话摘要】") }),
        expect.objectContaining({ role: "user", content: "最近问题" }),
      ]),
    );
  });

  it("目标指令持久化目标，并且不把命令本身发给模型", async () => {
    const onSend = renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: { value: "/goal 完成企业版发布", selectionStart: 19 },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(textarea).toHaveValue(""));
    expect(screen.getByText(/目标: 完成企业版发布/)).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "下一步做什么", selectionStart: 6 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith(
      "下一步做什么",
      undefined,
      expect.objectContaining({
        hiddenContext: expect.stringContaining("完成企业版发布"),
      }),
    );
  });

  it("斜杠查询只保留匹配项，并可用方向键与回车选择", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: {
        value: "/rea",
        selectionStart: 4,
      },
    });
    const options = screen.getAllByRole("option");
    expect(screen.queryByRole("option", { name: /\/export_docx/ })).not.toBeInTheDocument();
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    const activeIndex = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
    expect(activeIndex).toBeGreaterThanOrEqual(0);
    const activeOption = options[activeIndex];
    const command = activeOption.querySelector(".chat-composer__suggestion-command")?.textContent;
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(command).toBeTruthy();
    expect(textarea).toHaveValue(`${command} `);
  });

  it("输入框里的斜杠命令有独立视觉标记，普通输入不会误标", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: { value: "/rea", selectionStart: 4 },
    });
    expect(document.querySelector(".chat-composer__command-highlight")).toHaveTextContent("/rea");

    fireEvent.change(textarea, {
      target: { value: "/zzzz", selectionStart: 5 },
    });
    expect(document.querySelector(".chat-composer__command-highlight")).not.toBeInTheDocument();

    fireEvent.change(textarea, {
      target: { value: "普通文本", selectionStart: 4 },
    });
    expect(document.querySelector(".chat-composer__command-highlight")).not.toBeInTheDocument();
  });

  it("按 Escape 关闭斜杠命令菜单", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: {
        value: "/",
        selectionStart: 1,
      },
    });
    expect(screen.getByRole("listbox", { name: "斜杠命令" })).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "斜杠命令" })).not.toBeInTheDocument();
  });

  it("选择行内斜杠命令时只替换当前 token，并保留前后文", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");
    const value = "请分析 /rea 这个文件";

    fireEvent.change(textarea, {
      target: {
        value,
        selectionStart: value.indexOf("/rea") + 4,
      },
    });
    fireEvent.click(screen.getByRole("option", { name: /\/read_file/ }));

    expect(textarea).toHaveValue("请分析 /read_file 这个文件");
  });

  it("URL 和普通单词里的斜杠不会打开命令菜单", () => {
    renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: {
        value: "https://example.com",
        selectionStart: 19,
      },
    });
    expect(screen.queryByRole("listbox", { name: "斜杠命令" })).not.toBeInTheDocument();

    fireEvent.change(textarea, {
      target: {
        value: "word/rea",
        selectionStart: 8,
      },
    });
    expect(screen.queryByRole("listbox", { name: "斜杠命令" })).not.toBeInTheDocument();
  });

  it("以可执行工具命令发送时继续沿用 selectedMode 协议", () => {
    const onSend = renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: {
        value: "/read_file src/App.tsx",
        selectionStart: 23,
      },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith(
      "/read_file src/App.tsx",
      undefined,
      expect.objectContaining({
        selectedMode: expect.objectContaining({
          kind: "tool",
          command: "/read_file",
        }),
      }),
    );
  });

  it("生成过程中可以通过回车追加，主按钮只保留停止入口", async () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        onSend={onSend}
        isLoading
        onStop={vi.fn()}
      />
    );
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    expect(textarea).toBeEnabled();
    fireEvent.change(textarea, { target: { value: "补充一点背景" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        "补充一点背景",
        undefined,
        expect.objectContaining({ attachments: undefined }),
      );
    });
    expect(textarea).toHaveValue("");
    expect(screen.getByText("已追加: 补充一点背景")).toBeInTheDocument();
    expect(screen.queryByTitle("追加到当前回答")).not.toBeInTheDocument();
    expect(screen.getByTitle("停止生成")).toBeInTheDocument();
  });

  it("追加失败时保留草稿且不显示已追加状态", async () => {
    const onSend = vi.fn(async () => {
      throw new Error("追加失败");
    });
    render(
      <ChatInput
        onSend={onSend}
        isLoading
        onStop={vi.fn()}
      />
    );
    const textarea = screen.getByPlaceholderText("输入聊天内容...");
    fireEvent.change(textarea, { target: { value: "这条不能丢" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(textarea).toHaveValue("这条不能丢");
    expect(screen.queryByText("已追加: 这条不能丢")).not.toBeInTheDocument();
  });

  it("selects a knowledge collection with @ and sends the collection id without the mention text", () => {
    const onSend = renderChatInput();
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: {
        value: "帮我查一下 @产品",
        selectionStart: 10,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /@ 产品知识库/ }));
    expect(screen.getByTitle("取消本次知识库选择").parentElement).toHaveClass("chat-composer__status");
    const status = screen.getByTitle("取消本次知识库选择").parentElement!;
    const editor = screen.getByPlaceholderText("输入聊天内容...").parentElement!.parentElement!;
    expect(status.parentElement).toBe(editor);
    expect(editor.querySelector("textarea")).toBe(screen.getByPlaceholderText("输入聊天内容..."));
    fireEvent.change(textarea, {
      target: {
        value: "帮我查一下 定价策略",
        selectionStart: 10,
      },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("帮我查一下 定价策略", undefined, {
      hiddenContext: undefined,
      knowledgeCollectionId: "collection-product",
      knowledgeCollectionName: "产品知识库",
      expertId: null,
      expertName: null,
      selectedMode: null,
      attachments: undefined,
    });
  });

  it("allows choosing the knowledge collection directly from the composer toolbar", () => {
    renderChatInput();

    fireEvent.click(screen.getByRole("button", { name: "选择知识库" }));
    fireEvent.click(screen.getByRole("button", { name: /产品知识库/ }));

    expect(screen.getByTitle("取消本次知识库选择")).toHaveTextContent("@ 产品知识库");
  });

  it("从输入框召唤专家时交给宿主新建绑定会话", () => {
    const onSummonExpert = vi.fn();
    const expert = {
      id: "review-expert",
      name: "评审专家",
      description: "评审交付物",
      version: "1.0.0",
      kind: "expert" as const,
      templatePrompt: "你是评审专家",
    };
    render(
      <ChatInput
        experts={[expert]}
        onSummonExpert={onSummonExpert}
        onSend={vi.fn()}
        isLoading={false}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "召唤专家" }));
    expect(screen.queryByText("默认助手")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /评审专家/ }));

    expect(onSummonExpert).toHaveBeenCalledWith(expert);
  });

  it("selects an expert team for the current turn and includes it in send options", () => {
    const onSend = vi.fn();
    const team: ExpertTeam = {
      id: "release-review",
      name: "发布评审团",
      description: "审查上线风险",
      members: [{ id: "reviewer", expertId: "code-review", name: "代码评审", role: "检查回归" }],
      createdAt: 1,
      updatedAt: 1,
    };
    render(<ChatInput expertTeams={[team]} onSend={onSend} isLoading={false} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "选择专家团" }));
    fireEvent.click(screen.getByRole("button", { name: /发布评审团/ }));
    expect(screen.getByTitle("取消本次专家团")).toHaveTextContent("专家团: 发布评审团");

    const textarea = screen.getByPlaceholderText("输入聊天内容...");
    fireEvent.change(textarea, { target: { value: "检查这个版本" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("检查这个版本", undefined, expect.objectContaining({
      expertTeamId: team.id,
      expertTeamName: team.name,
    }));
  });

  it("selects an expert with @ and sends the expert id for role switch", () => {
    const onSend = renderChatInput(vi.fn(), [
      {
        id: "writer-expert",
        name: "写作专家",
        description: "擅长产出文稿",
        version: "1.0.0",
        kind: "expert",
        templatePrompt: "你是写作专家",
      },
    ]);
    const textarea = screen.getByPlaceholderText("输入聊天内容...");

    fireEvent.change(textarea, {
      target: {
        value: "帮我 @写",
        selectionStart: 6,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /@ 写作专家/ }));
    fireEvent.change(textarea, {
      target: {
        value: "帮我润色这段话",
        selectionStart: 7,
      },
    });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("帮我润色这段话", undefined, {
      hiddenContext: undefined,
      knowledgeCollectionId: null,
      knowledgeCollectionName: null,
      expertId: "writer-expert",
      expertName: "写作专家",
      selectedMode: null,
      attachments: undefined,
    });
  });
});
