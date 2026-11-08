export type BuiltinCommandId =
  | "file"
  | "goal"
  | "plan"
  | "compact"
  | "permission"
  | "model";

export type BuiltinCommandKind = "add" | "command";

export type BuiltinCommandDefinition = {
  id: BuiltinCommandId;
  command: string;
  title: string;
  description: string;
  commandKind: BuiltinCommandKind;
  /** DSH 式中文输入别名；界面优先展示中文命令，英文规范命令用于稳定执行。 */
  aliases?: string[];
  /**
   * true 表示命令会占用输入框等待参数，例如 `/goal 完成企业版部署`；
   * false 表示选中后立即执行。
   */
  acceptsInput?: boolean;
};

export const BUILTIN_SLASH_COMMANDS: BuiltinCommandDefinition[] = [
  {
    id: "file",
    command: "/file",
    title: "文件",
    description: "添加本地文件或图片",
    commandKind: "add",
    aliases: ["/文件"],
  },
  {
    id: "goal",
    command: "/goal",
    title: "目标",
    description: "设置或查看长期任务目标",
    commandKind: "command",
    aliases: ["/目标"],
    acceptsInput: true,
  },
  {
    id: "plan",
    command: "/plan",
    title: "计划",
    description: "进入或退出计划模式",
    commandKind: "command",
    aliases: ["/计划"],
  },
  {
    id: "compact",
    command: "/compact",
    title: "压缩",
    description: "压缩较早的对话内容",
    commandKind: "command",
    aliases: ["/压缩"],
  },
  {
    id: "permission",
    command: "/permission",
    title: "权限",
    description: "切换默认权限或完全访问",
    commandKind: "command",
    aliases: ["/权限"],
  },
  {
    id: "model",
    command: "/model",
    title: "模型",
    description: "切换当前会话使用的模型",
    commandKind: "command",
    aliases: ["/模型"],
  },
];

export function findBuiltinSlashCommand(input: string): BuiltinCommandDefinition | null {
  const token = input.trim().match(/^\/\S+/)?.[0]?.toLocaleLowerCase();
  if (!token) {
    return null;
  }
  return BUILTIN_SLASH_COMMANDS.find((item) =>
    item.command === token
    || (item.aliases ?? []).some((alias) => alias.toLocaleLowerCase() === token)
  ) ?? null;
}

export function getMatchingBuiltinCommands(query: string): BuiltinCommandDefinition[] {
  const normalized = query.trim().replace(/^\/+/, "").toLocaleLowerCase();
  return BUILTIN_SLASH_COMMANDS.filter((item) => {
    if (!normalized) {
      return true;
    }
    return (
      item.command.slice(1).toLocaleLowerCase().startsWith(normalized)
      || item.title.toLocaleLowerCase().includes(normalized)
      || item.description.toLocaleLowerCase().includes(normalized)
    );
  });
}
