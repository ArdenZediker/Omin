import { useEffect, useMemo, useState } from "react";
import { OMNI_SCHNAUZER_PET, type DesktopPetAction } from "../config/pets/omniSchnauzer";

type DesktopPetProps = {
  width: number;
  height: number;
  state: DesktopPetAction;
};

const PET_MANIFEST = OMNI_SCHNAUZER_PET;
const PET_PLAYBACK_RATE = 1.55;

export default function DesktopPet({ width, height, state }: DesktopPetProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const actualState = state;
  const frameset = PET_MANIFEST.animations[actualState];
  const scale = Math.min(width / PET_MANIFEST.cellWidth, height / PET_MANIFEST.cellHeight);
  const scaledCellWidth = Math.round(PET_MANIFEST.cellWidth * scale);
  const scaledCellHeight = Math.round(PET_MANIFEST.cellHeight * scale);
  const scaledAtlasWidth = Math.round(PET_MANIFEST.cellWidth * PET_MANIFEST.atlasColumns * scale);
  const scaledAtlasHeight = Math.round(PET_MANIFEST.cellHeight * PET_MANIFEST.atlasRows * scale);

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
      left: -column * PET_MANIFEST.cellWidth,
      top: -frameset.row * PET_MANIFEST.cellHeight,
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
          src={PET_MANIFEST.spritesheetSrc}
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
