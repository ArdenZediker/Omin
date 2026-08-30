import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Bot,
  FolderOpen,
  Grid2x2,
  MessageSquare,
  Mic,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  PlaySquare,
  SquarePlus,
  Search,
  Settings,
  Sparkles,
  FileImage as LucideFileImage,
  FileText as LucideFileText,
} from "lucide-react";
import type {
  KnowledgeCollection,
  KnowledgeProcessingDeadLetter,
  KnowledgeDocumentDetail,
  KnowledgeLibraryPayload,
  KnowledgePipelineSettings,
  KnowledgeProcessingStatusSummary,
  PipelineImportResult,
  ReplayDeadLettersResult,
  RetryFailedJobsResult,
} from "../chat/knowledgeTypes";
import {
  getKnowledgeMultimodalModelsByCapability,
  loadKnowledgeMultimodalConfig,
  type KnowledgeCollectionMultimodalConfig,
  type KnowledgeMultimodalConfig,
} from "../chat/knowledgeMultimodal";
import { usePromptDialog } from "./PromptDialog";
import KnowledgeBaseDetailBoundary from "./knowledge/KnowledgeBaseDetailBoundary";
import {
  createCollectionSettingsDraft,
  getKnowledgeUploadBlockMessage,
  type CollectionSettingsDraft,
} from "./knowledge/knowledgeCollectionConfig";
import { renderHighlightedSearchText } from "./knowledge/knowledgeHighlight";
import {
  createImageKnowledgeContent,
  createThumbnailDataUrl,
  createThumbnailDataUrlFromContent,
} from "./knowledge/knowledgeThumbnail";
import {
  loadKnowledgeDocumentBinary,
  loadKnowledgeDocumentDetail,
  loadKnowledgeLibrary,
  loadKnowledgePipelineSettings,
  loadKnowledgeProcessingDeadLetters,
  loadKnowledgeProcessingStatusSummary,
  saveKnowledgePipelineSettings,
} from "./knowledge/knowledgeApi";
import { convertDocxBytesToText, convertPdfBytesToText } from "./knowledge/knowledgeFileConversion";
import KnowledgeAssetInspector from "./knowledge/KnowledgeAssetInspector";
import KnowledgeCollectionSidebar from "./knowledge/KnowledgeCollectionSidebar";
import type { KnowledgeSidebarCategory } from "./knowledge/KnowledgeCollectionSidebar";
import KnowledgeDocumentChunksPanel from "./knowledge/KnowledgeDocumentChunksPanel";
import KnowledgeDocumentDetailHeader from "./knowledge/KnowledgeDocumentDetailHeader";
import type { KnowledgeDocumentDetailView } from "./knowledge/KnowledgeDocumentDetailHeader";
import KnowledgeDocumentList from "./knowledge/KnowledgeDocumentList";
import KnowledgeDocumentProcessingPanel from "./knowledge/KnowledgeDocumentProcessingPanel";
import KnowledgeDocumentPreview from "./knowledge/KnowledgeDocumentPreview";
import KnowledgeTaskCenterPanel from "./knowledge/KnowledgeTaskCenterPanel";
import type { KnowledgeDeadLetterStatusFilter, KnowledgeTaskCenterScope } from "./knowledge/KnowledgeTaskCenterPanel";
import OmniSelect from "./ui/OmniSelect";
import OmniSwitch from "./ui/OmniSwitch";
import {
  KNOWLEDGE_UPLOAD_ACCEPT,
  classifyResource,
  formatTimestamp,
  getExtension,
  getPreviewKindFromFile,
  normalizeSearchText,
  openFilePicker,
} from "./knowledge/knowledgeViewHelpers";

type KnowledgeBaseViewProps = {
  onSettingsOpen: () => void;
  onBackToChat: () => void;
  onOpenMarketplace?: () => void;
  windowControls?: ReactNode;
};

type KnowledgePageMode = "empty" | "list" | "detail";
type UploadNotice = {
  tone: "success" | "error";
  message: string;
};
const UPLOAD_NOTICE_AUTO_DISMISS_MS = 4000;
const CATEGORIES: Omit<KnowledgeSidebarCategory, "count">[] = [
  { id: "all", title: "全部文件", description: "当前知识库中的全部文档", icon: Grid2x2 },
  { id: "docs", title: "文档", description: "Markdown、PDF、Word、文本", icon: LucideFileText },
  { id: "images", title: "图片", description: "图片类资源", icon: LucideFileImage },
  { id: "audio", title: "音频", description: "音频类资源", icon: Mic },
  { id: "video", title: "视频", description: "视频类资源", icon: PlaySquare },
];

