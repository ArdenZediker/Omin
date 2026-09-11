import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MAX_PARAM_FALLBACK_RETRIES,
  clearLearnedUnsupportedParams,
  describeSkippedParams,
  extractErrorMessage,
  forgetUnsupportedParam,
  getLearnedUnsupportedParams,
  parseUnsupportedParam,
  rememberUnsupportedParam,
  resolveUnsupportedParams,
  sendWithParamCompat,
  sentParamsOf,
} from "./paramCompat";

const STORAGE_KEY = "omni_model_param_compat_v1";

beforeEach(() => {
  vi.restoreAllMocks();
  clearLearnedUnsupportedParams();
  localStorage.removeItem(STORAGE_KEY);
});

describe("extractErrorMessage", () => {
  it("解包 `HTTP <code> - <json>` 里的 error.message", () => {
    const raw =
      'HTTP 400 - {"error":{"message":"Parameter \'temperature\' is not supported"},"type":"invalid_request_error"}';
    expect(extractErrorMessage(raw)).toBe("Parameter 'temperature' is not supported");
  });

  it("解包顶层 message（Gemini 风格）", () => {
    const raw = 'HTTP 400 - {"message":"Unknown parameter: tool_choice"}';
    expect(extractErrorMessage(raw)).toBe("Unknown parameter: tool_choice");
  });

  it("非 JSON 报文退回原文", () => {
    expect(extractErrorMessage("HTTP 500 - upstream exploded")).toBe("upstream exploded");
  });
});

describe("parseUnsupportedParam", () => {
  it("识别百炼 kimi-k3 的 temperature 报错（本次真实报文）", () => {
    const raw =
      'HTTP 400 - {"error":{"message":"<400> InternalError.Algo.InvalidParameter: Parameter \'temperature\'=0.7 is not supported for kimi-k3 model.","type":"invalid_request_error","param":null,"code":"invalid_parameter_error"},"request_id":"e8a7b76b"}';
    expect(parseUnsupportedParam(raw)).toBe("temperature");
  });

  it("识别 WIRE 名到中立槽位的映射", () => {
    expect(parseUnsupportedParam('HTTP 400 - {"error":{"message":"Parameter \'max_tokens\' is not supported"}}')).toBe("maxTokens");
    expect(parseUnsupportedParam('HTTP 400 - {"error":{"message":"Unsupported parameter: \'tool_choice\'"}}')).toBe("toolChoice");
    expect(parseUnsupportedParam('HTTP 400 - {"error":{"message":"Parameter \'reasoning_effort\' is not supported"}}')).toBe("reasoningEffort");
    expect(parseUnsupportedParam('HTTP 400 - {"error":{"message":"Parameter \'num_predict\' is not supported"}}')).toBe("maxTokens");
  });

  it("识别 Anthropic 风格的「额外字段不被允许」", () => {
    expect(parseUnsupportedParam("HTTP 400 - temperature: Extra inputs are not permitted")).toBe("temperature");
  });

  it("鉴权/额度类错误不误判为参数问题", () => {
    expect(parseUnsupportedParam('HTTP 401 - {"error":{"message":"Invalid API key provided"}}')).toBeUndefined();
    expect(parseUnsupportedParam('HTTP 429 - {"error":{"message":"Rate limit exceeded"}}')).toBeUndefined();
    expect(parseUnsupportedParam('HTTP 400 - {"error":{"message":"This model\'s maximum context length is 8192 tokens"}}')).toBeUndefined();
  });

  it("正文提到同名词但不是参数错误的，不误判", () => {
    expect(parseUnsupportedParam("HTTP 400 - {\"error\":{\"message\":\"The temperature is too high for this recipe\"}}")).toBeUndefined();
  });
});

