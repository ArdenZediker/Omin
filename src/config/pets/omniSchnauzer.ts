import { CODEX_PET_CELL_SIZE } from "../../app/pets/codexPetSizing";

export type DesktopPetAction =
  | "idle"
  | "blink"
  | "greet"
  | "jumping"
  | "walking"
  | "running"
  | "waiting"
  | "happy"
  | "thinking"
  | "searching"
  | "clicked"
  | "task-done"
  | "working"
  | "confused"
  | "sad-failed";

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
  id: "omni-pet-v3",
  name: "Omni Pet V3",
  spritesheetSrc: "/pets/omni-schnauzer/spritesheet.webp",
  cellWidth: CODEX_PET_CELL_SIZE.width,
  cellHeight: CODEX_PET_CELL_SIZE.height,
  atlasColumns: 8,
  atlasRows: 26,
  ambientActions: ["idle", "blink"],
  ambientDelayMs: {
    min: 2200,
    max: 5200,
  },
  animations: {
    idle: { row: 0, frames: [0, 1, 2, 3, 4, 5], durations: [620, 320, 320, 340, 340, 720], tags: ["ambient", "default"] },
    blink: { row: 1, frames: [0, 1, 2, 3], durations: [220, 180, 180, 320], tags: ["ambient", "blink"] },
    greet: { row: 6, frames: [0, 1, 2, 3], durations: [340, 340, 340, 620], tags: ["ambient", "menu"] },
    jumping: { row: 20, frames: [0, 1, 2, 3, 4], durations: [340, 340, 360, 390, 540], tags: ["ambient", "jump"] },
    walking: { row: 18, frames: [0, 1, 2, 3, 4, 5], durations: [280, 280, 280, 280, 280, 400], tags: ["ambient", "patrol"] },
    running: { row: 21, frames: [0, 1, 2, 3, 4], durations: [220, 220, 220, 220, 340], tags: ["dragging", "movement"] },
    waiting: { row: 10, frames: [0, 1, 2, 3, 4], durations: [380, 360, 380, 360, 620], tags: ["idle", "waiting"] },
    thinking: { row: 12, frames: [0, 1, 2, 3, 4], durations: [340, 340, 360, 360, 540], tags: ["thinking", "query"] },
    searching: { row: 13, frames: [0, 1, 2, 3, 4], durations: [320, 320, 340, 340, 500], tags: ["query", "active"] },
    clicked: { row: 11, frames: [0, 1, 2, 3, 4], durations: [260, 260, 280, 300, 460], tags: ["ambient", "listen"] },
    "task-done": { row: 16, frames: [0, 1, 2, 3, 4], durations: [300, 300, 320, 340, 520], tags: ["success", "reply"] },
    working: { row: 15, frames: [0, 1, 2, 3], durations: [380, 380, 400, 620], tags: ["response", "focus"] },
    confused: { row: 9, frames: [0, 1, 2, 3, 4], durations: [300, 300, 320, 340, 500], tags: ["menu", "question"] },
    "sad-failed": { row: 17, frames: [0, 1, 2, 3, 4], durations: [340, 340, 360, 390, 540], tags: ["error"] },
    happy: { row: 7, frames: [0, 1, 2, 3], durations: [300, 300, 320, 500], tags: ["ambient", "happy"] },
  },
};
