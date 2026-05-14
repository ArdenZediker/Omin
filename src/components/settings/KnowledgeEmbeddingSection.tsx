import { modelRegistry } from "../../adapters/registry";
import {
  DEFAULT_KNOWLEDGE_EMBEDDING_PROFILE,
  KNOWLEDGE_EMBEDDING_PROVIDER_OPTIONS,
  type KnowledgeEmbeddingProfile,
} from "../../chat/knowledgeEmbedding";

type Props = {
  profile: KnowledgeEmbeddingProfile;
  onChangeProfile: (profile: KnowledgeEmbeddingProfile) => void;
};

export default function KnowledgeEmbeddingSection({ profile, onChangeProfile }: Props) {
  const providerConfigured = Boolean(modelRegistry.getProviderConfig(profile.provider)?.hasApiKey);

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">知识库 Embedding</h3>
          <p className="mt-0.5 text-xs text-slate-500">用于知识库文档切片向量化与查询召回。复用已配置的 provider API Key。</p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] ${
            profile.enabled ? (providerConfigured ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700") : "bg-slate-200 text-slate-600"
          }`}
        >
          {profile.enabled ? (providerConfigured ? "已启用" : "缺少 Key") : "已关闭"}
        </span>
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={profile.enabled}
            onChange={(event) => onChangeProfile({ ...profile, enabled: event.target.checked })}
          />
          启用知识库向量
        </label>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm text-slate-700">
            <span className="block text-xs font-medium text-slate-500">Embedding Provider</span>
            <select
              value={profile.provider}
              onChange={(event) => onChangeProfile({ ...profile, provider: event.target.value as KnowledgeEmbeddingProfile["provider"] })}
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
            >
              {KNOWLEDGE_EMBEDDING_PROVIDER_OPTIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-sm text-slate-700">
            <span className="block text-xs font-medium text-slate-500">Embedding Model</span>
            <input
              value={profile.model}
              onChange={(event) => onChangeProfile({ ...profile, model: event.target.value })}
              placeholder={DEFAULT_KNOWLEDGE_EMBEDDING_PROFILE.model}
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
            />
          </label>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs leading-5 text-slate-500">
            这个配置只负责知识库 embedding，不改聊天模型。知识库页面里再单独决定当前集合用关键词、混合还是向量。
          </p>
          <button
            type="button"
            onClick={() => onChangeProfile(DEFAULT_KNOWLEDGE_EMBEDDING_PROFILE)}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            恢复默认
          </button>
        </div>
      </div>
    </section>
  );
}
