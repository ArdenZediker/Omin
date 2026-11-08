import { isModelInvocable, isUserInvocable } from "../plugins/invocation";
import { pluginRegistry } from "../plugins/registry";
import type { PluginManifest } from "../plugins/types";
import type { EnabledSkillPrompt } from "./promptModules";
import type { Project } from "./types";

/**
 * DSH-style skill assembly.
 *
 * Providers own discovery; this module only merges their candidates, resolves
 * shadowing, applies the current assistant's skill boundary, and exposes
 * invocation-specific views. The model catalog never includes a skill body;
 * bodies are resolved on demand through `getModelSkill`.
 */
export const INSTALLED_SKILL_RANK = 300;
export const BUNDLED_SKILL_RANK = 600;
export const SKILL_CATALOG_DESCRIPTION_MAX_LENGTH = 500;

export type SkillProvider = {
  /** Stable provider name surfaced to the model with a loaded skill. */
  name: string;
  /** Lower values win when two providers expose the same skill id. */
  rank: number;
  /** Whether the project's allowedSkillIds curates this provider. */
  projectScoped?: boolean;
  list: () => readonly PluginManifest[];
};

export type SkillCatalogEntry = {
  id: string;
  name: string;
  command: string;
  description: string;
  whenToUse?: string;
  body: string;
  resourceBase?: string;
  invocation: PluginManifest["invocation"];
  manifest: PluginManifest;
  provider: string;
  rank: number;
};

export type SkillCatalog = {
  revision: number;
  entries: readonly SkillCatalogEntry[];
  modelEntries: readonly SkillCatalogEntry[];
  userEntries: readonly SkillCatalogEntry[];
  getModelSkill: (nameOrCommand: string) => SkillCatalogEntry | undefined;
  getUserSkill: (nameOrCommand: string) => SkillCatalogEntry | undefined;
};

export type SkillCatalogOptions = {
  project?: Project | null;
  /** Expert scope. `undefined` means unrestricted; an empty array means no skills. */
  expertSkillIds?: readonly string[];
  providers?: readonly SkillProvider[];
};

function enabledSkills(): readonly PluginManifest[] {
  return pluginRegistry.listEnabledSkills();
}

/**
 * Omni's two current providers map onto DSH's precedence model:
 * user-installed skills override bundled skills with the same id.
 */
export function defaultSkillProviders(): SkillProvider[] {
  return [
    {
      name: "installed",
      rank: INSTALLED_SKILL_RANK,
      projectScoped: false,
      list: () => enabledSkills().filter((manifest) => pluginRegistry.isInstalled(manifest.id)),
    },
    {
      name: "bundled",
      rank: BUNDLED_SKILL_RANK,
      projectScoped: true,
      list: () => enabledSkills().filter((manifest) => !pluginRegistry.isInstalled(manifest.id)),
    },
  ];
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLookup(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

function skillMatches(entry: SkillCatalogEntry, query: string): boolean {
  const normalized = normalizeLookup(query);
  if (!normalized) return false;
  return (
    entry.id.toLowerCase() === normalized ||
    entry.command.replace(/^\/+/, "").toLowerCase() === normalized ||
    entry.name.trim().toLowerCase() === normalized
  );
}

function toCatalogEntry(
  manifest: PluginManifest,
  provider: SkillProvider,
): { entry: SkillCatalogEntry } | null {
  if (manifest.kind !== "skill") return null;
  const id = manifest.id.trim();
  const description = normalizeText(manifest.description);
  // DSH rejects a candidate without a description because the model cannot
  // route to it. Omni keeps the same contract at the assembly boundary.
  if (!id || !description) return null;
  return {
    entry: {
      id,
      name: manifest.name?.trim() || id,
      command: manifest.command?.trim() || `/${id}`,
      description,
      whenToUse: normalizeText(manifest.whenToUse) || undefined,
      body: (manifest.systemPrompt ?? manifest.body ?? "").trim(),
      resourceBase: manifest.resourceBase?.trim() || undefined,
      invocation: manifest.invocation,
      manifest,
      provider: provider.name,
      rank: provider.rank,
    },
  };
}

/**
 * Merge skill providers into one deterministic catalog.
 *
 * Shadowing is by stable skill id. Candidates are ordered by provider rank,
 * provider registration order, then provider-local order; the first candidate
 * for an id wins. Expert scope and project curation are applied after merge,
 * matching DSH's distinction between catalog composition and consumer scope.
 */
export function assembleSkillCatalog(options: SkillCatalogOptions = {}): SkillCatalog {
  const providers = options.providers ?? defaultSkillProviders();
  const winners = new Map<string, SkillCatalogEntry>();

  providers
    .map((provider, providerOrder) => ({ provider, providerOrder }))
    .sort((left, right) => left.provider.rank - right.provider.rank || left.providerOrder - right.providerOrder)
    .forEach(({ provider }) => {
      provider.list().forEach((manifest) => {
        const candidate = toCatalogEntry(manifest, provider);
        if (!candidate || winners.has(candidate.entry.id)) return;
        winners.set(candidate.entry.id, candidate.entry);
      });
    });

  const expertSkillIds = options.expertSkillIds === undefined
    ? undefined
    : new Set(options.expertSkillIds);
  const entries = [...winners.values()]
    .filter((entry) => !expertSkillIds || expertSkillIds.has(entry.id))
    .filter((entry) => {
      const provider = providers.find((candidate) => candidate.name === entry.provider);
      return !provider?.projectScoped ||
        !options.project ||
        (options.project.allowedSkillIds ?? []).includes(entry.id);
    })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  const modelEntries = entries.filter((entry) => isModelInvocable(entry.invocation) && Boolean(entry.body));
  const userEntries = entries.filter((entry) => isUserInvocable(entry.invocation) && Boolean(entry.body));
  const revision = options.providers === undefined ? pluginRegistry.getVersion() : 0;

  return {
    revision,
    entries,
    modelEntries,
    userEntries,
    getModelSkill: (nameOrCommand) => modelEntries.find((entry) => skillMatches(entry, nameOrCommand)),
    getUserSkill: (nameOrCommand) => userEntries.find((entry) => skillMatches(entry, nameOrCommand)),
  };
}

export function buildEnabledSkillPrompts(
  catalog: SkillCatalog,
  catalogOnly: boolean,
): EnabledSkillPrompt[] {
  return catalog.modelEntries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    command: entry.command,
    description: entry.description,
    whenToUse: entry.whenToUse,
    prompt: catalogOnly ? "" : entry.body,
    catalogOnly,
  }));
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/**
 * Canonical model-facing skill body shared by the model loader and the
 * user-explicit `/skill` path, matching DSH's `<skill_content>` contract.
 */
export function renderSkillContent(
  skill: Pick<SkillCatalogEntry, "id" | "provider" | "resourceBase" | "body">,
): string {
  const resourceLines = skill.resourceBase
    ? [
        `Base directory for this skill: ${escapeText(skill.resourceBase)}`,
        "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
      ]
    : [
        `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
        "Load referenced resources only as needed.",
      ];
  return [
    `<skill_content name="${escapeAttribute(skill.id)}">`,
    "<skill_resources>",
    ...resourceLines,
    "</skill_resources>",
    "",
    "<skill_instructions>",
    skill.body,
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
}
