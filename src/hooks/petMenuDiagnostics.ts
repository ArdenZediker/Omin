type PetMenuDiagnosticDetail = Record<string, unknown>;

type PetMenuDiagnosticEvent = {
  traceId: number | null;
  elapsedMs: number;
  event: string;
  detail?: PetMenuDiagnosticDetail;
};

declare global {
  interface Window {
    __OMNI_PET_MENU_DIAGNOSTICS__?: PetMenuDiagnosticEvent[];
  }
}

let nextTraceId = 0;
let activeTraceId: number | null = null;
let traceStartedAt = 0;

function isEnabled() {
  try {
    return window.localStorage.getItem("omni:pet-menu-diagnostics") === "1";
  } catch {
    return false;
  }
}

export function beginPetMenuTrace(detail?: PetMenuDiagnosticDetail) {
  if (!isEnabled()) return null;
  activeTraceId = ++nextTraceId;
  traceStartedAt = performance.now();
  petMenuDiagnostic("open-request", detail);
  return activeTraceId;
}

export function petMenuDiagnostic(event: string, detail?: PetMenuDiagnosticDetail) {
  if (!isEnabled()) return;
  const entry: PetMenuDiagnosticEvent = {
    traceId: activeTraceId,
    elapsedMs: activeTraceId === null ? 0 : Math.round((performance.now() - traceStartedAt) * 10) / 10,
    event,
    ...(detail ? { detail } : {}),
  };
  const entries = (window.__OMNI_PET_MENU_DIAGNOSTICS__ ??= []);
  entries.push(entry);
  if (entries.length > 500) entries.splice(0, entries.length - 500);
  console.info("[pet-menu-diagnostic]", entry);
}

export function endPetMenuTrace(detail?: PetMenuDiagnosticDetail) {
  if (activeTraceId === null) return;
  petMenuDiagnostic("trace-ended", detail);
  activeTraceId = null;
}
