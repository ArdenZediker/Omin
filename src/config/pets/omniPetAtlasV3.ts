export type DesktopPetSceneAction =
  | "idle-front"
  | "blink"
  | "turn-head"
  | "sit"
  | "lay-down"
  | "sleep"
  | "greet"
  | "happy"
  | "clingy"
  | "curious"
  | "wait"
  | "clicked-reaction"
  | "thinking"
  | "query"
  | "reading"
  | "computer"
  | "task-done"
  | "sad"
  | "walk"
  | "run"
  | "jump"
  | "dragging"
  | "magic-form"
  | "cool-entry"
  | "heart-moment";

export type DesktopPetSceneAnimation = {
  row: number;
  frames: number[];
  durations: number[];
  group: "基础" | "交互" | "工作" | "移动" | "彩蛋";
  purpose: string;
  tags?: string[];
};

export type DesktopPetSceneManifest = {
  id: string;
  name: string;
  spritesheetSrc: string;
  cellWidth: number;
  cellHeight: number;
  atlasColumns: number;
  atlasRows: number;
  ambientActions: DesktopPetSceneAction[];
  ambientDelayMs: {
    min: number;
    max: number;
  };
  animations: Record<DesktopPetSceneAction, DesktopPetSceneAnimation>;
};

const frames = (count: number) => Array.from({ length: count }, (_, index) => index);

export const OMNI_PET_ATLAS_V3: DesktopPetSceneManifest = {
  id: "omni-pet-v3",
  name: "Omni Pet Atlas V3",
  spritesheetSrc: "/pets/omni-pet-v3-alpha.png?v=20260506-1444",
  cellWidth: 192,
  cellHeight: 208,
  atlasColumns: 8,
  atlasRows: 26,
  ambientActions: ["idle-front", "blink", "turn-head", "sit", "happy", "curious", "wait", "walk"],
  ambientDelayMs: {
    min: 2200,
    max: 5200,
  },
  animations: {
    "idle-front": { row: 0, frames: frames(6), durations: [480, 220, 220, 240, 240, 580], group: "基础", purpose: "待机", tags: ["ambient", "default"] },
    blink: { row: 1, frames: frames(4), durations: [140, 120, 120, 220], group: "基础", purpose: "眨眼", tags: ["ambient"] },
    "turn-head": { row: 2, frames: frames(6), durations: [220, 220, 220, 220, 220, 360], group: "基础", purpose: "转头", tags: ["ambient"] },
    sit: { row: 3, frames: frames(4), durations: [260, 260, 280, 420], group: "基础", purpose: "坐下", tags: ["rest"] },
    "lay-down": { row: 4, frames: frames(5), durations: [260, 260, 280, 320, 460], group: "基础", purpose: "趴下", tags: ["rest"] },
    sleep: { row: 5, frames: frames(5), durations: [320, 280, 280, 320, 520], group: "基础", purpose: "睡觉", tags: ["rest"] },
    greet: { row: 6, frames: frames(4), durations: [220, 220, 220, 420], group: "交互", purpose: "打招呼", tags: ["menu", "welcome"] },
    happy: { row: 7, frames: frames(4), durations: [180, 180, 200, 320], group: "交互", purpose: "开心", tags: ["success"] },
    clingy: { row: 8, frames: frames(5), durations: [220, 220, 220, 240, 320], group: "交互", purpose: "撒娇", tags: ["interaction"] },
    curious: { row: 9, frames: frames(5), durations: [180, 180, 200, 220, 320], group: "交互", purpose: "疑惑", tags: ["question"] },
    wait: { row: 10, frames: frames(5), durations: [260, 240, 260, 240, 420], group: "交互", purpose: "等待", tags: ["waiting"] },
    "clicked-reaction": { row: 11, frames: frames(5), durations: [160, 160, 180, 200, 300], group: "交互", purpose: "被点击反应", tags: ["reaction"] },
    thinking: { row: 12, frames: frames(5), durations: [220, 220, 240, 240, 360], group: "工作", purpose: "思考", tags: ["thinking"] },
    query: { row: 13, frames: frames(5), durations: [200, 200, 220, 220, 320], group: "工作", purpose: "查询", tags: ["query"] },
    reading: { row: 14, frames: frames(4), durations: [260, 260, 260, 420], group: "工作", purpose: "读书", tags: ["work"] },
    computer: { row: 15, frames: frames(4), durations: [240, 240, 260, 420], group: "工作", purpose: "电脑前", tags: ["work"] },
    "task-done": { row: 16, frames: frames(5), durations: [180, 180, 200, 220, 340], group: "工作", purpose: "完成任务", tags: ["success"] },
    sad: { row: 17, frames: frames(5), durations: [220, 220, 240, 260, 360], group: "工作", purpose: "失败/委屈", tags: ["error"] },
    walk: { row: 18, frames: frames(6), durations: [180, 180, 180, 180, 180, 260], group: "移动", purpose: "走路", tags: ["movement"] },
    run: { row: 19, frames: frames(6), durations: [140, 140, 140, 140, 140, 220], group: "移动", purpose: "奔跑", tags: ["movement"] },
    jump: { row: 20, frames: frames(5), durations: [220, 220, 240, 260, 360], group: "移动", purpose: "跳跃", tags: ["movement"] },
    dragging: { row: 21, frames: frames(5), durations: [130, 130, 130, 130, 220], group: "移动", purpose: "拖动中", tags: ["dragging"] },
    "magic-form": { row: 22, frames: frames(5), durations: [200, 200, 220, 240, 420], group: "彩蛋", purpose: "魔法变身", tags: ["easter-egg"] },
    "cool-entry": { row: 23, frames: frames(4), durations: [220, 220, 220, 420], group: "彩蛋", purpose: "墨镜登场", tags: ["easter-egg"] },
    "heart-moment": { row: 24, frames: frames(5), durations: [220, 220, 240, 260, 420], group: "彩蛋", purpose: "爱心时刻", tags: ["easter-egg"] },
  },
};
