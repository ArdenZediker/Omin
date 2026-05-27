export type KnowledgeContextSource = {
  chunkId: string;
  documentId: string;
  sourceName: string;
  sourcePath?: string | null;
  collectionName: string;
  chunkTitle?: string | null;
  chunkIndex: number;
  score: number;
  excerpt: string;
  tags: string[];
  favorite: boolean;
  accessCount: number;
  lastAccessedAt?: number | null;
  titleHierarchy?: string | null;
};

export type SearchKnowledgeChunkResult = {
  chunk: {
    id: string;
    documentId: string;
    collectionId: string;
    chunkIndex: number;
    title?: string | null;
    content: string;
    embeddingJson?: string | null;
    embeddingModelKey?: string | null;
    createdAt: number;
  };
  score: number;
  sourceName: string;
  sourcePath?: string | null;
  collectionName: string;
  tags: string[];
  favorite: boolean;
  accessCount: number;
  lastAccessedAt?: number | null;
  titleHierarchy?: string | null;
};

export type KnowledgeCollection = {
  id: string;
  name: string;
  description: string;
  retrievalMode?: string | null;
  embeddingProfileId?: string | null;
  createdAt?: number;
  updatedAt?: number;
};

export type KnowledgeDocument = {
  id: string;
  collectionId: string;
  sourceName: string;
  sourcePath?: string | null;
  storedFilePath?: string | null;
  mimeType?: string | null;
  fileExtension?: string | null;
  previewType?: string | null;
  content?: string;
  contentPreview: string;
  thumbnailDataUrl?: string | null;
  fileHash?: string | null;
  fileSize?: number | null;
  processingStatus?: "pending" | "processing" | "searchable" | "partial" | "failed" | "canceled" | "unsupported" | null;
  errorMessage?: string | null;
  activeJobId?: string | null;
  contentVersion?: number | null;
  parserProfileId?: string | null;
  lastProcessedAt?: number | null;
  chunkCount: number;
  vectorizedChunkCount?: number;
  vectorizationState?: "empty" | "unvectorized" | "partial" | "vectorized";
  tags: string[];
  favorite: boolean;
  accessCount: number;
  lastAccessedAt?: number | null;
  titleHierarchy?: string | null;
  createdAt?: number;
  updatedAt?: number;
};

export type KnowledgeLibraryPayload = {
  collections: KnowledgeCollection[];
  documents: KnowledgeDocument[];
};

export type KnowledgeDocumentChunk = {
  id: string;
  documentId: string;
  collectionId: string;
  chunkIndex: number;
  title?: string | null;
  content: string;
  embeddingJson?: string | null;
  embeddingModelKey?: string | null;
  createdAt: number;
};

export type KnowledgeDocumentDetail = {
  document: KnowledgeDocument & { content?: string | null };
  chunks: KnowledgeDocumentChunk[];
};

export type KnowledgeDocumentBinaryPayload = {
  bytes: number[];
};

export type KnowledgeProcessingJob = {
  id: string;
  documentId: string;
  collectionId: string;
  jobType: "initial_import" | "reparse" | "rechunk" | "revectorize" | "full_rebuild";
  status: "queued" | "running" | "paused" | "succeeded" | "failed" | "canceled";
  currentStep?: string | null;
  progress: number;
  attempt: number;
  maxAttempts: number;
  priority: number;
  failCount: number;
  nextRunAt?: number | null;
  sourceJobId?: string | null;
  cancelRequested: boolean;
  pauseRequested: boolean;
  errorMessage?: string | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  updatedAt: number;
};

export type KnowledgeProcessingStep = {
  id: string;
  jobId: string;
  documentId: string;
  stepName: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  progress: number;
  errorMessage?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  updatedAt: number;
};

export type KnowledgeProcessingLog = {
  id: string;
  jobId: string;
  documentId: string;
  level: "info" | "warn" | "error";
  stepName?: string | null;
  message: string;
  detailsJson?: string | null;
  createdAt: number;
};

export type KnowledgeProcessingJobDetail = {
  job: KnowledgeProcessingJob;
  steps: KnowledgeProcessingStep[];
  logs: KnowledgeProcessingLog[];
};

export type KnowledgeProcessingStatusSummary = {
  scope: "global" | "collection";
  collectionId?: string | null;
  queued: number;
  running: number;
  failed: number;
};

export type FailedJobQueryInput = {
  collectionId?: string | null;
  limit?: number;
  offset?: number;
};

export type FailedJobQueryResult = {
  scope: "global" | "collection";
  collectionId?: string | null;
  total: number;
  hasMore: boolean;
  jobs: KnowledgeProcessingJob[];
};

export type RetryFailedJobsInput = {
  collectionId?: string | null;
  limit?: number;
};

export type RetryFailedJobsResult = {
  scope: "global" | "collection";
  collectionId?: string | null;
  attempted: number;
  retried: number;
  skipped: number;
  errors: string[];
};

export type KnowledgeProcessingDeadLetter = {
  id: string;
  jobId: string;
  documentId: string;
  collectionId: string;
  jobType: string;
  status: string;
  errorMessage?: string | null;
  failCount: number;
  attempt: number;
  maxAttempts: number;
  firstFailedAt: number;
  lastFailedAt: number;
  replayedAt?: number | null;
  replayedJobId?: string | null;
  resolvedAt?: number | null;
  metadataJson?: string | null;
};

export type DeadLetterQueryInput = {
  collectionId?: string | null;
  status?: string | null;
  limit?: number;
  offset?: number;
};

export type DeadLetterQueryResult = {
  scope: "global" | "collection";
  collectionId?: string | null;
  status?: string | null;
  total: number;
  hasMore: boolean;
  items: KnowledgeProcessingDeadLetter[];
};

export type ReplayDeadLettersInput = {
  collectionId?: string | null;
  status?: string | null;
  limit?: number;
};

export type ReplayDeadLettersResult = {
  scope: "global" | "collection";
  collectionId?: string | null;
  attempted: number;
  replayed: number;
  skipped: number;
  errors: string[];
};

export type KnowledgePipelineSettings = {
  enabled: boolean;
  maxConcurrentJobs: number;
  perCollectionMaxRunning: number;
  maxFileSizeMb: number;
  maxAttempts: number;
  maxAutoRetries: number;
  jobTimeoutMs: number;
  stepTimeoutMs: number;
  keepSuccessfulLogsDays: number;
  keepFailedLogsDays: number;
};

export type PipelineImportResult = {
  documentId: string;
  jobId?: string | null;
  duplicateDocumentId?: string | null;
  status: "queued" | "duplicate";
};

export type KnowledgeContextResult = {
  query: string;
  block: string;
  sources: KnowledgeContextSource[];
};
