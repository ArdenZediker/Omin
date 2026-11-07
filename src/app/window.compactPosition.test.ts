import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  availableMonitors: vi.fn(async () => [] as unknown[]),
  cursorPosition: vi.fn(async () => ({ x: 0, y: 0 })),
  monitorFromPoint: vi.fn(async () => null),
  readSqliteBackedValue: vi.fn((): string | null => null),
  saveSqliteBackedValue: vi.fn((_key: string, _value: string) => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  availableMonitors: () => mocks.availableMonitors(),
  cursorPosition: () => mocks.cursorPosition(),
  monitorFromPoint: () => mocks.monitorFromPoint(),
  getCurrentWindow: () => ({}),
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalPosition: class {
    constructor(
      public x: number,
      public y: number
    ) {}
  },
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number
    ) {}
  },
  LogicalSize: class {
    constructor(
      public width: number,
      public height: number
    ) {}
  },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: async () => null } }));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => undefined }));
vi.mock("./sqliteStorage", () => ({
  readSqliteBackedJson: () => null,
  readSqliteBackedValue: () => mocks.readSqliteBackedValue(),
  saveSqliteBackedValue: (key: string, value: string) => mocks.saveSqliteBackedValue(key, value),
}));

import type { Monitor } from "@tauri-apps/api/window";
import {
  getCompactAnchorPositionForMonitor,
  getSafeStoredCompactPosition,
  getSafeStoredMainPosition,
  mapCompactPositionToMonitor,
  migrateLogicalCompactPositionToPhysical,
  toCompactPhysicalPosition,
  toNativePetCompactPosition,
  toPhysicalSize,
  toVisualPetCompactPosition,
} from "./window";

/**
 * 本机真实几何（见 .workbuddy/probe-monitor-follow.py 实测）：
 *   DISPLAY1 2560×1600 @150%  任务栏 72px
 *   DISPLAY2 1920×1080 @100%  任务栏 48px
 * 两屏 DPI 不同 —— 这正是「鼠标随航跨屏后悬浮球看不见」的触发条件。
 */
function makeMonitor(
  name: string,
  scaleFactor: number,
  x: number,
  y: number,
  width: number,
  height: number,
  taskbar: number
): Monitor {
  return {
    name,
    scaleFactor,
    position: { x, y },
    size: { width, height },
    workArea: { position: { x, y }, size: { width, height: height - taskbar } },
  } as unknown as Monitor;
}

const PRIMARY = makeMonitor("\\\\.\\DISPLAY1", 1.5, 0, 0, 2560, 1600, 72);
const SECONDARY = makeMonitor("\\\\.\\DISPLAY2", 1, 2560, 0, 1920, 1080, 48);

/** 紧凑窗尺寸是**逻辑像素**（CSS），物理尺寸要乘所在屏 scale。 */
const COMPACT_SIZE = { width: 170, height: 200 };

function physicalWorkArea(monitor: Monitor) {
  const { position, size } = monitor.workArea;
  return {
    left: position.x,
    top: position.y,
    right: position.x + size.width,
    bottom: position.y + size.height,
  };
}

beforeEach(() => {
  mocks.availableMonitors.mockReset().mockResolvedValue([]);
  mocks.readSqliteBackedValue.mockReset().mockReturnValue(null);
  mocks.saveSqliteBackedValue.mockReset();
});

