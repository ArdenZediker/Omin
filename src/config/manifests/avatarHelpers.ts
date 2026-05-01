import type { AssistantProfile } from "../../chat/types";
import type { AvatarPreset } from "./types";

const LEGACY_AVATAR_CODE_MAP: Record<string, string> = {
  "🦉": "1F989",
  "😊": "1F60A",
  "😀": "1F600",
  "😄": "1F604",
  "😁": "1F601",
  "😎": "1F60E",
  "🥳": "1F973",
  "🤓": "1F913",
  "😺": "1F63A",
  "🐶": "1F436",
  "🦊": "1F98A",
  "🐼": "1F43C",
  "🐸": "1F438",
  "🤖": "1F916",
  "👾": "1F47E",
  "🎯": "1F3AF",
  "⭐": "2B50",
  "🔥": "1F525",
  "🌈": "1F308",
  "🍀": "1F340",
  "🌸": "1F338",
  "🍎": "1F34E",
  "⚽": "26BD",
  "🎵": "1F3B5",
  "🚀": "1F680",
};

const CUSTOM_ASSISTANT_AVATAR_CODES = ["1F916", "1F9E0", "1F47E", "1F4A1", "1F680", "1F3AF"];

export function getEmojiAssetSrc(code: string) {
  return `https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@master/color/svg/${code.trim().toUpperCase()}.svg`;
}

export function resolveEmojiAvatarCode(value?: string | null) {
  if (!value) return null;
  if (value.startsWith("emoji:")) return value.slice(6).trim().toUpperCase();
  return LEGACY_AVATAR_CODE_MAP[value] ?? null;
}

export function resolveAssistantAvatarSeed(assistants: AssistantProfile[], assistantId: string | null) {
  if (!assistantId) return 0;
  const customAssistants = assistants.filter((assistant) => assistant.kind === "custom");
  const index = customAssistants.findIndex((assistant) => assistant.id === assistantId);
  return index >= 0 ? index : 0;
}

export function resolveAssistantAvatarImageSrc(assistant: AssistantProfile | null, seed = 0) {
  const fallbackCode = assistant?.kind === "basic" ? "1F989" : CUSTOM_ASSISTANT_AVATAR_CODES[seed % CUSTOM_ASSISTANT_AVATAR_CODES.length];

  if (!assistant) {
    return getEmojiAssetSrc("1F989");
  }

  if (assistant.avatarType === "image" && assistant.avatarValue) {
    return assistant.avatarValue;
  }

  const avatarCode = resolveEmojiAvatarCode(assistant.avatarValue);
  if (avatarCode) {
    return getEmojiAssetSrc(avatarCode);
  }

  return getEmojiAssetSrc(fallbackCode);
}

export function filterAvatarPresets(presets: AvatarPreset[], categoryId: string, query: string) {
  const normalizedQuery = query.toLocaleLowerCase().replace(/\s+/g, "");

  return presets.filter((avatar) => {
    const matchesCategory = categoryId === "recent" ? true : avatar.category === categoryId;
    if (!matchesCategory) return false;
    if (!normalizedQuery) return true;
    const searchable = `${avatar.code} ${avatar.label} ${avatar.category} ${avatar.tone} ${avatar.hint}`.toLocaleLowerCase().replace(/\s+/g, "");
    return searchable.includes(normalizedQuery);
  });
}
