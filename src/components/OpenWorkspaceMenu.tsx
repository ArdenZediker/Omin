import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow, ChevronDown, LoaderCircle } from "lucide-react";
import {
  getWorkspaceOpenAppIcon,
  listWorkspaceOpenApps,
  openWorkspaceWith,
  type WorkspaceOpenApp,
} from "../app/storageApi";

type OpenWorkspaceMenuProps = {
  workspacePath: string;
  onError: (message: string) => void;
};

const CHOICE_STORAGE_KEY = "omni.open-workspace.choice";
const FALLBACK_APP: WorkspaceOpenApp = {
  id: "explorer",
  name: "文件资源管理器",
};

type AppIconProps = {
  className?: string;
};

function ExplorerIcon({ className }: AppIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.25 6.2A2.2 2.2 0 0 1 4.45 4h4.08c.58 0 1.13.23 1.54.64l1.42 1.42h8.06a2.2 2.2 0 0 1 2.2 2.2v.99H2.25V6.2Z"
        fill="#F6B81E"
      />
      <path
        d="M2.25 8h19.5v9.55a2.2 2.2 0 0 1-2.2 2.2H4.45a2.2 2.2 0 0 1-2.2-2.2V8Z"
        fill="#FFD24A"
      />
      <path
        d="M2.25 10.35c0-.75.61-1.35 1.35-1.35h16.8c.75 0 1.35.6 1.35 1.35v7.45a2.2 2.2 0 0 1-2.2 2.2H4.45a2.2 2.2 0 0 1-2.2-2.2v-7.45Z"
        fill="#2F8BF0"
      />
      <path
        d="M2.25 10.35c0-.75.61-1.35 1.35-1.35h16.8c.75 0 1.35.6 1.35 1.35v.7H2.25v-.7Z"
        fill="#69B3FF"
      />
    </svg>
  );
}

function VsCodeIcon({ className }: AppIconProps) {
  const mark =
    "M70.9119 99.3171C72.4869 99.9307 74.2828 99.8914 75.8725 99.1264L96.4608 89.2197C98.6242 88.1787 100 85.9892 100 83.5872V16.4133C100 14.0113 98.6243 11.8218 96.4609 10.7808L75.8725.873756C73.7862-.130129 71.3446.11576 69.5135 1.44695 69.252 1.63711 69.0028 1.84943 68.769 2.08341L29.3551 38.0415 12.1872 25.0096C10.589 23.7965 8.35363 23.8959 6.86933 25.2461L1.36303 30.2549C-.452552 31.9064-.454633 34.7627 1.35853 36.417L16.2471 50.0001 1.35853 63.5832C-.454633 65.2374-.452552 68.0938 1.36303 69.7453L6.86933 74.7541C8.35363 76.1043 10.589 76.2037 12.1872 74.9905L29.3551 61.9587 68.769 97.9167C69.3925 98.5406 70.1246 99.0104 70.9119 99.3171ZM75.0152 27.2989 45.1091 50.0001 75.0152 72.7012V27.2989Z";

  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id="vscode-mark-clip">
          <path d={mark} clipRule="evenodd" />
        </clipPath>
      </defs>
      <g clipPath="url(#vscode-mark-clip)">
        <path
          d="M96.4614 10.7962 75.8569.875542C73.4719-.272773 70.6217.211611 68.75 2.08333L1.29858 63.5832C-.515693 65.2373-.513607 68.0937 1.30308 69.7452L6.81272 74.754C8.29793 76.1042 10.5347 76.2036 12.1338 74.9905L93.3609 13.3699C96.086 11.3026 100 13.2462 100 16.6667V16.4275C100 14.0265 98.6246 11.8378 96.4614 10.7962Z"
          fill="#0065A9"
        />
        <path
          d="M96.4614 89.2038 75.8569 99.1245C73.4719 100.273 70.6217 99.7884 68.75 97.9167L1.29858 36.4169C-.515693 34.7627-.513607 31.9063 1.30308 30.2548L6.81272 25.246C8.29793 23.8958 10.5347 23.7964 12.1338 25.0095L93.3609 86.6301C96.086 88.6974 100 86.7538 100 83.3334V83.5726C100 85.9735 98.6246 88.1622 96.4614 89.2038Z"
          fill="#007ACC"
        />
        <path
          d="M75.8578 99.1263C73.4721 100.274 70.6219 99.7885 68.75 97.9166 71.0564 100.223 75 98.5895 75 95.3278V4.67213C75 1.41039 71.0564-.223106 68.75 2.08329 70.6219.211402 73.4721-.273666 75.8578.873633L96.4587 10.7807C98.6234 11.8217 100 14.0112 100 16.4132V83.5871C100 85.9891 98.6234 88.1786 96.4586 89.2196L75.8578 99.1263Z"
          fill="#1F9CF0"
        />
      </g>
    </svg>
  );
}

