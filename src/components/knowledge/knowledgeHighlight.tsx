import { getSearchHighlightTerms } from "./knowledgeViewHelpers";

/** 转义正则元字符，避免用户搜索词里的符号破坏高亮正则。 */
export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把命中搜索词的片段包成 <mark> 高亮。
 *
 * 无搜索词或无命中时原样返回字符串，调用方可以直接放进 JSX。
 */
export function renderHighlightedSearchText(text: string, query: string) {
  if (!text) {
    return text;
  }

  const terms = getSearchHighlightTerms(query);
  if (terms.length === 0) {
    return text;
  }

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);
  if (parts.length === 1) {
    return text;
  }

  const normalizedTerms = new Set(terms.map((term) => term.toLowerCase()));
  return parts.map((part, index) => {
    if (!part) {
      return null;
    }
    if (normalizedTerms.has(part.toLowerCase())) {
      return (
        <mark key={`match-${index}`} className="rounded bg-amber-100 px-0.5 text-slate-900">
          {part}
        </mark>
      );
    }
    return <span key={`text-${index}`}>{part}</span>;
  });
}