export default function KnowledgeBaseView({ onSettingsOpen, onBackToChat, onOpenMarketplace, windowControls }: KnowledgeBaseViewProps) {
  const { openPrompt } = usePromptDialog();
  const [activeCategory, setActiveCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [chunkSearchQuery, setChunkSearchQuery] = useState("");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isUploadMenuOpen, setIsUploadMenuOpen] = useState(false);
  const [isCollectionMenuOpen, setIsCollectionMenuOpen] = useState<string | null>(null);
  const [isDocumentMenuOpen, setIsDocumentMenuOpen] = useState<string | null>(null);
  const [createCollectionError, setCreateCollectionError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<UploadNotice | null>(null);
  const [library, setLibrary] = useState<KnowledgeLibraryPayload>({ collections: [], documents: [] });
  const [isKnowledgeLibraryReady, setIsKnowledgeLibraryReady] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>("");
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [selectedDocumentDetail, setSelectedDocumentDetail] = useState<KnowledgeDocumentDetail | null>(null);
  const [selectedDocumentDetailView, setSelectedDocumentDetailView] = useState<KnowledgeDocumentDetailView>("preview");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [isLoadingDocumentDetail, setIsLoadingDocumentDetail] = useState(false);
  const [documentDetailError, setDocumentDetailError] = useState<string | null>(null);
  const [globalTaskSummary, setGlobalTaskSummary] = useState<KnowledgeProcessingStatusSummary>({
    scope: "global",
    collectionId: null,
    queued: 0,
    running: 0,
    failed: 0,
  });
  const [activeCollectionTaskSummary, setActiveCollectionTaskSummary] = useState<KnowledgeProcessingStatusSummary>({
    scope: "collection",
    collectionId: null,
    queued: 0,
    running: 0,
    failed: 0,
  });
  const [taskCenterError, setTaskCenterError] = useState<string | null>(null);
  const [taskCenterNotice, setTaskCenterNotice] = useState<string | null>(null);
  const [isTaskCenterBusy, setIsTaskCenterBusy] = useState(false);
  const [globalDeadLetterCount, setGlobalDeadLetterCount] = useState(0);
  const [activeCollectionDeadLetterCount, setActiveCollectionDeadLetterCount] = useState(0);
  const [pipelineSettings, setPipelineSettings] = useState<KnowledgePipelineSettings | null>(null);
  const [isSavingPipelineSettings, setIsSavingPipelineSettings] = useState(false);
  const [knowledgeMultimodalConfig, setKnowledgeMultimodalConfig] = useState<KnowledgeMultimodalConfig>(loadKnowledgeMultimodalConfig);
  const [isCollectionSettingsOpen, setIsCollectionSettingsOpen] = useState(false);
  const [editingCollection, setEditingCollection] = useState<KnowledgeCollection | null>(null);
  const [collectionSettingsDraft, setCollectionSettingsDraft] = useState<CollectionSettingsDraft | null>(null);
  const [collectionSettingsError, setCollectionSettingsError] = useState<string | null>(null);
  const [isSavingCollectionSettings, setIsSavingCollectionSettings] = useState(false);
  const [deadLetterScope, setDeadLetterScope] = useState<KnowledgeTaskCenterScope>("activeCollection");
  const [deadLetterStatusFilter, setDeadLetterStatusFilter] = useState<KnowledgeDeadLetterStatusFilter>("failed");
  const [deadLetterItems, setDeadLetterItems] = useState<KnowledgeProcessingDeadLetter[]>([]);
  const [deadLetterTotal, setDeadLetterTotal] = useState(0);
  const [deadLetterPage, setDeadLetterPage] = useState(1);
  const [isDeadLetterLoading, setIsDeadLetterLoading] = useState(false);
  const [deadLetterReplayBusyId, setDeadLetterReplayBusyId] = useState<string | null>(null);
  const [isTaskSettingsOpen, setIsTaskSettingsOpen] = useState(false);
  const [expandedDeadLetterId, setExpandedDeadLetterId] = useState<string | null>(null);
  const [isTaskCenterPanelOpen, setIsTaskCenterPanelOpen] = useState(false);
  const [isSearchToolbarOpen, setIsSearchToolbarOpen] = useState(false);
  const settingsSaveTimerRef = useRef<number | null>(null);
  const uploadNoticeTimerRef = useRef<number | null>(null);
  const pendingPipelineSettingsRef = useRef<KnowledgePipelineSettings | null>(null);
  const isSavingPipelineSettingsRef = useRef(false);
  const deadLetterListRequestSeqRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const uploadMenuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const chunkSearchInputRef = useRef<HTMLInputElement | null>(null);
  const activeCollection = useMemo(() => {
    if (selectedCollectionId) {
      const selected = library.collections.find((collection) => collection.id === selectedCollectionId);
      if (selected) {
        return selected;
      }
    }

    return library.collections[0] ?? null;
  }, [library.collections, selectedCollectionId]);
  const imageMultimodalModels = useMemo(
    () => getKnowledgeMultimodalModelsByCapability(knowledgeMultimodalConfig, "image"),
    [knowledgeMultimodalConfig]
  );
  const audioMultimodalModels = useMemo(
    () => getKnowledgeMultimodalModelsByCapability(knowledgeMultimodalConfig, "audio"),
    [knowledgeMultimodalConfig]
  );

  const activeCollectionDocuments = useMemo(() => {
    if (!activeCollection) {
      return [];
    }
    return library.documents.filter((document) => document.collectionId === activeCollection.id);
  }, [activeCollection?.id, library.documents]);

  const selectedDocumentRecord = useMemo(
    () => (selectedDocumentId ? library.documents.find((document) => document.id === selectedDocumentId) ?? null : null),
    [library.documents, selectedDocumentId]
  );

  const selectedDocument = selectedDocumentDetail?.document ?? selectedDocumentRecord;
  const activeCollectionName = activeCollection?.name ?? "未选择知识库";
  const documentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const document of library.documents) {
      map.set(document.id, document.sourceName);
    }
    return map;
  }, [library.documents]);
  const selectedDocumentCollectionName = useMemo(() => {
    if (!selectedDocument) {
      return activeCollectionName;
    }
    return (
      library.collections.find((collection) => collection.id === selectedDocument.collectionId)?.name ??
      "未命名知识库"
    );
  }, [activeCollectionName, library.collections, selectedDocument]);
  const selectedDocumentCollection = useMemo(() => {
    if (!selectedDocument) {
      return activeCollection;
    }
    return library.collections.find((collection) => collection.id === selectedDocument.collectionId) ?? null;
  }, [activeCollection, library.collections, selectedDocument]);
  const pageMode: KnowledgePageMode = selectedDocumentId ? "detail" : activeCollectionDocuments.length > 0 ? "list" : "empty";
  const taskCounts = globalTaskSummary;
  const activeCollectionTaskCounts = activeCollectionTaskSummary;
  const deadLetterPageSize = 6;

  const activeCategories = useMemo(() => {
    const counts = { all: activeCollectionDocuments.length, docs: 0, images: 0, audio: 0, video: 0 };
    for (const document of activeCollectionDocuments) {
      const categoryId = classifyResource(document.sourceName, document.sourcePath);
      counts[categoryId as keyof typeof counts] += 1;
    }

    return CATEGORIES.map((category) => ({
      ...category,
      count: counts[category.id as keyof typeof counts] ?? 0,
    }));
  }, [activeCollectionDocuments]);

  const activeCategoryData = useMemo(
    () => activeCategories.find((category) => category.id === activeCategory) ?? activeCategories[0],
    [activeCategory, activeCategories]
  );

  const visibleDocuments = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchQuery);
    return activeCollectionDocuments.filter((document) => {
      const documentCategory = classifyResource(document.sourceName, document.sourcePath);
      if (activeCategory !== "all" && documentCategory !== activeCategory) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return normalizeSearchText(
        [document.sourceName, document.sourcePath ?? "", document.contentPreview, document.titleHierarchy ?? "", ...(document.tags ?? [])].join(" ")
      ).includes(normalizedQuery);
    });
  }, [activeCategory, activeCollectionDocuments, searchQuery]);

  const visibleDocumentChunks = useMemo(() => {
    const chunks = selectedDocumentDetail?.chunks ?? [];
    const textChunks = chunks.filter((chunk) => (chunk.chunkType ?? "text") === "text");
    const normalizedQuery = normalizeSearchText(chunkSearchQuery);
    if (!normalizedQuery) {
      return textChunks;
    }

    return textChunks.filter((chunk) =>
      normalizeSearchText([`第 ${chunk.chunkIndex + 1} 片`, chunk.title ?? "", chunk.content].join(" ")).includes(normalizedQuery)
    );
  }, [chunkSearchQuery, selectedDocumentDetail?.chunks]);

  const selectedAsset = useMemo(
    () => selectedDocumentDetail?.assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [selectedAssetId, selectedDocumentDetail?.assets]
  );

  const textOnlyDocumentChunkCount = useMemo(
    () => selectedDocumentDetail?.chunks.filter((chunk) => (chunk.chunkType ?? "text") === "text").length ?? 0,
    [selectedDocumentDetail?.chunks]
  );

  const listThumbnailDataUrlById = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const document of visibleDocuments) {
      const previewKind = (document.previewType ?? "").toLowerCase();
      const mimeType = (document.mimeType ?? "").toLowerCase();
      const isImageDocument = previewKind === "image" || mimeType.startsWith("image/");
      if (isImageDocument) {
        map.set(document.id, document.thumbnailDataUrl ?? undefined);
        continue;
      }

      const previewSeed = [document.titleHierarchy ?? "", document.contentPreview ?? "", document.sourceName].filter(Boolean).join("\n");
      const regenerated = createThumbnailDataUrlFromContent(previewSeed);
      map.set(document.id, regenerated ?? document.thumbnailDataUrl ?? undefined);
    }
    return map;
  }, [visibleDocuments]);

  useEffect(() => {
    if (library.collections.length === 0) {
      setSelectedCollectionId("");
      return;
    }

    if (!selectedCollectionId || !library.collections.some((collection) => collection.id === selectedCollectionId)) {
      setSelectedCollectionId(library.collections[0].id);
    }
  }, [library.collections, selectedCollectionId]);

  useEffect(() => {
    if (!selectedDocumentId) {
      return;
    }

    const selectedDocument = library.documents.find((document) => document.id === selectedDocumentId);
    if (!selectedDocument || selectedDocument.collectionId !== selectedCollectionId) {
      setSelectedDocumentId(null);
      setSelectedDocumentDetail(null);
      setDocumentDetailError(null);
      setSelectedDocumentDetailView("preview");
    }
  }, [library.documents, selectedCollectionId, selectedDocumentId]);

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocumentDetail(null);
      setDocumentDetailError(null);
      setSelectedAssetId(null);
      return;
    }

    let cancelled = false;
    setIsLoadingDocumentDetail(true);
    setDocumentDetailError(null);

    void loadKnowledgeDocumentDetail(selectedDocumentId)
      .then((detail) => {
        if (!cancelled) {
          setSelectedDocumentDetail(detail);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSelectedDocumentDetail(null);
          setDocumentDetailError(error instanceof Error ? error.message : "加载文档详情失败");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingDocumentDetail(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedDocumentId]);

  useEffect(() => {
    const firstAssetId = selectedDocumentDetail?.assets[0]?.id ?? null;
    setSelectedAssetId(firstAssetId);
  }, [selectedDocumentDetail?.document.id, selectedDocumentDetail?.assets]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    void listen("omni-knowledge-multimodal-profile-changed", () => {
      setKnowledgeMultimodalConfig(loadKnowledgeMultimodalConfig());
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [payload, globalSummary] = await Promise.all([
          loadKnowledgeLibrary(),
          loadKnowledgeProcessingStatusSummary(null),
        ]);
        const initialCollectionId = payload.collections[0]?.id ?? null;
        const initialCollectionSummary = initialCollectionId
          ? await loadKnowledgeProcessingStatusSummary(initialCollectionId)
          : {
              scope: "collection" as const,
              collectionId: null,
              queued: 0,
              running: 0,
              failed: 0,
            };
        if (!cancelled) {
          setLibrary(payload);
          setGlobalTaskSummary(globalSummary);
          const settings = await loadKnowledgePipelineSettings();
          if (!cancelled) {
            setPipelineSettings(settings);
          }
          const globalDeadLetters = await loadKnowledgeProcessingDeadLetters({
            collectionId: null,
            status: "failed",
            limit: 1,
            offset: 0,
          });
          if (!cancelled) {
            setGlobalDeadLetterCount(globalDeadLetters.total);
          }
          setActiveCollectionTaskSummary(initialCollectionSummary);
          setSelectedCollectionId((current) => {
            if (!current || !payload.collections.some((collection) => collection.id === current)) {
              return payload.collections[0]?.id ?? "";
            }
            return current;
          });
          setIsKnowledgeLibraryReady(true);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setIsKnowledgeLibraryReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshProcessingJobs({ syncLibrary: true });
    }, 2500);

    return () => window.clearInterval(interval);
  }, [activeCollection?.id]);

  useEffect(() => {
    if (!isUploadMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const targetNode = event.target as Node | null;
      if (targetNode && uploadMenuRef.current?.contains(targetNode)) {
        return;
      }
      setIsUploadMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isUploadMenuOpen]);

  useEffect(() => {
    if (!isSearchToolbarOpen || searchQuery) {
      return;
    }

    const handlePointerDown = () => {
      setIsSearchToolbarOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isSearchToolbarOpen, searchQuery]);

  useEffect(() => {
    if (!isSearchToolbarOpen) {
      return;
    }
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isSearchToolbarOpen]);

  useEffect(() => {
    if (uploadNoticeTimerRef.current !== null) {
      window.clearTimeout(uploadNoticeTimerRef.current);
      uploadNoticeTimerRef.current = null;
    }

    if (!uploadNotice || uploadNotice.tone !== "success") {
      return;
    }

    uploadNoticeTimerRef.current = window.setTimeout(() => {
      setUploadNotice(null);
      uploadNoticeTimerRef.current = null;
    }, UPLOAD_NOTICE_AUTO_DISMISS_MS);

    return () => {
      if (uploadNoticeTimerRef.current !== null) {
        window.clearTimeout(uploadNoticeTimerRef.current);
        uploadNoticeTimerRef.current = null;
      }
    };
  }, [uploadNotice]);

  useEffect(() => {
    setChunkSearchQuery("");
  }, [selectedDocumentId]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && selectedDocumentId && selectedDocumentDetailView === "chunks") {
        event.preventDefault();
        chunkSearchInputRef.current?.focus();
        chunkSearchInputRef.current?.select();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedDocumentDetailView, selectedDocumentId]);

  useEffect(() => {
    if (!isCollectionMenuOpen) {
      return;
    }

    const handlePointerDown = () => setIsCollectionMenuOpen(null);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isCollectionMenuOpen]);

  useEffect(() => {
    if (!isCollectionSettingsOpen) {
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !isSavingCollectionSettings) {
        setIsCollectionSettingsOpen(false);
        setEditingCollection(null);
        setCollectionSettingsDraft(null);
        setCollectionSettingsError(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCollectionSettingsOpen, isSavingCollectionSettings]);

  useEffect(() => {
    if (!isDocumentMenuOpen) {
      return;
    }

    const handlePointerDown = () => setIsDocumentMenuOpen(null);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isDocumentMenuOpen]);

  useEffect(() => {
    deadLetterListRequestSeqRef.current += 1;
    setIsDeadLetterLoading(false);
    return () => {
      if (settingsSaveTimerRef.current) {
        window.clearTimeout(settingsSaveTimerRef.current);
        settingsSaveTimerRef.current = null;
      }
    };
  }, []);

  async function refreshLibrary() {
    const [payload, globalSummary] = await Promise.all([
      loadKnowledgeLibrary(),
      loadKnowledgeProcessingStatusSummary(null),
    ]);
    const collectionId = selectedCollectionId || payload.collections[0]?.id || null;
    const collectionSummary = collectionId
      ? await loadKnowledgeProcessingStatusSummary(collectionId)
      : {
          scope: "collection" as const,
          collectionId: null,
          queued: 0,
          running: 0,
          failed: 0,
        };
    setLibrary(payload);
    setGlobalTaskSummary(globalSummary);
    setActiveCollectionTaskSummary(collectionSummary);
    const settings = await loadKnowledgePipelineSettings();
    if (!settingsSaveTimerRef.current && !pendingPipelineSettingsRef.current && !isSavingPipelineSettingsRef.current) {
      setPipelineSettings(settings);
    }
    const [globalDeadLetters, collectionDeadLetters] = await Promise.all([
      loadKnowledgeProcessingDeadLetters({
        collectionId: null,
        status: "failed",
        limit: 1,
        offset: 0,
      }),
      collectionId
        ? loadKnowledgeProcessingDeadLetters({
            collectionId,
            status: "failed",
            limit: 1,
            offset: 0,
          })
        : Promise.resolve({
            scope: "collection" as const,
            collectionId: null,
            status: "failed",
            total: 0,
            hasMore: false,
            items: [],
          }),
    ]);
    setGlobalDeadLetterCount(globalDeadLetters.total);
    setActiveCollectionDeadLetterCount(collectionDeadLetters.total);
    return payload;
  }

  async function refreshProcessingJobs(options?: { syncLibrary?: boolean }) {
    try {
      const [globalSummary, collectionSummary] = await Promise.all([
        loadKnowledgeProcessingStatusSummary(null),
        activeCollection?.id
          ? loadKnowledgeProcessingStatusSummary(activeCollection.id)
          : Promise.resolve({
              scope: "collection" as const,
              collectionId: null,
              queued: 0,
              running: 0,
              failed: 0,
            }),
      ]);
      setGlobalTaskSummary(globalSummary);
      setActiveCollectionTaskSummary(collectionSummary);
      const settings = await loadKnowledgePipelineSettings();
      if (!settingsSaveTimerRef.current && !pendingPipelineSettingsRef.current && !isSavingPipelineSettingsRef.current) {
        setPipelineSettings(settings);
      }
      const [globalDeadLetters, collectionDeadLetters] = await Promise.all([
        loadKnowledgeProcessingDeadLetters({
          collectionId: null,
          status: "failed",
          limit: 1,
          offset: 0,
        }),
        activeCollection?.id
          ? loadKnowledgeProcessingDeadLetters({
              collectionId: activeCollection.id,
              status: "failed",
              limit: 1,
              offset: 0,
            })
          : Promise.resolve({
              scope: "collection" as const,
              collectionId: null,
              status: "failed",
              total: 0,
              hasMore: false,
              items: [],
            }),
      ]);
      setGlobalDeadLetterCount(globalDeadLetters.total);
      setActiveCollectionDeadLetterCount(collectionDeadLetters.total);
      setTaskCenterError(null);
      if (options?.syncLibrary) {
        try {
          const payload = await loadKnowledgeLibrary();
          setLibrary(payload);
        } catch (error) {
          console.error(error);
        }
      }
    } catch (error) {
      console.error(error);
      setTaskCenterError(error instanceof Error ? error.message : "加载处理队列失败");
    }
  }

  async function refreshDeadLetterList(options?: { resetPage?: boolean }) {
    const requestSeq = deadLetterListRequestSeqRef.current + 1;
    deadLetterListRequestSeqRef.current = requestSeq;
    const pageSize = deadLetterPageSize;
    const nextPage = options?.resetPage ? 1 : deadLetterPage;
    const scopeCollectionId = deadLetterScope === "activeCollection" ? activeCollection?.id ?? null : null;
    const statusFilter = deadLetterStatusFilter === "all" ? null : deadLetterStatusFilter;
    if (deadLetterScope === "activeCollection" && !activeCollection?.id) {
      setDeadLetterItems([]);
      setDeadLetterTotal(0);
      if (options?.resetPage) {
        setDeadLetterPage(1);
      }
      return;
    }

    setIsDeadLetterLoading(true);
    try {
      const result = await loadKnowledgeProcessingDeadLetters({
        collectionId: scopeCollectionId,
        status: statusFilter,
        limit: pageSize,
        offset: (nextPage - 1) * pageSize,
      });
      if (requestSeq !== deadLetterListRequestSeqRef.current) {
        return;
      }
      const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
      if (result.total <= 0 && nextPage !== 1) {
        setDeadLetterPage(1);
        return;
      }
      if (result.total > 0 && nextPage > totalPages) {
        setDeadLetterPage(totalPages);
        return;
      }
      setDeadLetterItems(result.items);
      setDeadLetterTotal(result.total);
      setTaskCenterError(null);
      if (options?.resetPage) {
        setDeadLetterPage(1);
      }
    } catch (error) {
      console.error(error);
      if (requestSeq === deadLetterListRequestSeqRef.current) {
        setTaskCenterError(error instanceof Error ? error.message : "加载死信列表失败");
      }
    } finally {
      if (requestSeq === deadLetterListRequestSeqRef.current) {
        setIsDeadLetterLoading(false);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const summary = activeCollection?.id
          ? await loadKnowledgeProcessingStatusSummary(activeCollection.id)
          : {
              scope: "collection" as const,
              collectionId: null,
              queued: 0,
              running: 0,
              failed: 0,
            };
        if (!cancelled) {
          setActiveCollectionTaskSummary(summary);
        }
        const collectionDeadLetters = activeCollection?.id
          ? await loadKnowledgeProcessingDeadLetters({
              collectionId: activeCollection.id,
              status: "failed",
              limit: 1,
              offset: 0,
            })
          : {
              scope: "collection" as const,
              collectionId: null,
              status: "failed",
              total: 0,
              hasMore: false,
              items: [],
            };
        if (!cancelled) {
          setActiveCollectionDeadLetterCount(collectionDeadLetters.total);
        }
      } catch (error) {
        console.error(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCollection?.id]);

  useEffect(() => {
    if (!isKnowledgeLibraryReady) {
      return;
    }
    void refreshDeadLetterList();
  }, [deadLetterScope, deadLetterStatusFilter, deadLetterPage, activeCollection?.id, isKnowledgeLibraryReady]);

  async function importFile(file: File, collectionId: string) {
    const extension = getExtension(file.name) || null;
    const previewType = getPreviewKindFromFile(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let content = "";

    try {
      if (previewType === "markdown" || previewType === "text") {
        content = await file.text();
      } else if (previewType === "docx") {
        content = await convertDocxBytesToText(bytes);
      } else if (previewType === "pdf") {
        content = await convertPdfBytesToText(bytes);
      } else if (previewType === "image") {
        content = (await createImageKnowledgeContent(file)) ?? "";
      }
    } catch (error) {
      console.error(error);
      content = "";
    }

    const thumbnailDataUrl = (await createThumbnailDataUrl(file, content || file.name)) ?? undefined;
    return await invoke<PipelineImportResult>("import_knowledge_document_pipeline_command", {
      input: {
        collectionId,
        sourceName: file.name,
        sourcePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        content: content || null,
        contentBytes: Array.from(bytes),
        mimeType: file.type || null,
        fileExtension: extension,
        previewType,
        thumbnailDataUrl,
        parserProfileId: null,
      },
    });
  }

  async function handleKnowledgeUploadSelection(files: FileList | File[]) {
    const items = Array.from(files);
    if (items.length === 0) {
      return;
    }

    setUploadError(null);
    setUploadNotice(null);

    try {
      const targetCollection = activeCollection;
      const targetCollectionId = targetCollection?.id;
      if (!targetCollectionId || !targetCollection) {
        throw new Error("请先创建知识库后再上传文件");
      }
      for (const file of items) {
        const blockedMessage = getKnowledgeUploadBlockMessage(file, targetCollection, knowledgeMultimodalConfig);
        if (blockedMessage) {
          setUploadError(blockedMessage);
          setUploadNotice({ tone: "error", message: blockedMessage });
          return;
        }
      }
      let queuedCount = 0;
      let duplicateCount = 0;
      for (const file of items) {
        const result = await importFile(file, targetCollectionId);
        if (result.status === "duplicate") {
          duplicateCount += 1;
        } else {
          queuedCount += 1;
        }
      }

      await refreshLibrary();
      setSelectedCollectionId(targetCollectionId);
      setSelectedDocumentId(null);
      setSelectedDocumentDetail(null);
      setDocumentDetailError(null);
      setSelectedDocumentDetailView("preview");
      setActiveCategory("all");
      setSearchQuery("");
      if (duplicateCount > 0 && queuedCount > 0) {
        setUploadNotice({ tone: "success", message: `上传完成：新增 ${queuedCount} 个，重复跳过 ${duplicateCount} 个` });
      } else if (duplicateCount > 0) {
        setUploadNotice({ tone: "success", message: `未新增文档：所选 ${duplicateCount} 个文件在当前知识库中已存在` });
      } else {
        setUploadNotice({ tone: "success", message: `上传完成：新增 ${queuedCount} 个文档` });
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "文件上传失败";
      setUploadError(message);
      setUploadNotice({ tone: "error", message });
    }
  }

  async function createCollection() {
    setCreateCollectionError(null);

    try {
      const values = await openPrompt({
        title: "新建知识库",
        description: "先输入名称，再补充简介，便于后续检索和管理。",
        confirmLabel: "创建",
        fields: [
          { label: "知识库名称", defaultValue: "新知识库", placeholder: "请输入知识库名称", autoFocus: true },
          { label: "知识库描述", defaultValue: "用于组织上传文件", placeholder: "请输入知识库描述", required: false },
        ],
      });

      const name = values?.[0]?.trim();
      if (!name) {
        return;
      }

      const description = values?.[1]?.trim() || "用于组织上传文件";
      const createdCollection = await invoke<KnowledgeCollection>("create_knowledge_collection_command", { name, description });
      await refreshLibrary();
      setSelectedCollectionId(createdCollection.id);
    } catch (error) {
      console.error(error);
      setCreateCollectionError(error instanceof Error ? error.message : "创建知识库失败");
    }
  }

  async function deleteCollection(collectionId: string) {
    await invoke("delete_knowledge_collection_command", { collectionId });
    const payload = await refreshLibrary();
    setSelectedCollectionId((current) => {
      if (current !== collectionId) {
        return current;
      }
      return payload.collections[0]?.id ?? "";
    });
    setSelectedDocumentId(null);
    setSelectedDocumentDetail(null);
    setSelectedDocumentDetailView("preview");
  }

  function openCollectionSettings(collection: KnowledgeCollection) {
    setKnowledgeMultimodalConfig(loadKnowledgeMultimodalConfig());
    setIsCollectionMenuOpen(null);
    setEditingCollection(collection);
    setCollectionSettingsDraft(createCollectionSettingsDraft(collection));
    setCollectionSettingsError(null);
    setIsCollectionSettingsOpen(true);
  }

  function closeCollectionSettings() {
    if (isSavingCollectionSettings) {
      return;
    }
    setIsCollectionSettingsOpen(false);
    setEditingCollection(null);
    setCollectionSettingsDraft(null);
    setCollectionSettingsError(null);
  }

  function updateCollectionDraft(patch: Partial<CollectionSettingsDraft>) {
    setCollectionSettingsDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateCollectionImageConfig(patch: Partial<KnowledgeCollectionMultimodalConfig["image"]>) {
    setCollectionSettingsDraft((current) =>
      current
        ? {
            ...current,
            multimodalConfig: {
              ...current.multimodalConfig,
              image: {
                ...current.multimodalConfig.image,
                ...patch,
              },
            },
          }
        : current
    );
  }

  function updateCollectionAudioConfig(patch: Partial<KnowledgeCollectionMultimodalConfig["audio"]>) {
    setCollectionSettingsDraft((current) =>
      current
        ? {
            ...current,
            multimodalConfig: {
              ...current.multimodalConfig,
              audio: {
                ...current.multimodalConfig.audio,
                ...patch,
              },
            },
          }
        : current
    );
  }

  async function saveCollectionSettings() {
    if (!collectionSettingsDraft) {
      return;
    }

    const draft = collectionSettingsDraft;
    const trimmedName = draft.name.trim();
    if (!trimmedName) {
      setCollectionSettingsError("知识库名称不能为空");
      return;
    }

    if (
      draft.multimodalConfig.enabled &&
      draft.multimodalConfig.image.enabled &&
      !imageMultimodalModels.some((model) => model.id === draft.multimodalConfig.image.modelId)
    ) {
      setCollectionSettingsError("已开启图片分析，但当前知识库还没有选择可用的图片模型");
      return;
    }

    if (
      draft.multimodalConfig.enabled &&
      draft.multimodalConfig.audio.enabled &&
      !audioMultimodalModels.some((model) => model.id === draft.multimodalConfig.audio.modelId)
    ) {
      setCollectionSettingsError("已开启音频分析，但当前知识库还没有选择可用的音频模型");
      return;
    }

    setCollectionSettingsError(null);
    setIsSavingCollectionSettings(true);
    try {
      await invoke<KnowledgeCollection>("update_knowledge_collection_command", {
        input: {
          collectionId: draft.id,
          name: trimmedName,
          description: draft.description.trim() || "用于组织上传文件",
          retrievalMode: draft.retrievalMode,
          multimodalConfigJson: JSON.stringify(draft.multimodalConfig),
        },
      });
      await refreshLibrary();
      setUploadNotice({ tone: "success", message: `知识库设置已保存：${trimmedName}` });
      setIsCollectionSettingsOpen(false);
      setEditingCollection(null);
      setCollectionSettingsDraft(null);
      setCollectionSettingsError(null);
    } catch (error) {
      console.error(error);
      setCollectionSettingsError(error instanceof Error ? error.message : "保存知识库设置失败");
    } finally {
      setIsSavingCollectionSettings(false);
    }
  }

  async function deleteDocument(documentId: string) {
    await invoke("delete_knowledge_document_command", { documentId });
    await refreshLibrary();
    setSelectedDocumentId(null);
    setSelectedDocumentDetail(null);
    setSelectedDocumentDetailView("preview");
  }

  async function refreshSelectedDocumentDetail(documentId: string) {
    await refreshLibrary();
    const detail = await loadKnowledgeDocumentDetail(documentId);
    setSelectedDocumentDetail(detail);
  }

  async function runSelectedDocumentAction(action: () => Promise<unknown>, fallbackMessage: string) {
    if (!selectedDocument) {
      return;
    }

    setDocumentDetailError(null);
    setIsLoadingDocumentDetail(true);
    try {
      await action();
      await refreshSelectedDocumentDetail(selectedDocument.id);
    } catch (error) {
      setDocumentDetailError(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setIsLoadingDocumentDetail(false);
    }
  }

  async function reprocessFailedItems(scope: "all" | "activeCollection") {
    if (scope === "activeCollection" && !activeCollection?.id) {
      setTaskCenterNotice("当前没有可用知识库");
      setTaskCenterError(null);
      return;
    }
    setTaskCenterError(null);
    setTaskCenterNotice(null);
    setIsTaskCenterBusy(true);
    try {
      const retryResult = await invoke<RetryFailedJobsResult>("retry_failed_knowledge_processing_jobs_command", {
        input: {
          collectionId: scope === "activeCollection" ? activeCollection?.id ?? null : null,
          limit: 500,
        },
      });
      const replayResult = await invoke<ReplayDeadLettersResult>("replay_knowledge_processing_dead_letters_command", {
        input: {
          collectionId: scope === "activeCollection" ? activeCollection?.id ?? null : null,
          status: "failed",
          limit: 300,
        },
      });

      if (retryResult.attempted <= 0 && replayResult.attempted <= 0) {
        setTaskCenterNotice("没有可重新处理的失败项");
        return;
      }

      const retriedSummary =
        retryResult.attempted > 0 ? `队列重试 ${retryResult.retried}/${retryResult.attempted}` : "队列无需重试";
      const replayedSummary =
        replayResult.attempted > 0 ? `死信回投 ${replayResult.replayed}/${replayResult.attempted}` : "死信无需回投";
      setTaskCenterNotice(`已重新处理失败项：${retriedSummary}，${replayedSummary}`);

      const errors = [...retryResult.errors, ...replayResult.errors];
      if (errors.length > 0) {
        setTaskCenterError(errors.slice(0, 2).join(" | "));
      }
      await Promise.all([refreshProcessingJobs({ syncLibrary: true }), refreshDeadLetterList({ resetPage: true })]);
    } catch (error) {
      console.error(error);
      setTaskCenterError(error instanceof Error ? error.message : "重新处理失败项失败");
    } finally {
      setIsTaskCenterBusy(false);
    }
  }

  async function updatePipelineSettings(patch: Partial<KnowledgePipelineSettings>) {
    if (!pipelineSettings) {
      return;
    }
    setTaskCenterError(null);
    const nextSettings = {
      ...pipelineSettings,
      ...patch,
    };
    setPipelineSettings(nextSettings);
    pendingPipelineSettingsRef.current = nextSettings;
    if (settingsSaveTimerRef.current) {
      window.clearTimeout(settingsSaveTimerRef.current);
      settingsSaveTimerRef.current = null;
    }
    settingsSaveTimerRef.current = window.setTimeout(() => {
      settingsSaveTimerRef.current = null;
      void (async () => {
        try {
          isSavingPipelineSettingsRef.current = true;
          setIsSavingPipelineSettings(true);
          const draft = pendingPipelineSettingsRef.current ?? nextSettings;
          const saved = await saveKnowledgePipelineSettings(draft);
          setPipelineSettings(saved);
          pendingPipelineSettingsRef.current = null;
          setTaskCenterNotice("调度参数已保存");
        } catch (error) {
          console.error(error);
          setTaskCenterError(error instanceof Error ? error.message : "保存调度设置失败");
        } finally {
          isSavingPipelineSettingsRef.current = false;
          setIsSavingPipelineSettings(false);
        }
      })();
    }, 450);
  }

  async function replayDeadLetterItem(item: KnowledgeProcessingDeadLetter) {
    if (item.status !== "failed") {
      setTaskCenterNotice("仅失败状态的死信支持回放");
      return;
    }
    setTaskCenterError(null);
    setTaskCenterNotice(null);
    setDeadLetterReplayBusyId(item.id);
    try {
      await invoke("retry_knowledge_processing_job_command", { jobId: item.jobId });
      setTaskCenterNotice("单条死信已回放");
      await refreshLibrary();
      await refreshDeadLetterList();
    } catch (error) {
      console.error(error);
      setTaskCenterError(error instanceof Error ? error.message : "单条死信回放失败");
    } finally {
      setDeadLetterReplayBusyId(null);
    }
  }

  function openDocument(documentId: string) {
    setSelectedDocumentDetail(null);
    setDocumentDetailError(null);
    setSelectedDocumentDetailView("preview");
    setSelectedAssetId(null);
    setSelectedDocumentId(documentId);
  }

  function openDocumentMenu(documentId: string) {
    setIsDocumentMenuOpen(documentId);
  }

  function backToDocumentList() {
    setSelectedDocumentId(null);
    setSelectedDocumentDetail(null);
    setDocumentDetailError(null);
    setSelectedDocumentDetailView("preview");
    setSelectedAssetId(null);
  }

  async function openSelectedDocumentExternal() {
    const path = selectedDocument?.storedFilePath ?? selectedDocument?.sourcePath ?? null;
    if (!path) {
      throw new Error("没有可打开的原文件路径");
    }
    await openPath(path);
  }

  const detailView = pageMode === "detail";
  const shouldShowTaskCenterPanel = isTaskCenterPanelOpen && !detailView;
  const taskCenterPanel = (
    <KnowledgeTaskCenterPanel
      activeCollectionName={activeCollectionName}
      hasActiveCollection={Boolean(activeCollection?.id)}
      counts={{
        global: taskCounts,
        activeCollection: activeCollectionTaskCounts,
        globalDeadLetterCount,
        activeCollectionDeadLetterCount,
      }}
      scope={deadLetterScope}
      statusFilter={deadLetterStatusFilter}
      items={deadLetterItems}
      total={deadLetterTotal}
      page={deadLetterPage}
      pageSize={deadLetterPageSize}
      isLoading={isDeadLetterLoading}
      isBusy={isTaskCenterBusy}
      replayBusyId={deadLetterReplayBusyId}
      expandedItemId={expandedDeadLetterId}
      pipelineSettings={pipelineSettings}
      isTaskSettingsOpen={isTaskSettingsOpen}
      isSavingPipelineSettings={isSavingPipelineSettings}
      notice={taskCenterNotice}
      error={taskCenterError}
      documentNameById={documentNameById}
      onScopeChange={(nextScope) => {
        setDeadLetterPage(1);
        setDeadLetterScope(nextScope);
      }}
      onStatusFilterChange={(nextStatusFilter) => {
        setDeadLetterPage(1);
        setDeadLetterStatusFilter(nextStatusFilter);
      }}
      onToggleTaskSettings={() => setIsTaskSettingsOpen((current) => !current)}
      onReprocessFailedItems={(scope) => void reprocessFailedItems(scope)}
      onUpdatePipelineSettings={(patch) => void updatePipelineSettings(patch)}
      onReplayDeadLetterItem={(item) => void replayDeadLetterItem(item)}
      onToggleDeadLetterExpanded={(itemId) => setExpandedDeadLetterId((current) => (current === itemId ? null : itemId))}
      onPreviousPage={() => setDeadLetterPage((current) => Math.max(1, current - 1))}
      onNextPage={() => setDeadLetterPage((current) => current + 1)}
      formatTimestamp={formatTimestamp}
      onUnavailableActiveCollection={() => setTaskCenterNotice("当前没有可用知识库")}
    />
  );

  return (
    <div className="omni-knowledge-root flex h-full min-h-0 flex-col bg-white text-slate-900">
      <div className="omni-knowledge-layout flex min-h-0 flex-1">
        <aside className="main-chat-nav">
          <button type="button" className="main-chat-nav__brand no-drag" title="Omni">
            <Bot size={20} strokeWidth={1.9} className="text-sky-500" />
          </button>
          <div className="main-chat-nav__items">
            <button type="button" className="main-chat-nav__item no-drag" title="聊天" onClick={onBackToChat}>
              <MessageSquare size={18} strokeWidth={1.9} />
            </button>
            <button
              type="button"
              className="main-chat-nav__item no-drag"
              title="项目"
              onClick={() => onOpenMarketplace?.()}
            >
              <Sparkles size={18} strokeWidth={1.9} />
            </button>
            <button type="button" className="main-chat-nav__item main-chat-nav__item--active no-drag" title="知识库">
              <FolderOpen size={18} strokeWidth={1.9} />
            </button>
          </div>
          <button type="button" className="main-chat-nav__item main-chat-nav__item--bottom no-drag" title="设置" onClick={onSettingsOpen}>
            <Settings size={18} strokeWidth={1.9} />
          </button>
        </aside>

        <KnowledgeCollectionSidebar
          isCollapsed={isSidebarCollapsed}
          categories={activeCategories}
          activeCategoryId={activeCategory}
          collections={library.collections}
          activeCollectionId={activeCollection?.id ?? null}
          openCollectionMenuId={isCollectionMenuOpen}
          onSelectCategory={setActiveCategory}
          onCreateCollection={createCollection}
          onSelectCollection={setSelectedCollectionId}
          onToggleCollectionMenu={(collectionId) =>
            setIsCollectionMenuOpen((current) => (current === collectionId ? null : collectionId))
          }
          onOpenCollectionSettings={openCollectionSettings}
          onDeleteCollection={(collectionId) => {
            setIsCollectionMenuOpen(null);
            void deleteCollection(collectionId);
          }}
        />

        <main className="omni-knowledge-main relative flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <header className="drag-region relative z-40 flex min-h-20 shrink-0 flex-col overflow-visible bg-white">
            {detailView ? (
              <KnowledgeDocumentDetailHeader
                document={selectedDocument}
                fallbackDocumentName={selectedDocumentRecord?.sourceName ?? null}
                collectionName={selectedDocumentCollectionName}
                activeView={selectedDocumentDetailView}
                windowControls={windowControls}
                onBackToList={backToDocumentList}
                onChangeView={setSelectedDocumentDetailView}
                onCancelActiveJob={() => {
                  if (!selectedDocument?.activeJobId) {
                    return;
                  }
                  void runSelectedDocumentAction(
                    () => invoke("cancel_knowledge_processing_job_command", { jobId: selectedDocument.activeJobId }),
                    "取消处理任务失败"
                  );
                }}
                onRetryActiveJob={() => {
                  if (!selectedDocument?.activeJobId) {
                    return;
                  }
                  void runSelectedDocumentAction(
                    () => invoke("retry_knowledge_processing_job_command", { jobId: selectedDocument.activeJobId }),
                    "重试处理任务失败"
                  );
                }}
                onReparse={() => {
                  if (!selectedDocument) {
                    return;
                  }
                  void runSelectedDocumentAction(
                    () => invoke("reparse_knowledge_document_command", { documentId: selectedDocument.id }),
                    "重新解析文档失败"
                  );
                }}
                onRevectorize={() => {
                  if (!selectedDocument) {
                    return;
                  }
                  void runSelectedDocumentAction(
                    () => invoke("revectorize_knowledge_document_command", { documentId: selectedDocument.id }),
                    "重新向量化失败"
                  );
                }}
              />
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setIsSidebarCollapsed((current) => !current)}
                      className="no-drag inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-none text-[var(--omni-app-muted)] hover:bg-[var(--omni-soft-bg)] hover:text-[var(--omni-app-text)]"
                      title={isSidebarCollapsed ? "展开侧栏" : "收起侧栏"}
                    >
                      {isSidebarCollapsed ? <PanelLeftOpen size={16} strokeWidth={2} /> : <PanelLeftClose size={16} strokeWidth={2} />}
                    </button>
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold text-[var(--omni-app-text)]">{activeCollectionName}</div>
                      <div className="mt-1 text-sm text-[var(--omni-app-muted)]">
                        {pageMode === "empty" ? "当前知识库还没有文档" : `${activeCategoryData.title} · ${visibleDocuments.length} 个文档`}
                      </div>
                    </div>
                  </div>

                  <div className="omni-knowledge-title-actions flex shrink-0 items-center">
                    <div className="no-drag omni-knowledge-toolbar-actions" onPointerDown={(event) => event.stopPropagation()}>
                      {isSearchToolbarOpen || searchQuery ? (
                        <div className="flex h-8 w-64 items-center gap-2 rounded-xl border border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] px-2.5 transition-all duration-150 md:w-72">
                          <Search size={14} strokeWidth={1.8} className="shrink-0 text-[var(--omni-app-muted)]" />
                          <input
                            ref={searchInputRef}
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                setIsSearchToolbarOpen(false);
                                event.currentTarget.blur();
                              }
                            }}
                            placeholder="搜索文档"
                            className="w-full min-w-0 border-0 bg-transparent text-sm text-[var(--omni-app-text)] outline-none placeholder:text-[var(--omni-app-muted)]"
                          />
                        </div>
                      ) : null}

                      <button
                        type="button"
                        onClick={() => setIsSearchToolbarOpen((current) => !current)}
                        className={`omni-knowledge-toolbar-button ${
                          isSearchToolbarOpen || searchQuery ? "omni-knowledge-toolbar-button--active" : ""
                        }`}
                        title="搜索文档"
                        aria-pressed={isSearchToolbarOpen || Boolean(searchQuery)}
                      >
                        <Search size={17} strokeWidth={1.9} />
                      </button>

                      <div className="no-drag relative">
                        <button
                          type="button"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => setIsUploadMenuOpen((current) => !current)}
                          className={`omni-knowledge-toolbar-button ${isUploadMenuOpen ? "omni-knowledge-toolbar-button--active" : ""}`}
                          title="上传"
                        >
                          <SquarePlus size={17} strokeWidth={1.9} />
                        </button>

                        {isUploadMenuOpen ? (
                          <div
                            ref={uploadMenuRef}
                            className="no-drag absolute right-0 top-10 z-[130] w-40 rounded-xl border border-slate-200 bg-white py-2 shadow-lg shadow-slate-200/70"
                            onPointerDown={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="no-drag flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => {
                                openFilePicker(fileInputRef.current);
                                setIsUploadMenuOpen(false);
                              }}
                            >
                              <LucideFileText size={15} strokeWidth={1.8} className="text-slate-500" />
                              上传文件
                            </button>
                            <button
                              type="button"
                              className="no-drag flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => {
                                openFilePicker(folderInputRef.current);
                                setIsUploadMenuOpen(false);
                              }}
                            >
                              <FolderOpen size={15} strokeWidth={1.8} className="text-slate-500" />
                              上传文件夹
                            </button>
                          </div>
                        ) : null}
                      </div>

                      <button
                        type="button"
                        onClick={() => setIsTaskCenterPanelOpen((current) => !current)}
                        className={`no-drag omni-knowledge-toolbar-button ${
                          isTaskCenterPanelOpen ? "omni-knowledge-toolbar-button--active" : ""
                        }`}
                        title={isTaskCenterPanelOpen ? "收起工作台" : "展开工作台"}
                      >
                        {isTaskCenterPanelOpen ? <PanelRightClose size={17} strokeWidth={1.9} /> : <PanelRightOpen size={17} strokeWidth={1.9} />}
                      </button>
                    </div>

                    <div className="no-drag omni-window-control-slot">{windowControls}</div>
                  </div>
                </div>
              </>
            )}
          </header>

          {uploadNotice ? (
            <div className="no-drag px-4 pt-3 md:px-6">
              <div
                className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
                  uploadNotice.tone === "error"
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
                }`}
              >
                <div className="min-w-0 flex-1 leading-6">{uploadNotice.message}</div>
                <button
                  type="button"
                  onClick={() => setUploadNotice(null)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-none border border-current/15 bg-white/60 text-current hover:bg-white"
                  title="关闭提示"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept={KNOWLEDGE_UPLOAD_ACCEPT}
            multiple
            className="knowledge-upload-input"
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (files) {
                void handleKnowledgeUploadSelection(files);
              }
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            accept={KNOWLEDGE_UPLOAD_ACCEPT}
            multiple
            className="knowledge-upload-input"
            {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (files) {
                void handleKnowledgeUploadSelection(files);
              }
              event.currentTarget.value = "";
            }}
          />

          <div className="omni-knowledge-body-shell flex min-h-0 min-w-0 flex-1 gap-3">
            <section className="omni-knowledge-content-panel flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 px-5 pb-4 pt-0">
                {detailView ? (
                  <div className="no-drag flex min-h-0 w-full flex-1 flex-col">
                    <KnowledgeBaseDetailBoundary
                      key={selectedDocumentId ?? "detail-empty"}
                      onBackToList={backToDocumentList}
                      onRetry={() => {
                        if (selectedDocumentId) {
                          openDocument(selectedDocumentId);
                        }
                      }}
                    >
                      <div className="flex min-h-0 flex-1 flex-col gap-4">
                        {documentDetailError ? (
                          <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] px-4 py-10 text-center text-sm text-[var(--omni-app-muted)]">
                            <div className="space-y-3">
                              <div>{documentDetailError}</div>
                              <button
                                type="button"
                                onClick={() => selectedDocumentId && openDocument(selectedDocumentId)}
                                className="rounded-lg border border-[var(--omni-panel-border)] bg-[var(--omni-app-bg)] px-3 py-1.5 text-sm text-[var(--omni-app-text)] hover:bg-[var(--omni-soft-bg)]"
                              >
                                重新加载
                              </button>
                            </div>
                          </div>
                        ) : isLoadingDocumentDetail || !selectedDocument || !selectedDocumentDetail ? (
                          <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] px-4 py-10 text-center text-sm text-[var(--omni-app-muted)]">
                            正在加载文档详情...
                          </div>
                        ) : selectedDocumentDetailView === "preview" ? (
                          <div className="flex min-h-0 flex-1">
                            <KnowledgeDocumentPreview
                              key={selectedDocumentId}
                              document={selectedDocument}
                              onOpenExternal={openSelectedDocumentExternal}
                              loadDocumentBinary={loadKnowledgeDocumentBinary}
                            />
                          </div>
                        ) : selectedDocumentDetailView === "assets" ? (
                          <KnowledgeAssetInspector
                            assets={selectedDocumentDetail.assets}
                            selectedAssetId={selectedAssetId}
                            selectedAsset={selectedAsset}
                            onSelectAsset={setSelectedAssetId}
                          />
                        ) : selectedDocumentDetailView === "processing" ? (
                          <KnowledgeDocumentProcessingPanel document={selectedDocument} collection={selectedDocumentCollection} />
                        ) : (
                          <KnowledgeDocumentChunksPanel
                            chunks={visibleDocumentChunks}
                            totalChunkCount={textOnlyDocumentChunkCount}
                            searchQuery={chunkSearchQuery}
                            searchInputRef={chunkSearchInputRef}
                            onSearchQueryChange={setChunkSearchQuery}
                            renderHighlightedSearchText={renderHighlightedSearchText}
                            formatTimestamp={formatTimestamp}
                          />
                        )}
                      </div>
                    </KnowledgeBaseDetailBoundary>
                  </div>
                ) : pageMode === "list" ? (
                  <KnowledgeDocumentList
                    documents={visibleDocuments}
                    selectedDocumentId={selectedDocumentId}
                    openDocumentMenuId={isDocumentMenuOpen}
                    thumbnailDataUrlById={listThumbnailDataUrlById}
                    onOpenDocument={openDocument}
                    onOpenDocumentMenu={openDocumentMenu}
                    onCloseDocumentMenu={() => setIsDocumentMenuOpen(null)}
                    onDeleteDocument={(documentId) => void deleteDocument(documentId)}
                  />
                ) : (
                  <section className="no-drag flex min-h-0 min-w-0 flex-1 items-center justify-center">
                    {!isKnowledgeLibraryReady ? (
                      <div className="omni-knowledge-empty-state flex flex-col items-center justify-center px-8 py-12 text-center">
                        <div className="omni-knowledge-empty-state__title text-lg font-semibold tracking-[-0.02em]">正在加载知识库</div>
                        <div className="omni-knowledge-empty-state__desc mt-2 text-sm">请稍候，系统会读取当前已有的知识库。</div>
                      </div>
                    ) : library.collections.length === 0 ? (
                      <div className="omni-knowledge-empty-state flex w-full max-w-md flex-col items-center justify-center px-8 py-12 text-center">
                        <div className="omni-knowledge-empty-state__title text-2xl font-semibold tracking-[-0.03em]">还没有知识库</div>
                        <div className="omni-knowledge-empty-state__desc mt-2 text-sm">先新建一个知识库，再上传文件或文件夹。</div>
                        {uploadError ? (
                          <div className="omni-knowledge-empty-state__error mt-3 rounded-lg border px-4 py-2 text-sm">
                            {uploadError}
                          </div>
                        ) : null}
                        {createCollectionError ? (
                          <div className="omni-knowledge-empty-state__error mt-3 rounded-lg border px-4 py-2 text-sm">
                            {createCollectionError}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          className="omni-knowledge-empty-state__action mt-8 inline-flex items-center gap-2 rounded-xl border px-5 py-3 text-sm font-medium shadow-sm"
                          onClick={createCollection}
                        >
                          <Plus size={16} strokeWidth={2} />
                          新建知识库
                        </button>
                      </div>
                    ) : (
                      <div className="omni-knowledge-empty-state flex flex-col items-center justify-center px-8 py-12 text-center">
                        <div className="omni-knowledge-empty-state__title text-lg font-semibold tracking-[-0.02em]">当前知识库暂无文档</div>
                        <div className="omni-knowledge-empty-state__desc mt-2 text-sm">请使用右上角上传按钮导入文件。</div>
                        {uploadError ? (
                          <div className="omni-knowledge-empty-state__error mt-3 rounded-lg border px-4 py-2 text-sm">
                            {uploadError}
                          </div>
                        ) : null}
                        {createCollectionError ? (
                          <div className="omni-knowledge-empty-state__error mt-3 rounded-lg border px-4 py-2 text-sm">
                            {createCollectionError}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </section>
                )}
              </div>
            </section>
            {shouldShowTaskCenterPanel ? <div className="omni-knowledge-topic-shell flex min-h-0 shrink-0">{taskCenterPanel}</div> : null}
          </div>
        </main>
      </div>
      {isCollectionSettingsOpen && collectionSettingsDraft ? (
        <div
          className="omni-confirm-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeCollectionSettings();
            }
          }}
        >
          <div className="omni-knowledge-collection-settings">
            <div className="omni-knowledge-collection-settings__header">
              <div className="min-w-0">
                <div className="text-base font-semibold text-slate-950">
                  {editingCollection?.name ?? collectionSettingsDraft.name} · 知识库设置
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  配置当前知识库的基础信息，以及图片 / 音频多模态分析策略。
                </div>
              </div>
              <button
                type="button"
                onClick={closeCollectionSettings}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                title="关闭"
              >
                <X size={16} strokeWidth={2} />
              </button>
            </div>

            <div className="omni-knowledge-collection-settings__body">
              <section className="omni-knowledge-collection-settings__section">
                <div className="omni-knowledge-collection-settings__section-title">基础信息</div>
                <div className="omni-knowledge-collection-settings__grid">
                  <label className="omni-knowledge-collection-settings__label">知识库名称</label>
                  <input
                    value={collectionSettingsDraft.name}
                    onChange={(event) => updateCollectionDraft({ name: event.target.value })}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    placeholder="请输入知识库名称"
                  />

                  <label className="omni-knowledge-collection-settings__label">知识库描述</label>
                  <textarea
                    value={collectionSettingsDraft.description}
                    onChange={(event) => updateCollectionDraft({ description: event.target.value })}
                    className="min-h-24 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    placeholder="用于组织上传文件"
                  />
                </div>
              </section>

              <section className="omni-knowledge-collection-settings__section">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="omni-knowledge-collection-settings__section-title">多模态</div>
                    <div className="mt-1 text-sm text-slate-500">分析结果会并入知识内容，继续沿用当前的检索和问答链路。</div>
                  </div>
                  <label className="omni-knowledge-collection-settings__switch">
                    <OmniSwitch
                      checked={collectionSettingsDraft.multimodalConfig.enabled}
                      onChange={(checked) =>
                        updateCollectionDraft({
                          multimodalConfig: {
                            ...collectionSettingsDraft.multimodalConfig,
                            enabled: checked,
                          },
                        })
                      }
                      ariaLabel="启用多模态"
                    />
                    <span>启用多模态</span>
                  </label>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="omni-knowledge-collection-settings__capability-card">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <LucideFileImage size={16} strokeWidth={1.9} className="text-amber-600" />
                        <strong className="text-sm text-slate-900">图片分析</strong>
                      </div>
                      <label className="omni-knowledge-collection-settings__switch">
                        <OmniSwitch
                          checked={collectionSettingsDraft.multimodalConfig.image.enabled}
                          onChange={(checked) => updateCollectionImageConfig({ enabled: checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled}
                          ariaLabel="图片分析"
                        />
                        <span>{collectionSettingsDraft.multimodalConfig.image.enabled ? "开启" : "关闭"}</span>
                      </label>
                    </div>

                    <div className="mt-3 space-y-3">
                      <label className="block text-xs font-medium text-slate-500">模型</label>
                      <OmniSelect
                        value={collectionSettingsDraft.multimodalConfig.image.modelId}
                        onChange={(value) => updateCollectionImageConfig({ modelId: value })}
                        disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.image.enabled}
                        ariaLabel="知识库图片分析模型"
                        options={[
                          { value: "", label: "请选择图片模型" },
                          ...imageMultimodalModels.map((model) => ({ value: model.id, label: `${model.name} · ${model.provider}` })),
                        ]}
                      />

                      <label className="omni-knowledge-collection-settings__toggle">
                        <OmniSwitch
                          checked={collectionSettingsDraft.multimodalConfig.image.extractText}
                          onChange={(checked) => updateCollectionImageConfig({ extractText: checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.image.enabled}
                          ariaLabel="提取图片文字"
                        />
                        <span>提取图片文字</span>
                      </label>
                      <label className="omni-knowledge-collection-settings__toggle">
                        <OmniSwitch
                          checked={collectionSettingsDraft.multimodalConfig.image.generateSummary}
                          onChange={(checked) => updateCollectionImageConfig({ generateSummary: checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.image.enabled}
                          ariaLabel="生成图片摘要"
                        />
                        <span>生成图片摘要</span>
                      </label>
                    </div>
                  </div>

                  <div className="omni-knowledge-collection-settings__capability-card">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Mic size={16} strokeWidth={1.9} className="text-sky-600" />
                        <strong className="text-sm text-slate-900">音频分析</strong>
                      </div>
                      <label className="omni-knowledge-collection-settings__switch">
                        <OmniSwitch
                          checked={collectionSettingsDraft.multimodalConfig.audio.enabled}
                          onChange={(checked) => updateCollectionAudioConfig({ enabled: checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled}
                          ariaLabel="音频分析"
                        />
                        <span>{collectionSettingsDraft.multimodalConfig.audio.enabled ? "开启" : "关闭"}</span>
                      </label>
                    </div>

                    <div className="mt-3 space-y-3">
                      <label className="block text-xs font-medium text-slate-500">模型</label>
                      <OmniSelect
                        value={collectionSettingsDraft.multimodalConfig.audio.modelId}
                        onChange={(value) => updateCollectionAudioConfig({ modelId: value })}
                        disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.audio.enabled}
                        ariaLabel="知识库音频分析模型"
                        options={[
                          { value: "", label: "请选择音频模型" },
                          ...audioMultimodalModels.map((model) => ({ value: model.id, label: `${model.name} · ${model.provider}` })),
                        ]}
                      />

                      <label className="omni-knowledge-collection-settings__toggle">
                        <OmniSwitch
                          checked={collectionSettingsDraft.multimodalConfig.audio.keepTranscript}
                          onChange={(checked) => updateCollectionAudioConfig({ keepTranscript: checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.audio.enabled}
                          ariaLabel="保留全文转写"
                        />
                        <span>保留全文转写</span>
                      </label>
                      <label className="omni-knowledge-collection-settings__toggle">
                        <OmniSwitch
                          checked={collectionSettingsDraft.multimodalConfig.audio.generateSummary}
                          onChange={(checked) => updateCollectionAudioConfig({ generateSummary: checked })}
                          disabled={!collectionSettingsDraft.multimodalConfig.enabled || !collectionSettingsDraft.multimodalConfig.audio.enabled}
                          ariaLabel="生成音频摘要"
                        />
                        <span>生成音频摘要</span>
                      </label>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  <div className="flex items-center gap-2 font-medium text-slate-900">
                    <Sparkles size={15} strokeWidth={1.9} className="text-amber-600" />
                    <span>当前入库策略</span>
                  </div>
                  <div className="mt-2 leading-6">
                    原始文件照常保存，图片和音频分析结果会作为附加文本并入知识内容，再进入当前分片与向量检索链路。
                  </div>
                </div>
              </section>

              {collectionSettingsError ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {collectionSettingsError}
                </div>
              ) : null}
            </div>

            <div className="omni-knowledge-collection-settings__footer">
              <button
                type="button"
                onClick={closeCollectionSettings}
                disabled={isSavingCollectionSettings}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void saveCollectionSettings()}
                disabled={isSavingCollectionSettings}
                className="rounded-lg border border-slate-950 bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSavingCollectionSettings ? "保存中..." : "保存设置"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