describe("紧凑窗跨屏映射：落点必须留在目标屏的物理工作区内", () => {
  it("150% → 100%：映射结果不越出目标屏（回归「跨屏后悬浮球看不见」）", () => {
    // 源屏（150%）贴右边缘的物理位置：窗口物理宽 170×1.5 = 255
    const sourcePhysical = { x: 2560 - 255 - 10, y: 200 };
    const mapped = mapCompactPositionToMonitor(sourcePhysical, PRIMARY, SECONDARY, COMPACT_SIZE);

    const targetSize = toPhysicalSize(COMPACT_SIZE, SECONDARY.scaleFactor);
    const area = physicalWorkArea(SECONDARY);
    expect(mapped.x).toBeGreaterThanOrEqual(area.left);
    expect(mapped.x + targetSize.width).toBeLessThanOrEqual(area.right);
    expect(mapped.y).toBeGreaterThanOrEqual(area.top);
    expect(mapped.y + targetSize.height).toBeLessThanOrEqual(area.bottom);

    // 旧行为：把「目标屏逻辑坐标」交给 LogicalPosition 写入，tao 会用**源屏** scale
    // 再放大一次（tao windows/window.rs:229）⇒ 物理落点越出虚拟桌面右边界 4480，
    // 悬浮球整块跑到屏外。这条断言把旧实现的失效模式钉死，防止回归。
    const legacyWrite = Math.round((mapped.x / SECONDARY.scaleFactor) * PRIMARY.scaleFactor);
    expect(legacyWrite).toBeGreaterThan(4480);
  });

  it("100% → 150%：反方向同样落在目标屏内", () => {
    const sourcePhysical = { x: 4350, y: 300 };
    const mapped = mapCompactPositionToMonitor(sourcePhysical, SECONDARY, PRIMARY, COMPACT_SIZE);

    const targetSize = toPhysicalSize(COMPACT_SIZE, PRIMARY.scaleFactor);
    const area = physicalWorkArea(PRIMARY);
    expect(mapped.x).toBeGreaterThanOrEqual(area.left);
    expect(mapped.x + targetSize.width).toBeLessThanOrEqual(area.right);
    expect(mapped.y + targetSize.height).toBeLessThanOrEqual(area.bottom);
  });

  it("同屏映射是恒等变换（不引入漂移）", () => {
    const position = { x: 1234, y: 567 };
    expect(mapCompactPositionToMonitor(position, PRIMARY, PRIMARY, COMPACT_SIZE)).toEqual(position);
  });
});

describe("锚点位置按目标屏 scale 换算", () => {
  it.each([
    ["主屏 150%", PRIMARY],
    ["副屏 100%", SECONDARY],
  ])("%s 上锚点 + 窗口物理尺寸不越界", (_label, monitor) => {
    const anchor = getCompactAnchorPositionForMonitor(monitor, COMPACT_SIZE);
    const physicalSize = toPhysicalSize(COMPACT_SIZE, monitor.scaleFactor);
    const area = physicalWorkArea(monitor);

    expect(anchor.x).toBeGreaterThanOrEqual(area.left);
    expect(anchor.x + physicalSize.width).toBeLessThanOrEqual(area.right);
    expect(anchor.y).toBeGreaterThanOrEqual(area.top);
    expect(anchor.y + physicalSize.height).toBeLessThanOrEqual(area.bottom);
  });

  it("主屏锚点具体数值（物理，含 24 逻辑像素边距 ×1.5）", () => {
    expect(getCompactAnchorPositionForMonitor(PRIMARY, COMPACT_SIZE)).toEqual({
      x: 2560 - 255 - 36,
      y: Math.round((1528 - 300) * 0.42),
    });
  });
});

describe("旧版逻辑坐标记录的迁移", () => {
  it("按各屏自己的逻辑矩形反推所属屏，再乘该屏 scale", () => {
    // DISPLAY1(150%) 的逻辑矩形 ≈ [0,0,1706.7,1018.7]：x=1600 落在其中。
    expect(migrateLogicalCompactPositionToPhysical({ x: 1600, y: 500 }, [PRIMARY, SECONDARY])).toEqual({
      x: 2400,
      y: 750,
    });
  });

  it("副屏（100%）记录的逻辑值与物理值相同", () => {
    expect(migrateLogicalCompactPositionToPhysical({ x: 4300, y: 362 }, [PRIMARY, SECONDARY])).toEqual({
      x: 4300,
      y: 362,
    });
  });

  it("一块屏都不命中时返回 null（回落到确定性锚点，不瞎猜）", () => {
    expect(migrateLogicalCompactPositionToPhysical({ x: 12000, y: 9000 }, [PRIMARY, SECONDARY])).toBeNull();
  });
});

