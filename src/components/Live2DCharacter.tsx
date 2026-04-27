import { useEffect, useRef } from "react";

type Live2DCharacterProps = {
  width: number;
  height: number;
  model: "hiyori" | "natori";
};

declare global {
  interface Window {
    PIXI?: any;
    __omniLive2DScripts?: Promise<void>;
  }
}

const LIVE2D_SCRIPT_PATHS = [
  "/live2d/pixi.js",
  "/live2d/live2dcubismcore.min.js",
  "/live2d/cubism4.min.js",
];

const LIVE2D_RENDER_RESOLUTION = Math.min((window.devicePixelRatio || 1) * 2, 4);
const MODEL_PATHS = {
  hiyori: "/live2d-resources/hiyori_pro_zh/runtime/hiyori_pro_t11.model3.json",
  natori: "/live2d-resources/natori_pro_zh/runtime/natori_pro_t06.model3.json",
} as const;
const MODEL_MOTIONS = {
  hiyori: {
    tap: "Tap",
    idleSequence: ["Idle", "Flick", "FlickUp"],
  },
  natori: {
    tap: "Tap",
    idleSequence: ["Idle", "Tap@Head", "Flick@Body"],
  },
} as const;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.head.appendChild(script);
  });
}

async function ensureLive2DScripts() {
  if (!window.__omniLive2DScripts) {
    window.__omniLive2DScripts = LIVE2D_SCRIPT_PATHS.reduce(
      (promise, src) => promise.then(() => loadScript(src)),
      Promise.resolve()
    );
  }

  await window.__omniLive2DScripts;
}

export default function Live2DCharacter({ width, height, model }: Live2DCharacterProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const appRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const idleTimerRef = useRef<number | null>(null);
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null);

  const playMotion = (motionName: string) => {
    try {
      modelRef.current?.motion?.(motionName);
    } catch {
      // 忽略个别模型不支持的动作名。
    }
  };

  useEffect(() => {
    let disposed = false;

    const mount = async () => {
      await ensureLive2DScripts();
      if (disposed || !canvasRef.current || !window.PIXI?.live2d?.Live2DModel) return;

      const app = new window.PIXI.Application({
        view: canvasRef.current,
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: LIVE2D_RENDER_RESOLUTION,
      });

      appRef.current = app;

      const live2dModel = await window.PIXI.live2d.Live2DModel.from(MODEL_PATHS[model]);
      if (disposed) {
        live2dModel.destroy?.();
        app.destroy(true, true);
        return;
      }

      app.stage.addChild(live2dModel);
      modelRef.current = live2dModel;
      const bounds = live2dModel.getLocalBounds?.() ?? { width: live2dModel.width, height: live2dModel.height };
      naturalSizeRef.current = {
        width: Math.max(1, bounds.width || live2dModel.width),
        height: Math.max(1, bounds.height || live2dModel.height),
      };

      const fitScale = Math.min(
        (width * 0.92) / naturalSizeRef.current.width,
        (height * 0.92) / naturalSizeRef.current.height
      );
      live2dModel.scale.set(fitScale);
      live2dModel.x = (width - live2dModel.width) * 0.5;
      live2dModel.y = height - live2dModel.height;
      live2dModel.interactive = true;
      live2dModel.buttonMode = true;
      live2dModel.on("pointertap", () => {
        playMotion(MODEL_MOTIONS[model].tap);
      });
      playMotion("Idle");
      idleTimerRef.current = window.setInterval(() => {
        const motions = MODEL_MOTIONS[model].idleSequence;
        playMotion(motions[Math.floor(Math.random() * motions.length)]);
      }, 9000);
    };

    void mount();

    return () => {
      disposed = true;
      if (idleTimerRef.current !== null) {
        window.clearInterval(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      naturalSizeRef.current = null;
      modelRef.current?.destroy?.();
      modelRef.current = null;
      appRef.current?.destroy?.(true, true);
      appRef.current = null;
    };
  }, [model]);

  useEffect(() => {
    const app = appRef.current;
    const model = modelRef.current;
    const naturalSize = naturalSizeRef.current;
    if (!app || !model || !naturalSize) return;

    app.renderer.resize(width, height);
    const fitScale = Math.min((width * 0.92) / naturalSize.width, (height * 0.92) / naturalSize.height);
    model.scale.set(fitScale);
    model.x = (width - model.width) * 0.5;
    model.y = height - model.height;
  }, [width, height]);

  return <canvas ref={canvasRef} className="compact-live2d" />;
}