function IntellijIcon({ className }: AppIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id="intellij-warm-gradient"
          x1="-.717383"
          x2="24.1455"
          y1="7.61946"
          y2="61.2456"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".1" stopColor="#FC801D" />
          <stop offset=".59" stopColor="#FE2857" />
        </linearGradient>
        <linearGradient
          id="intellij-cool-gradient"
          x1="4.22243"
          x2="62.9273"
          y1="60.0186"
          y2="1.31316"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".21" stopColor="#FE2857" />
          <stop offset=".7" stopColor="#007EFF" />
        </linearGradient>
      </defs>
      <path
        fill="#FF8100"
        d="m15.9476 5.81641-11.87545.00174C1.82284 5.81815 0 7.64157 0 9.89088V21.3975c0 1.1887.519564 2.3185 1.42196 3.0924L39.5828 57.1997c.7384.6324 1.6786.9803 2.6508.9803h11.8755c2.2493 0 4.0727-1.8234 4.0727-4.0727V42.599c0-1.1887-.5195-2.3186-1.4219-3.0924L18.599 6.79735c-.7383-.63302-1.6786-.98036-2.6514-.98036v-.00058Z"
      />
      <path
        fill="url(#intellij-warm-gradient)"
        d="M14.5193 5.81641H4.07273C1.82342 5.81641 0 7.63982 0 9.88913V22.9818c0 .1926.013964.3852.040727.576L5.31782 60.5015c.28683 2.0067 2.00494 3.4967 4.032 3.4967H25.0228c2.2499 0 4.0733-1.824 4.0728-4.0739l-.0047-18.5384c0-.4376-.0704-.8722-.2089-1.287L18.3825 8.60099c-.5544-1.66284-2.1108-2.78458-3.8638-2.78458h.0006Z"
      />
      <path
        fill="url(#intellij-cool-gradient)"
        d="M59.9275 0H25.9592c-1.6291 0-3.1017.971054-3.7435 2.46807L6.14767 39.9587c-.21702.5068-.32931 1.0531-.32931 1.6046v18.364C5.81836 62.1766 7.64178 64 9.89109 64H27.8571c.8046 0 1.5912-.2385 2.2609-.6854l32.0687-21.4033c1.1322-.7552 1.8117-2.0265 1.8117-3.3874l.0018-34.45117C64.0002 1.82342 62.1768 0 59.9275 0Z"
      />
      <path fill="#000" d="M52 12H12v40h40V12Z" />
      <path
        fill="#fff"
        d="M17 29.3856h2.9788v-9.7712H17V17h8.839v2.6144h-2.9788v9.7712h2.9788V32H17v-2.6144Z"
      />
      <path
        fill="#fff"
        d="M27.3389 29.3002h2.1538c.4354 0 .8233-.0928 1.1625-.2784.3392-.1857.6016-.4481.7872-.7873.1857-.3392.2785-.7265.2785-1.1625V17h2.9249v10.2748c0 .9001-.2074 1.7092-.6216 2.4271-.4143.7179-.9855 1.2805-1.7143 1.6873-.7.4074-1.5465.6108-2.4535.6108h-2.5175v-2.6998Z"
      />
      <path fill="#fff" d="M17 44h16v3H17v-3Z" />
    </svg>
  );
}

