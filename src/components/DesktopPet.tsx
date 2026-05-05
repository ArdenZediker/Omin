import { useEffect, useMemo, useRef, useState } from "react";
import { OMNI_SCHNAUZER_PET, type DesktopPetAction } from "../config/pets/omniSchnauzer";

type DesktopPetProps = {
  width: number;
  height: number;
  state: DesktopPetAction;
};

const PET_MANIFEST = OMNI_SCHNAUZER_PET;

function getCycleDuration(action: DesktopPetAction) {
  return PET_MANIFEST.animations[action].durations.reduce((sum, duration) => sum + duration, 0);
}

function getRandomAmbientAction() {
  const actions = PET_MANIFEST.ambientActions;
  return actions[Math.floor(Math.random() * actions.length)] ?? "idle";
}

export default function DesktopPet({ width, height, state }: DesktopPetProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const [ambientState, setAmbientState] = useState<DesktopPetAction>("idle");
  const ambientTimerRef = useRef<number | null>(null);
  const actualState = state === "idle" ? ambientState : state;
  const frameset = PET_MANIFEST.animations[actualState];
  const scale = Math.min(width / PET_MANIFEST.cellWidth, height / PET_MANIFEST.cellHeight);

  useEffect(() => {
    setFrameIndex(0);
  }, [actualState]);

  useEffect(() => {
    if (state !== "idle") {
      setAmbientState("idle");
      if (ambientTimerRef.current !== null) {
        window.clearTimeout(ambientTimerRef.current);
        ambientTimerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    const scheduleNext = () => {
      const nextState = getRandomAmbientAction();
      const idleDelay =
        PET_MANIFEST.ambientDelayMs.min +
        Math.random() * (PET_MANIFEST.ambientDelayMs.max - PET_MANIFEST.ambientDelayMs.min);
      ambientTimerRef.current = window.setTimeout(() => {
        if (cancelled) return;
        setAmbientState(nextState);
        ambientTimerRef.current = window.setTimeout(() => {
          if (cancelled) return;
          setAmbientState("idle");
          scheduleNext();
        }, getCycleDuration(nextState));
      }, idleDelay);
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (ambientTimerRef.current !== null) {
        window.clearTimeout(ambientTimerRef.current);
        ambientTimerRef.current = null;
      }
    };
  }, [state]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setFrameIndex((current) => (current + 1) % frameset.frames.length);
    }, frameset.durations[frameIndex] ?? 140);

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
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
      >
        <img
          src={PET_MANIFEST.spritesheetSrc}
          alt=""
          className="desktop-pet__atlas"
          draggable={false}
          style={{
            left: spriteOffset.left,
            top: spriteOffset.top,
            width: PET_MANIFEST.cellWidth * PET_MANIFEST.atlasColumns,
            height: PET_MANIFEST.cellHeight * PET_MANIFEST.atlasRows,
            minWidth: PET_MANIFEST.cellWidth * PET_MANIFEST.atlasColumns,
            minHeight: PET_MANIFEST.cellHeight * PET_MANIFEST.atlasRows,
          }}
        />
      </div>
    </div>
  );
}
