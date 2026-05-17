import { useEffect, useMemo, useState } from "react";
import type { CodexPetPackage } from "../app/pets/codexPetTypes";
import { convertFileSrc } from "@tauri-apps/api/core";

type DesktopPetProps = {
  width: number;
  height: number;
  state: "idle" | "running-right" | "running-left" | "waving" | "jumping" | "failed" | "waiting" | "running" | "review";
  packageData?: CodexPetPackage | null;
};

const PET_PLAYBACK_RATE = 1.55;
const PET_ROWS: Record<DesktopPetProps["state"], { row: number; frames: number[]; durations: number[] }> = {
  idle: { row: 0, frames: [0, 1, 2, 3, 4, 5], durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, frames: [0, 1, 2, 3, 4, 5, 6, 7], durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, frames: [0, 1, 2, 3, 4, 5, 6, 7], durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, frames: [0, 1, 2, 3], durations: [140, 140, 140, 280] },
  jumping: { row: 4, frames: [0, 1, 2, 3, 4], durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, frames: [0, 1, 2, 3, 4, 5, 6, 7], durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, frames: [0, 1, 2, 3, 4, 5], durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, frames: [0, 1, 2, 3, 4, 5], durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, frames: [0, 1, 2, 3, 4, 5], durations: [150, 150, 150, 150, 150, 280] },
};

export default function DesktopPet({ width, height, state, packageData }: DesktopPetProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const actualState = state;
  const frameset = PET_ROWS[actualState];
  const sheetSrc = packageData?.spritesheetFilePath ? convertFileSrc(packageData.spritesheetFilePath) : "/pets/omni-pet-v3-alpha.png?v=20260506-1444";
  const cellWidth = 192;
  const cellHeight = 208;
  const atlasColumns = 8;
  const atlasRows = 9;
  const scale = Math.min(width / cellWidth, height / cellHeight);
  const scaledCellWidth = Math.round(cellWidth * scale);
  const scaledCellHeight = Math.round(cellHeight * scale);
  const scaledAtlasWidth = Math.round(cellWidth * atlasColumns * scale);
  const scaledAtlasHeight = Math.round(cellHeight * atlasRows * scale);

  useEffect(() => {
    setFrameIndex(0);
  }, [actualState]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setFrameIndex((current) => (current + 1) % frameset.frames.length);
    }, Math.round((frameset.durations[frameIndex] ?? 180) * PET_PLAYBACK_RATE));

    return () => window.clearTimeout(timeout);
  }, [frameIndex, frameset]);

  const spriteOffset = useMemo(() => {
    const column = frameset.frames[frameIndex] ?? 0;
    return {
      left: -column * cellWidth,
      top: -frameset.row * cellHeight,
    };
  }, [frameIndex, frameset]);

  return (
    <div
      className="desktop-pet"
      style={{
        width,
        height,
      }}
    >
      <div
        className="desktop-pet__viewport"
        style={{
          width: scaledCellWidth,
          height: scaledCellHeight,
          background: "transparent",
        }}
      >
        <img
          src={sheetSrc}
          alt=""
          className="desktop-pet__atlas"
          draggable={false}
          style={{
            left: spriteOffset.left * scale,
            top: spriteOffset.top * scale,
            width: scaledAtlasWidth,
            height: scaledAtlasHeight,
            minWidth: scaledAtlasWidth,
            minHeight: scaledAtlasHeight,
          }}
        />
      </div>
    </div>
  );
}
