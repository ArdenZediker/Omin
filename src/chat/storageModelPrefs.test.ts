import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USAGE_PREFERENCES } from "./storage";

// sqliteStorage 在浏览器/测试环境下最终落在 localStorage，这里换成内存 Map，
// 既避免污染真实存储，也让「写入 → 读取」链路可断言。
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("../app/sqliteStorage", () => ({
  readSqliteBackedJson: <T,>(key: string, fallback: T): T => {
    const raw = store.get(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  readSqliteBackedValue: (key: string): string | null => store.get(key) ?? null,
  saveSqliteBackedValue: (key: string, value: string): void => {
    store.set(key, value);
  },
}));

import {
  MODEL_USAGE_PREFERENCES_STORAGE_KEY,
  USAGE_PREFERENCES_STORAGE_KEY,
  getUsagePreferencesForModel,
  loadModelUsagePreferencesMap,
  removeUsagePreferencesForModel,
  saveUsagePreferencesForModel,
} from "./storage";

describe("模型级请求参数偏好（按模型 id 隔离）", () => {
  beforeEach(() => {
    store.clear();
  });

  it("未单独配置过的模型回落到旧的全局偏好——存量设置不会因为拆分而丢失", () => {
    store.set(USAGE_PREFERENCES_STORAGE_KEY, JSON.stringify({ ...DEFAULT_USAGE_PREFERENCES, temperature: 1.2 }));
    expect(getUsagePreferencesForModel("openai:gpt-4o").temperature).toBe(1.2);
    // 完全没有旧全局值时回落到内置默认
    store.clear();
    expect(getUsagePreferencesForModel("openai:gpt-4o").temperature).toBe(DEFAULT_USAGE_PREFERENCES.temperature);
  });

  it("每个模型各自生效，互不影响", () => {
    store.set(USAGE_PREFERENCES_STORAGE_KEY, JSON.stringify({ ...DEFAULT_USAGE_PREFERENCES, temperature: 0.7 }));
    saveUsagePreferencesForModel("a:one", { ...DEFAULT_USAGE_PREFERENCES, temperature: 0.1, maxOutputTokens: 512 });

    const one = getUsagePreferencesForModel("a:one");
    expect(one.temperature).toBe(0.1);
    expect(one.maxOutputTokens).toBe(512);

    const two = getUsagePreferencesForModel("a:two");
    expect(two.temperature).toBe(0.7);
    expect(two.maxOutputTokens).toBe(DEFAULT_USAGE_PREFERENCES.maxOutputTokens);
  });

  it("落在独立的存储键下，不写旧全局键", () => {
    saveUsagePreferencesForModel("a:one", { ...DEFAULT_USAGE_PREFERENCES, temperature: 0.2 });

    expect(store.has(MODEL_USAGE_PREFERENCES_STORAGE_KEY)).toBe(true);
    expect(store.has(USAGE_PREFERENCES_STORAGE_KEY)).toBe(false);
    const saved = JSON.parse(store.get(MODEL_USAGE_PREFERENCES_STORAGE_KEY)!) as Record<string, { temperature: number }>;
    expect(saved["a:one"].temperature).toBe(0.2);
  });

  it("移除模型级配置后回到全局兜底（删模型时的级联清理）", () => {
    store.set(USAGE_PREFERENCES_STORAGE_KEY, JSON.stringify({ ...DEFAULT_USAGE_PREFERENCES, temperature: 1.5 }));
    saveUsagePreferencesForModel("a:one", { ...DEFAULT_USAGE_PREFERENCES, temperature: 0.1 });
    expect(getUsagePreferencesForModel("a:one").temperature).toBe(0.1);

    removeUsagePreferencesForModel("a:one");
    expect(loadModelUsagePreferencesMap()["a:one"]).toBeUndefined();
    expect(getUsagePreferencesForModel("a:one").temperature).toBe(1.5);
  });

  it("存储内容损坏时安全回落，不抛异常", () => {
    store.set(MODEL_USAGE_PREFERENCES_STORAGE_KEY, "not-json");
    expect(loadModelUsagePreferencesMap()).toEqual({});
    expect(getUsagePreferencesForModel("a:one").temperature).toBe(DEFAULT_USAGE_PREFERENCES.temperature);
  });

  it("部分字段缺失的存量条目由默认值补齐", () => {
    store.set(MODEL_USAGE_PREFERENCES_STORAGE_KEY, JSON.stringify({ "a:one": { temperature: 0.3 } }));
    const prefs = getUsagePreferencesForModel("a:one");
    expect(prefs.temperature).toBe(0.3);
    expect(prefs.maxOutputTokens).toBe(DEFAULT_USAGE_PREFERENCES.maxOutputTokens);
  });
});
