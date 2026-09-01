import type { Project } from "../../chat/types";

const CUSTOM_PROJECT_AVATAR_CODES = ["1F916", "1F9E0", "1F47E", "1F4A1", "1F680", "1F3AF"];

export function getEmojiAssetSrc(code: string) {
  return `https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@master/color/svg/${code.trim().toUpperCase()}.svg`;
}

export function resolveEmojiAvatarCode(value?: string | null) {
  if (!value) return null;
  if (value.startsWith("emoji:")) return value.slice(6).trim().toUpperCase();
  return null;
}

export function resolveProjectAvatarSeed(projects: Project[], projectId: string | null) {
  if (!projectId) return 0;
  const customProjects = projects.filter((project) => project.kind === "custom");
  const index = customProjects.findIndex((project) => project.id === projectId);
  return index >= 0 ? index : 0;
}

export function resolveProjectAvatarImageSrc(project: Project | null, seed = 0) {
  const fallbackCode = project?.kind === "basic" ? "1F989" : CUSTOM_PROJECT_AVATAR_CODES[seed % CUSTOM_PROJECT_AVATAR_CODES.length];

  if (!project) {
    return getEmojiAssetSrc("1F989");
  }

  if (project.avatarType === "image" && project.avatarValue) {
    return project.avatarValue;
  }

  const avatarCode = resolveEmojiAvatarCode(project.avatarValue);
  if (avatarCode) {
    return getEmojiAssetSrc(avatarCode);
  }

  return getEmojiAssetSrc(fallbackCode);
}
