// 产物类型 → 图标/颜色 映射（消息卡片与聚合抽屉共用）
import { FileText, FileSpreadsheet, Presentation, Globe, Wand2, Image as ImageIcon, Code, File, type LucideIcon } from "lucide-react";
import type { ArtifactType } from "../../chat/artifacts";

const ARTIFACT_ICON: Record<ArtifactType, LucideIcon> = {
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
  web: Globe,
  skill: Wand2,
  image: ImageIcon,
  code: Code,
  text: FileText,
  file: File,
};

const ARTIFACT_COLOR: Record<ArtifactType, string> = {
  docx: "#3b82f6",
  xlsx: "#22c55e",
  pptx: "#f97316",
  web: "#06b6d4",
  skill: "#8b5cf6",
  image: "#ec4899",
  code: "#64748b",
  text: "#64748b",
  file: "#94a3b8",
};

export function ArtifactTypeIcon({ type, size = 16 }: { type: ArtifactType; size?: number }) {
  const Icon = ARTIFACT_ICON[type] ?? File;
  const color = ARTIFACT_COLOR[type] ?? "#94a3b8";
  return <Icon size={size} strokeWidth={1.8} style={{ color }} aria-hidden />;
}