function PyCharmIcon({ className }: AppIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id="pycharm-warm-gradient"
          x1="7.62141"
          x2="61.2476"
          y1="64.7192"
          y2="39.8558"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".1" stopColor="#00D886" />
          <stop offset=".59" stopColor="#F0EB18" />
        </linearGradient>
        <linearGradient
          id="pycharm-cool-gradient"
          x1="60.0186"
          x2="1.31317"
          y1="59.7778"
          y2="1.07229"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".3" stopColor="#F0EB18" />
          <stop offset=".7" stopColor="#00C4F4" />
        </linearGradient>
      </defs>
      <path
        fill="#00D886"
        d="m5.81934 48.0512.00174 11.8755c0 2.2493 1.82342 4.0721 4.07273 4.0721H21.4004c1.1887 0 2.3186-.5196 3.0924-1.422L57.202 24.4154c.6325-.7383.9804-1.6786.9804-2.6508V9.88913c0-2.24931-1.8234-4.07272-4.0727-4.07272H42.6013c-1.1887 0-2.3185.51956-3.0924 1.42196L6.7997 45.3998c-.63302.7384-.98036 1.6786-.98036 2.6514Z"
      />
      <path
        fill="url(#pycharm-warm-gradient)"
        d="M5.81836 49.4825v10.4466c0 2.2493 1.82342 4.0727 4.07273 4.0727H22.9837c.1926 0 .3852-.0139.576-.0407l36.9438-5.2771c2.0066-.2868 3.4967-2.0049 3.4967-4.032V38.979c0-2.2499-1.824-4.0733-4.0739-4.0727l-18.5385.0046c-.4375 0-.8721.0704-1.287.2089L8.60294 45.6193c-1.66284.5544-2.78458 2.1108-2.78458 3.8638v-.0006Z"
      />
      <path
        fill="url(#pycharm-cool-gradient)"
        d="M0 4.07273V38.041c0 1.6291.971054 3.1017 2.46807 3.7434L39.9587 57.8525c.5068.217 1.0531.3293 1.6046.3293h18.364c2.2493 0 4.0727-1.8234 4.0727-4.0727v-17.966c0-.8046-.2385-1.5912-.6854-2.2609L41.9119 1.81353C41.1561.681309 39.8854.001745 38.5245.001745L4.07273 0C1.82342 0 0 1.82342 0 4.07273Z"
      />
      <path fill="#000" d="M52 12H12v40h40V12Z" />
      <path
        fill="#fff"
        fillRule="evenodd"
        d="M23.5363 16.9676h-6.4407v15.0055h2.9261v-5.6702h3.4296c1.0715 0 2.0115-.1929 2.8188-.5788.8148-.3927 1.4401-.9434 1.8759-1.6508.4427-.7074.6643-1.5434.6643-2.465 0-.9216-.2182-1.7324-.654-2.4329-.4289-.7005-1.0433-1.2431-1.8437-1.629-.8005-.3859-1.7261-.5788-2.7763-.5788Zm1.0927 6.6349c-.3646.1785-.7929.2681-1.2862.2681h-3.3229v-4.4695h3.3229c.4933 0 .9216.0924 1.2862.2784.3715.178.6569.4353.8573.7718.2004.3278.3003.7286.3003 1.1788 0 .4502-.1005.8469-.3003 1.1897-.1998.3365-.4858.5966-.8573.7827Z"
        clipRule="evenodd"
      />
      <path
        fill="#fff"
        d="M33.3821 31.2232c1.1651.6713 2.4656 1.0077 3.9017 1.0077v-.0011c1.2144 0 2.3295-.2251 3.3441-.6753 1.0146-.4501 1.8575-1.0783 2.5294-1.8862.6787-.8148 1.1328-1.7473 1.3614-2.7975H41.453c-.2004.5426-.5001 1.0221-.9003 1.4361-.3933.4076-.8688.7223-1.4257.9434-.557.221-1.1645.3324-1.822.3324-.886 0-1.6864-.221-2.4007-.6643-.7149-.4433-1.2759-1.0502-1.683-1.8219-.4002-.7781-.6-1.6543-.6-2.6259 0-.9715.1998-1.8437.6-2.6154.4077-.7786.9681-1.3896 1.683-1.8329.7143-.4432 1.5147-.6643 2.4007-.6643.6569 0 1.2644.1114 1.822.3325.5575.221 1.0324.5397 1.4257.9537.4002.4077.6999.8831.9003 1.4257h3.0657c-.2291-1.0502-.6827-1.9787-1.3614-2.7866-.6719-.8147-1.5148-1.4469-2.5294-1.8971-1.0146-.4502-2.1297-.6753-3.3441-.6753-1.4367 0-2.7372.3388-3.9017 1.0181-1.165.6712-2.0797 1.6009-2.7441 2.7866-.6643 1.1788-.9968 2.4972-.9968 3.955 0 1.4579.3325 2.7803.9968 3.966.6649 1.1789 1.5791 2.1073 2.7441 2.7866Z"
      />
      <path fill="#fff" d="M16.9941 44.001h16v3h-16v-3Z" />
    </svg>
  );
}

function EditorIcon({
  appId,
  className = "open-workspace-menu__app-icon",
}: {
  appId: string;
  className?: string;
}) {
  if (appId === "explorer") return <ExplorerIcon className={className} />;
  if (appId === "vscode" || appId === "vscodeinsiders") {
    return <VsCodeIcon className={className} />;
  }
  if (appId === "intellij") return <IntellijIcon className={className} />;
  if (appId === "pycharm") return <PyCharmIcon className={className} />;
  return <AppWindow className={className} size={18} strokeWidth={1.8} />;
}

