import { beforeEach, describe, expect, it } from "vitest";
import { BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS, MAIN_POSITION_STORAGE_KEY } from "./constants";
import { migrateMainWindowPositionPreference } from "./settingsStore";
import { readSqliteBackedValue, saveSqliteBackedValue } from "./sqliteStorage";

const MIGRATION_KEY = "omni_main_window_position_migrated_v1";

function readStoredSettings() {
  return JSON.parse(readSqliteBackedValue(BASIC_SETTINGS_STORAGE_KEY) ?? "{}") as {
    mainWindowPositionMode?: string;
  };
}

describe("migrateMainWindowPositionPreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("把存量的「记住上次位置」迁成「居中」，并清掉旧记忆位置", () => {
    saveSqliteBackedValue(
      BASIC_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_BASIC_SETTINGS, mainWindowPositionMode: "remember" })
    );
    saveSqliteBackedValue(MAIN_POSITION_STORAGE_KEY, JSON.stringify({ x: 228, y: 123 }));

    expect(migrateMainWindowPositionPreference()).toBe(true);

    expect(readStoredSettings().mainWindowPositionMode).toBe("center");
    expect(readSqliteBackedValue(MAIN_POSITION_STORAGE_KEY)).toBeNull();
    expect(readSqliteBackedValue(MIGRATION_KEY)).toBe("done");
  });

  it("已是「居中」时不改设置，但照样写迁移标记", () => {
    saveSqliteBackedValue(
      BASIC_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_BASIC_SETTINGS, mainWindowPositionMode: "center" })
    );

    expect(migrateMainWindowPositionPreference()).toBe(false);
    expect(readStoredSettings().mainWindowPositionMode).toBe("center");
    expect(readSqliteBackedValue(MIGRATION_KEY)).toBe("done");
  });

  it("只迁移一次：用户之后显式改回「记住上次位置」不会被再次改掉", () => {
    saveSqliteBackedValue(MIGRATION_KEY, "done");
    saveSqliteBackedValue(
      BASIC_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_BASIC_SETTINGS, mainWindowPositionMode: "remember" })
    );

    expect(migrateMainWindowPositionPreference()).toBe(false);
    expect(readStoredSettings().mainWindowPositionMode).toBe("remember");
  });
});
