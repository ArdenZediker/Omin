import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clampPanelWidth,
  readStoredPanelWidth,
  MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY,
} from "./mainChatViewUtils";

const readSqliteBackedValue = vi.fn<() => string | null>();

vi.mock("../app/sqliteStorage", () => ({
  readSqliteBackedValue: () => readSqliteBackedValue(),
}));

describe("mainChatViewUtils", () => {
  beforeEach(() => {
    readSqliteBackedValue.mockReset();
  });

  describe("clampPanelWidth", () => {
    it("returns value when inside range", () => {
      expect(clampPanelWidth(300, 220, 520)).toBe(300);
    });

    it("clamps to min", () => {
      expect(clampPanelWidth(100, 220, 520)).toBe(220);
    });

    it("clamps to max", () => {
      expect(clampPanelWidth(900, 220, 520)).toBe(520);
    });
  });

  describe("readStoredPanelWidth", () => {
    it("returns fallback when no saved value", () => {
      readSqliteBackedValue.mockReturnValue(null);
      expect(readStoredPanelWidth(MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY, 240, 220, 520)).toBe(240);
    });

    it("returns saved value when valid", () => {
      readSqliteBackedValue.mockReturnValue("360");
      expect(readStoredPanelWidth(MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY, 240, 220, 520)).toBe(360);
    });

    it("clamps saved value to max", () => {
      readSqliteBackedValue.mockReturnValue("900");
      expect(readStoredPanelWidth(MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY, 240, 220, 520)).toBe(520);
    });

    it("clamps saved value to min", () => {
      readSqliteBackedValue.mockReturnValue("100");
      expect(readStoredPanelWidth(MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY, 240, 220, 520)).toBe(220);
    });

    it("returns fallback for non-numeric saved value", () => {
      readSqliteBackedValue.mockReturnValue("not-a-number");
      expect(readStoredPanelWidth(MAIN_LAYOUT_TOPIC_WIDTH_STORAGE_KEY, 240, 220, 520)).toBe(240);
    });
  });
});