describe("存储位置读取：归一化到物理像素", () => {
  it("旧版记录被迁移成物理值并写回新格式（一次性）", async () => {
    mocks.readSqliteBackedValue.mockReturnValue(JSON.stringify({ x: 1600, y: 500 }));
    mocks.availableMonitors.mockResolvedValue([PRIMARY, SECONDARY]);

    const stored = await getSafeStoredCompactPosition(COMPACT_SIZE);

    expect(stored).toEqual({ position: { x: 2400, y: 750 }, scale: 1.5 });
    expect(mocks.saveSqliteBackedValue).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.saveSqliteBackedValue.mock.calls[0][1])).toMatchObject({
      x: 2400,
      y: 750,
      unit: "physical",
      scale: 1.5,
    });
  });

  it("已是物理格式则原样透传，不再写回", async () => {
    mocks.readSqliteBackedValue.mockReturnValue(
      JSON.stringify({ x: 4300, y: 362, unit: "physical", scale: 1 })
    );
    mocks.availableMonitors.mockResolvedValue([PRIMARY, SECONDARY]);

    const stored = await getSafeStoredCompactPosition(COMPACT_SIZE);

    expect(stored).toEqual({ position: { x: 4300, y: 362 }, scale: 1 });
    expect(mocks.saveSqliteBackedValue).not.toHaveBeenCalled();
  });

  it("迁不动的旧记录当作无记录（不返回越界位置）", async () => {
    mocks.readSqliteBackedValue.mockReturnValue(JSON.stringify({ x: 12000, y: 9000 }));
    mocks.availableMonitors.mockResolvedValue([PRIMARY, SECONDARY]);

    expect(await getSafeStoredCompactPosition(COMPACT_SIZE)).toBeNull();
  });
});

describe("逻辑 ↔ 物理换算", () => {
  it("尺寸与坐标一律乘目标屏 scale", () => {
    expect(toPhysicalSize(COMPACT_SIZE, 1.5)).toEqual({ width: 255, height: 300 });
    expect(toPhysicalSize(COMPACT_SIZE, 1)).toEqual(COMPACT_SIZE);
    expect(toCompactPhysicalPosition({ x: 100, y: 200 }, 1.5)).toEqual({ x: 150, y: 300 });
  });

  it("宠物视觉位置与窗口顶边位置互为逆变换（含装饰边距 ×scale）", () => {
    expect(toNativePetCompactPosition("pet", { x: 100, y: 1000 }, 1.5)).toEqual({ x: 100, y: 976 });
    expect(toVisualPetCompactPosition("pet", { x: 100, y: 976 }, 1.5)).toEqual({ x: 100, y: 1000 });
  });

  it("非宠物外观不做装饰边距换算", () => {
    expect(toNativePetCompactPosition("default", { x: 100, y: 1000 }, 1.5)).toEqual({ x: 100, y: 1000 });
    expect(toVisualPetCompactPosition("default", { x: 100, y: 1000 }, 1.5)).toEqual({ x: 100, y: 1000 });
  });
});

/**
 * 主窗是**同一个病灶**：位置在「窗口当时所在屏」的逻辑空间里保存，重启时窗口
 * 已由 tauri.conf.json 以 center:true 创建在主屏，写回又按主屏 scale 换算。
 * 症状是「记住上次位置」形同虚设（被判不可见 ⇒ 回落居中），极端时整块出屏。
 */
const MAIN_WINDOW_SIZE = { width: 920, height: 820 };