export default function OpenWorkspaceMenu({
  workspacePath,
  onError,
}: OpenWorkspaceMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [isLoadingApps, setIsLoadingApps] = useState(true);
  const [apps, setApps] = useState<WorkspaceOpenApp[]>([FALLBACK_APP]);
  const [choice, setChoice] = useState(() => {
    try {
      return localStorage.getItem(CHOICE_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const iconRequestsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  const preferred =
    apps.find((app) => app.id === choice) ?? apps[0] ?? FALLBACK_APP;

  const loadIcon = useCallback(async (appId: string, force = false) => {
    if (!appId || (!force && iconRequestsRef.current.has(appId))) return;
    iconRequestsRef.current.add(appId);
    try {
      const icon = await getWorkspaceOpenAppIcon(appId);
      if (mountedRef.current) {
        setIcons((current) => ({ ...current, [appId]: icon }));
      }
    } catch {
      if (mountedRef.current) {
        setIcons((current) => ({ ...current, [appId]: null }));
      }
    }
  }, []);

  const loadApps = useCallback(async () => {
    setIsLoadingApps(true);
    try {
      const available = await listWorkspaceOpenApps();
      if (!mountedRef.current) return;
      if (available.length > 0) {
        setApps(available);
      }
    } catch {
      // The native Explorer fallback stays available when discovery cannot run.
    } finally {
      if (mountedRef.current) setIsLoadingApps(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadApps();
    return () => {
      mountedRef.current = false;
    };
  }, [loadApps]);

  useEffect(() => {
    void loadIcon(preferred.id);
  }, [loadIcon, preferred.id]);

  useEffect(() => {
    if (!workspacePath) setIsOpen(false);
  }, [workspacePath]);

  useEffect(() => {
    if (!isOpen) return;
    void Promise.all(apps.map((app) => loadIcon(app.id)));
  }, [apps, isOpen, loadIcon]);

  useEffect(() => {
    if (!isOpen) return;
    const firstItem =
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    firstItem?.focus();

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [isOpen]);

  const run = useCallback(
    async (app: WorkspaceOpenApp) => {
      if (!workspacePath || isOpening) return;
      setIsOpening(true);
      try {
        await openWorkspaceWith(workspacePath, app.id);
        setChoice(app.id);
        try {
          localStorage.setItem(CHOICE_STORAGE_KEY, app.id);
        } catch {
          // The current choice still applies for this session.
        }
        setIsOpen(false);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsOpening(false);
      }
    },
    [isOpening, onError, workspacePath],
  );

  const handleMenuKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        currentIndex < 0
          ? event.key === "ArrowDown"
            ? 0
            : items.length - 1
          : (currentIndex + offset + items.length) % items.length;
      items[nextIndex]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      setIsOpen(false);
    }
  };

  if (!workspacePath) return null;

  const preferredIcon = icons[preferred.id];

  return (
    <div ref={rootRef} className="open-workspace-menu">
      <button
        type="button"
        className="main-chat-toolbar__icon-button open-workspace-menu__main"
        aria-label={`用 ${preferred.name} 打开项目`}
        title={`用 ${preferred.name} 打开项目`}
        disabled={isOpening || isLoadingApps}
        onClick={() => void run(preferred)}
      >
        {preferredIcon ? (
          <img
            className="open-workspace-menu__toolbar-icon"
            src={preferredIcon}
            alt=""
            draggable={false}
          />
        ) : isLoadingApps ? (
          <LoaderCircle
            className="open-workspace-menu__toolbar-icon open-workspace-menu__spinner"
            size={17}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        ) : (
          <EditorIcon
            appId={preferred.id}
            className="open-workspace-menu__toolbar-icon"
          />
        )}
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="open-workspace-menu__toggle"
        aria-label="选择打开方式"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="选择打开方式"
        disabled={isOpening}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setIsOpen(true);
        }}
      >
        <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          className="open-workspace-menu__dropdown"
          role="menu"
          aria-label="打开项目位置"
          onKeyDown={handleMenuKeyDown}
        >
          {apps.map((app) => (
            <button
              key={app.id}
              type="button"
              role="menuitem"
              disabled={isOpening}
              onClick={() => void run(app)}
            >
              {icons[app.id] ? (
                <img
                  className="open-workspace-menu__app-icon"
                  src={icons[app.id] ?? ""}
                  alt=""
                  draggable={false}
                />
              ) : (
                <EditorIcon appId={app.id} />
              )}
              <span>
                {app.name}
                {app.id === preferred.id ? "（默认）" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