describe("sentParamsOf", () => {
  it("覆盖 OpenAI 顶层、Ollama options、Gemini generationConfig 三种摆放", () => {
    expect([...sentParamsOf({ model: "m", temperature: 0.7, max_tokens: 10 })].sort()).toEqual(["maxTokens", "temperature"]);
    expect([...sentParamsOf({ options: { temperature: 0.7, num_predict: 10 } })].sort()).toEqual(["maxTokens", "temperature"]);
    expect([...sentParamsOf({ generationConfig: { temperature: 0.7, maxOutputTokens: 10, thinkingConfig: {} } })].sort()).toEqual([
      "maxTokens",
      "reasoningEffort",
      "temperature",
    ]);
    expect([...sentParamsOf({ toolConfig: {} })]).toEqual(["toolChoice"]);
  });
});

describe("sendWithParamCompat", () => {
  it("报错点名 temperature 时剥掉该参数重发，并记住结论", async () => {
    const bodies: Record<string, unknown>[] = [];
    let attempt = 0;
    const result = await sendWithParamCompat({
      modelId: "dashscope:kimi-k3",
      buildBody: (skip) => {
        const body: Record<string, unknown> = { model: "kimi-k3" };
        if (!skip.has("temperature")) body.temperature = 0.7;
        return body;
      },
      send: async (body) => {
        bodies.push(body);
        attempt += 1;
        if (attempt === 1) {
          throw new Error(
            'HTTP 400 - {"error":{"message":"Parameter \'temperature\'=0.7 is not supported for kimi-k3 model."}}'
          );
        }
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty("temperature");
    expect(bodies[1]).not.toHaveProperty("temperature");
    expect(getLearnedUnsupportedParams("dashscope:kimi-k3").has("temperature")).toBe(true);
  });

  it("连续两种参数被拒时各自剥掉再重发（上限内）", async () => {
    const sent: Record<string, unknown>[] = [];
    let attempt = 0;
    const result = await sendWithParamCompat({
      modelId: "multi",
      buildBody: (skip) => {
        const body: Record<string, unknown> = {};
        if (!skip.has("temperature")) body.temperature = 0.7;
        if (!skip.has("maxTokens")) body.max_tokens = 4096;
        return body;
      },
      send: async (body) => {
        sent.push(body);
        attempt += 1;
        if (attempt === 1) throw new Error('HTTP 400 - {"error":{"message":"Parameter \'temperature\' is not supported"}}');
        if (attempt === 2) throw new Error('HTTP 400 - {"error":{"message":"Parameter \'max_tokens\' is not supported"}}');
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({});
  });

  it("超过重试上限后不再重发", async () => {
    const send = vi.fn().mockImplementation(async (body: Record<string, unknown>) => {
      const param = "temperature" in body ? "temperature" : "max_tokens" in body ? "max_tokens" : "tool_choice";
      throw new Error(`HTTP 400 - {"error":{"message":"Parameter '${param}' is not supported"}}`);
    });
    await expect(
      sendWithParamCompat({
        modelId: "endless",
        buildBody: (skip) => {
          const body: Record<string, unknown> = {};
          if (!skip.has("temperature")) body.temperature = 0.7;
          if (!skip.has("maxTokens")) body.max_tokens = 4096;
          if (!skip.has("toolChoice")) body.tool_choice = "auto";
          return body;
        },
        send,
      })
    ).rejects.toThrow(/not supported/);
    expect(send).toHaveBeenCalledTimes(MAX_PARAM_FALLBACK_RETRIES + 1);
  });

  it("报文点名了我们根本没下发的参数时不重发", async () => {
    const send = vi.fn().mockRejectedValue(
      new Error('HTTP 400 - {"error":{"message":"Parameter \'temperature\' is not supported"}}')
    );
    await expect(
      sendWithParamCompat({
        modelId: "not-sent",
        buildBody: () => ({ model: "m" }),
        send,
      })
    ).rejects.toThrow(/not supported/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("已吐字后不重发（避免重复输出）", async () => {
    const send = vi.fn().mockRejectedValue(
      new Error('HTTP 400 - {"error":{"message":"Parameter \'temperature\' is not supported"}}')
    );
    await expect(
      sendWithParamCompat({
        modelId: "emitted",
        buildBody: (skip) => {
          const body: Record<string, unknown> = {};
          if (!skip.has("temperature")) body.temperature = 0.7;
          return body;
        },
        send,
        hasEmittedContent: () => true,
      })
    ).rejects.toThrow(/not supported/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("声明的能力缺口直接跳过，不发起无效请求", async () => {
    const send = vi.fn().mockResolvedValue("ok");
    const result = await sendWithParamCompat({
      modelId: "declared",
      declared: ["temperature", "toolChoice"],
      buildBody: (skip) => {
        const body: Record<string, unknown> = {};
        if (!skip.has("temperature")) body.temperature = 0.7;
        if (!skip.has("toolChoice")) body.tool_choice = "required";
        if (!skip.has("maxTokens")) body.max_tokens = 4096;
        return body;
      },
      send,
    });

    expect(result).toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({ max_tokens: 4096 });
  });

  it("非参数类错误原样抛出，不做无谓重试", async () => {
    const send = vi.fn().mockRejectedValue(new Error('HTTP 401 - {"error":{"message":"Invalid API key"}}'));
    await expect(
      sendWithParamCompat({
        modelId: "auth",
        buildBody: (skip) => {
          const body: Record<string, unknown> = {};
          if (!skip.has("temperature")) body.temperature = 0.7;
          return body;
        },
        send,
      })
    ).rejects.toThrow(/Invalid API key/);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("缺口记忆", () => {
  it("声明的缺口与学到的缺口合并在同一集合里", () => {
    rememberUnsupportedParam("merge", "temperature");
    const merged = resolveUnsupportedParams("merge", ["maxTokens"]);
    expect(merged.has("temperature")).toBe(true);
    expect(merged.has("maxTokens")).toBe(true);
    expect(merged.has("toolChoice")).toBe(false);
  });

  it("学到的缺口写入 localStorage（跨重启生效）", () => {
    rememberUnsupportedParam("dashscope:kimi-k3", "temperature");
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, string[]>;
    expect(raw["dashscope:kimi-k3"]).toEqual(["temperature"]);
  });

  it("clearLearnedUnsupportedParams 能清掉单个模型的记录", () => {
    rememberUnsupportedParam("a", "temperature");
    rememberUnsupportedParam("b", "maxTokens");
    clearLearnedUnsupportedParams("a");
    expect(getLearnedUnsupportedParams("a").size).toBe(0);
    expect(getLearnedUnsupportedParams("b").has("maxTokens")).toBe(true);
  });
});

describe("describeSkippedParams", () => {
  it("无声明也无学习记录时返回 null（列表不渲染徽标）", () => {
    expect(describeSkippedParams("clean-model")).toBeNull();
    expect(describeSkippedParams("clean-model", [])).toBeNull();
  });

  it("显式声明也能让列表出徽标（不必等撞一次 400）", () => {
    expect(describeSkippedParams("declared", ["temperature", "maxTokens"])).toEqual({
      count: 2,
      names: ["采样温度", "输出上限"],
    });
  });

  it("声明与学习记录去重合并后计数", () => {
    rememberUnsupportedParam("merged", "temperature");
    expect(describeSkippedParams("merged", ["temperature", "toolChoice"])).toEqual({
      count: 2,
      names: ["采样温度", "工具选择"],
    });
  });
});

describe("forgetUnsupportedParam", () => {
  it("只撤销指定参数，其余保留", () => {
    rememberUnsupportedParam("m", "temperature");
    rememberUnsupportedParam("m", "maxTokens");
    forgetUnsupportedParam("m", "temperature");
    const left = getLearnedUnsupportedParams("m");
    expect(left.has("temperature")).toBe(false);
    expect(left.has("maxTokens")).toBe(true);
  });

  it("撤销后同步落盘，不只是内存", () => {
    rememberUnsupportedParam("m", "temperature");
    forgetUnsupportedParam("m", "temperature");
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, string[]>;
    expect(raw.m).toBeUndefined();
  });

  it("撤销未记录过的参数不抛错", () => {
    expect(() => forgetUnsupportedParam("nobody", "temperature")).not.toThrow();
    expect(() => forgetUnsupportedParam("", "temperature")).not.toThrow();
  });
});
