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

export type KnowledgeContextResult = {
  query: string;
  block: string;
  sources: KnowledgeContextSource[];
};
