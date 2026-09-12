import type { Project } from "./types";

/**
 * 专家委派策略。
 *
 * 三类插件的可用性口径**刻意不同**：
 * - 技能：安装 + 开启 ⇒ 提示词直接注入，模型可用；
 * - 连接器 / MCP：安装 + 开启 + 信任 ⇒ 工具直接暴露给模型；
 * - 专家：专家是「本项目可指派的工作角色」，默认**必须由项目显式绑定**
 *   （`Project.boundExpertIds`）才允许**模型自动委派**。未绑定的项目里，
 *   模型连专家名册都看不到（见 `buildExpertAgentHint`）。
 *
 * 用户可在「设置 → 子 Agent 模型」里打开「允许模型指派任意专家」放宽为全局可用。
 *
 * 边界：本策略只约束**模型发起的委派**（`agent` 工具带 `expertId`）。
 * 用户在输入框手动 `@专家` 属于本人显式选择，不受此约束（放行）。
 */

/** 项目是否绑定了该专家。 */
export function isExpertBound(project: Project | null | undefined, expertId: string): boolean {
  const bound = project?.boundExpertIds ?? [];
  return bound.filter(Boolean).includes(expertId);
}

/**
 * 该专家当前是否允许被**模型**委派。
 *
 * - `allowAnyExpert` 打开 → 任意已启用专家都可委派（放宽档）；
 * - 否则 → 必须由当前项目绑定；无项目（临时会话）视为未绑定 = 不允许。
 */
export function canDelegateExpert(options: {
  expertId: string;
  project: Project | null | undefined;
  allowAnyExpert: boolean;
}): boolean {
  if (options.allowAnyExpert) return true;
  return isExpertBound(options.project, options.expertId);
}

/** 从候选专家中筛出可被模型委派的集合（保持入参顺序）。 */
export function resolveDelegatableExperts<T extends { id: string }>(
  experts: T[],
  project: Project | null | undefined,
  allowAnyExpert: boolean,
): T[] {
  if (allowAnyExpert) return experts;
  return experts.filter((expert) => isExpertBound(project, expert.id));
}
