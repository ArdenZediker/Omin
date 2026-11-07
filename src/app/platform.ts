export function isWindowsUserAgent(userAgent: string): boolean {
  return /Windows/i.test(userAgent);
}

export function isMacOSUserAgent(userAgent: string): boolean {
  return /Macintosh|Mac OS X/i.test(userAgent);
}

export function hasOsFileSandboxForUserAgent(userAgent: string): boolean {
  return isWindowsUserAgent(userAgent) || isMacOSUserAgent(userAgent);
}

const currentUserAgent =
  typeof navigator === "undefined" ? "" : navigator.userAgent;

export const IS_WINDOWS_PLATFORM = isWindowsUserAgent(currentUserAgent);
export const IS_MACOS_PLATFORM = isMacOSUserAgent(currentUserAgent);

/** Platforms with a compiled OS-level file sandbox backend. */
export const HAS_OS_FILE_SANDBOX = hasOsFileSandboxForUserAgent(currentUserAgent);
