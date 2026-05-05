export type DesktopPetAction =
  | "idle"
  | "waving"
  | "jumping"
  | "running"
  | "waiting"
  | "review"
  | "failed";

export type DesktopPetAnimation = {
  row: number;
  frames: number[];
  durations: number[];
  tags?: string[];
};

export type DesktopPetManifest = {
  id: string;
  name: string;
  spritesheetSrc: string;
  cellWidth: number;
  cellHeight: number;
  atlasColumns: number;
  atlasRows: number;
  ambientActions: DesktopPetAction[];
  ambientDelayMs: {
    min: number;
    max: number;
  };
  animations: Record<DesktopPetAction, DesktopPetAnimation>;
};

export const OMNI_SCHNAUZER_PET: DesktopPetManifest = {
  id: "omni-schnauzer",
  name: "Omni Schnauzer",
  spritesheetSrc: "/pets/omni-schnauzer.webp",
  cellWidth: 192,
  cellHeight: 208,
  atlasColumns: 8,
  atlasRows: 9,
  ambientActions: ["idle", "waving", "jumping", "waiting", "review"],
  ambientDelayMs: {
    min: 2200,
    max: 5800,
  },
  animations: {
    idle: { row: 0, frames: [0, 1, 2, 3, 4, 5], durations: [520, 220, 220, 260, 260, 620], tags: ["ambient", "default"] },
    waving: { row: 3, frames: [0, 1, 2, 3], durations: [260, 260, 260, 520], tags: ["ambient", "greeting"] },
    jumping: { row: 4, frames: [0, 1, 2, 3, 4], durations: [260, 240, 240, 260, 520], tags: ["ambient", "menu"] },
    failed: { row: 5, frames: [0, 1, 2, 3, 4, 5, 6, 7], durations: [250, 250, 250, 250, 250, 250, 250, 440], tags: ["error"] },
    waiting: { row: 6, frames: [0, 1, 2, 3, 4, 5], durations: [280, 280, 280, 280, 280, 480], tags: ["ambient", "query"] },
    running: { row: 7, frames: [0, 1, 2, 3, 4, 5], durations: [210, 210, 210, 210, 210, 360], tags: ["dragging", "movement"] },
    review: { row: 8, frames: [0, 1, 2, 3, 4, 5], durations: [280, 280, 280, 280, 280, 500], tags: ["response", "focus"] },
  },
};
