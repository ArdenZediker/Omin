// 中断步骤定案（settlement）：流式期间 engine 只实时推送 status="running" 的过渡态步骤
// （不进持久化 steps），若运行被中断（用户停止 / 看门狗超时 / 出错）且最终未用完整步骤替换，
// 消息里会遗留 running 步骤。运行时在收尾时调用 settleInterruptedSteps 把它们定案为
// status="interrupted"，随消息持久化；渲染层据此显示「已中断」而非无限转圈。
//
// 兜底：若一条 running 步骤已带回「成功结果」（result 非空且 ！isError），说明工具其实已完成，
// 只是因 onToolStep 比 finishTaskResult 慢一拍、或 arguments 序列化差异未匹配上等原因留在了
// running 状态。这种情况不该被打成「已中断」，应保持作为完成态继续渲染——渲染层
// ExecutionTimeline 进一步识别。
import type { ChatStep, Message } from "../adapters/types";

/** 工具步骤是否实际已经成功完成（result 非空 + ！isError）。无论 status 字段为何。 */
export function isResolvedAsSuccess(step: ChatStep): boolean {
  return (
    step.type === "tool_call" &&
    typeof step.result === "string" &&
    step.result.trim().length > 0 &&
    step.isError !== true
  );
}

/** 单条消息：把所有 tool_call 的 running 过渡态定案为 interrupted（无变化返回原数组）。
 *  已经是「成功 result」的 running 步骤跳过——它们其实已完成，避免被误标 interrupted。 */
export function settleMessageSteps(steps: ChatStep[] | undefined): ChatStep[] | undefined {
  if (!steps || steps.length === 0) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.type === "tool_call" && step.status === "running" && !isResolvedAsSuccess(step)) {
      changed = true;
      return { ...step, status: "interrupted" as const };
    }
    return step;
  });
  return changed ? next : steps;
}

/** 消息数组：把所有 running 过渡态步骤定案为 interrupted（幂等；无变化返回原引用） */
export function settleInterruptedSteps(messages: Message[]): Message[] {
  let changed = false;
  const next = messages.map((message) => {
    const settled = settleMessageSteps(message.steps);
    if (settled === message.steps) return message;
    changed = true;
    return { ...message, steps: settled };
  });
  return changed ? next : messages;
}

/** 是否存在未完成（running 过渡态或已中断定案）的工具步骤——摘要/汇总据此避开「已完成」措辞。
 *  已经是「成功 result」的 running 步骤不算未完成（settlement / 渲染层双侧一致）。 */
export function hasIncompleteToolStep(steps: ChatStep[] | undefined): boolean {
  return (
    steps?.some(
      (s) =>
        s.type === "tool_call" &&
        (s.status === "running" || s.status === "interrupted") &&
        !isResolvedAsSuccess(s)
    ) ?? false
  );
}

/** 未完成（running / interrupted）工具步骤的数量（成功完成的 running 不计） */
export function countIncompleteToolSteps(steps: ChatStep[] | undefined): number {
  if (!steps) return 0;
  return steps.reduce(
    (total, s) =>
      total +
      (s.type === "tool_call" &&
      (s.status === "running" || s.status === "interrupted") &&
      !isResolvedAsSuccess(s)
        ? 1
        : 0),
    0
  );
}
