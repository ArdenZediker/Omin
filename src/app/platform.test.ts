import { describe, expect, it } from "vitest";
import {
  hasOsFileSandboxForUserAgent,
  isMacOSUserAgent,
  isWindowsUserAgent,
} from "./platform";

describe("platform sandbox capability", () => {
  it("enables the native backend on Windows and macOS", () => {
    expect(hasOsFileSandboxForUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(true);
    expect(hasOsFileSandboxForUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(true);
    expect(hasOsFileSandboxForUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });

  it("keeps platform detection independent from the current host", () => {
    expect(isWindowsUserAgent("Windows")).toBe(true);
    expect(isWindowsUserAgent("Macintosh")).toBe(false);
    expect(isMacOSUserAgent("Mac OS X")).toBe(true);
    expect(isMacOSUserAgent("Windows")).toBe(false);
  });
});