describe("主窗位置：归一化物理像素 + 按全部显示器判可见", () => {
  it("副屏（100%）保存的位置：迁移成物理值并写回新格式", async () => {
    // 副屏物理工作区 [2560,4480]×[0,1032]，主窗逻辑宽 920 ⇒ 最右可放 x=4480-920=3560。
    // 副屏 scale=1，所以旧记录里存下的逻辑值恰好等于物理值。
    mocks.readSqliteBackedValue.mockReturnValue(JSON.stringify({ x: 3560, y: 400 }));
    mocks.availableMonitors.mockResolvedValue([PRIMARY, SECONDARY]);

    const stored = await getSafeStoredMainPosition(MAIN_WINDOW_SIZE);

    expect(stored).toEqual({ position: { x: 3560, y: 400 }, scale: 1 });
    expect(mocks.saveSqliteBackedValue).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.saveSqliteBackedValue.mock.calls[0][1])).toMatchObject({
      x: 3560,
      y: 400,
      unit: "physical",
      scale: 1,
    });
  });

  it("回归：旧实现要么把副屏位置判成不可见、要么整块送出虚拟桌面", async () => {
    const legacyX = 3560; // 副屏上合法的最右位置（物理宽 920，scale=1）

    // 旧可见性判定读 window.screen（**当前屏=主屏**）的逻辑右边界 2560/1.5≈1706.7：
    // 3560 远在其外 ⇒ 一律判「不可见」并回落居中。这才是主症状（位置记不住）。
    const currentScreenLogicalRight = 2560 / PRIMARY.scaleFactor;
    expect(legacyX).toBeGreaterThan(currentScreenLogicalRight);

    // 旧写入路径：即便通过了判定，LogicalPosition(3560) 也会被 tao 按主屏 scale 放大
    // （windows/window.rs:230）⇒ 3560×1.5=5340 > 虚拟桌面右边界 4480 ⇒ 窗口整块出屏。
    const legacyPhysicalX = Math.round(legacyX * PRIMARY.scaleFactor);
    expect(legacyPhysicalX).toBeGreaterThan(2560 + 1920);

    // 新路径：物理值原样写入，窗口完整落在副屏物理工作区内。
    mocks.readSqliteBackedValue.mockReturnValue(JSON.stringify({ x: 3560, y: 400 }));
    mocks.availableMonitors.mockResolvedValue([PRIMARY, SECONDARY]);
    const stored = await getSafeStoredMainPosition(MAIN_WINDOW_SIZE);
    const area = physicalWorkArea(SECONDARY);

    expect(stored).not.toBeNull();
    expect(stored?.position.x).toBeGreaterThanOrEqual(area.left);
    expect((stored?.position.x ?? 0) + MAIN_WINDOW_SIZE.width).toBeLessThanOrEqual(area.right);
    expect(stored?.position.y).toBeGreaterThanOrEqual(area.top);
  });

  it("主屏（150%）保存的位置：按主屏 scale 反推出物理值", async () => {
    // 主屏逻辑矩形 ≈ [0,0,1706.7,1018.7]；旧实现存 1024（= 物理 1536 ÷ 1.5）落在其中。
    mocks.readSqliteBackedValue.mockReturnValue(JSON.stringify({ x: 1024, y: 300 }));
    mocks.availableMonitors.mockResolvedValue([PRIMARY, SECONDARY]);

    expect(await getSafeStoredMainPosition(MAIN_WINDOW_SIZE)).toEqual({
      position: { x: 1536, y: 450 },
      scale: 1.5,
    });
  });

  it("已是物理格式则原样透传（重启不跳位，也不再写回）", async () => {
    mocks.readSqliteBackedValue.mockReturnValue(
      JSON.stringify({ x: 2400, y: 750, unit: "physical", scale: 1.5 })
    );
    mocks.availableMonitors.mockResolvedValue([PRIMARY, SECONDARY]);

    expect(await getSafeStoredMainPosition(MAIN_WINDOW_SIZE)).toEqual({
      position: { x: 2400, y: 750 },
      scale: 1.5,
    });
    expect(mocks.saveSqliteBackedValue).not.toHaveBeenCalled();
  });

  it("落在所有显示器之外 ⇒ 返回 null（回落居中，不瞎猜）", async () => {
    mocks.readSqliteBackedValue.mockReturnValue(
      JSON.stringify({ x: 12000, y: 9000, unit: "physical", scale: 1 })
    );
    mocks.availableMonitors.mockResolvedValue([PRIMARY, SECONDARY]);

    expect(await getSafeStoredMainPosition(MAIN_WINDOW_SIZE)).toBeNull();
  });

  it("显示器枚举为空时不丢弃物理位置（信任存储值）", async () => {
    mocks.readSqliteBackedValue.mockReturnValue(
      JSON.stringify({ x: 2400, y: 750, unit: "physical", scale: 1.5 })
    );
    mocks.availableMonitors.mockResolvedValue([]);

    expect(await getSafeStoredMainPosition(MAIN_WINDOW_SIZE)).toEqual({
      position: { x: 2400, y: 750 },
      scale: 1.5,
    });
  });

  it("(0,0) 退化坐标视为无记录（窗口创建瞬间闪现不覆盖用户摆放）", async () => {
    mocks.readSqliteBackedValue.mockReturnValue(JSON.stringify({ x: 0, y: 0, unit: "physical", scale: 1 }));
    mocks.availableMonitors.mockResolvedValue([PRIMARY, SECONDARY]);

    expect(await getSafeStoredMainPosition(MAIN_WINDOW_SIZE)).toBeNull();
  });
});
