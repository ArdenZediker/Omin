import { describe, expect, it } from "vitest";
import { DEFAULT_BASIC_SETTINGS } from "./constants";
import { normalizeBasicSettings } from "./settings";

describe("sandbox mode settings migration", () => {
  it("legacy sandboxEnabled=true migrates to workspace-write", () => {
    const settings = normalizeBasicSettings({
      ...DEFAULT_BASIC_SETTINGS,
      sandboxMode: undefined as never,
      sandboxEnabled: true,
    });
    expect(settings.sandboxMode).toBe("workspace-write");
    expect(settings.sandboxEnabled).toBe(true);
  });

  it("legacy sandboxEnabled=false migrates to danger-full-access", () => {
    const settings = normalizeBasicSettings({
      ...DEFAULT_BASIC_SETTINGS,
      sandboxMode: undefined as never,
      sandboxEnabled: false,
    });
    expect(settings.sandboxMode).toBe("danger-full-access");
    expect(settings.sandboxEnabled).toBe(false);
  });

  it("explicit sandbox mode survives normalization and repairs the legacy flag", () => {
    const settings = normalizeBasicSettings({
      ...DEFAULT_BASIC_SETTINGS,
      sandboxMode: "read-only",
      sandboxEnabled: false,
    });
    expect(settings.sandboxMode).toBe("read-only");
    expect(settings.sandboxEnabled).toBe(true);
  });

  it("corrupt settings without a legacy flag fall back to the platform default", () => {
    const settings = normalizeBasicSettings({
      ...DEFAULT_BASIC_SETTINGS,
      sandboxMode: "invalid" as never,
      sandboxEnabled: undefined as never,
    });
    expect(settings.sandboxMode).toBe(DEFAULT_BASIC_SETTINGS.sandboxMode);
    expect(settings.sandboxEnabled).toBe(
      DEFAULT_BASIC_SETTINGS.sandboxMode !== "danger-full-access",
    );
  });
});
