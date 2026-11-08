/**
 * dsh 风格调用策略：目录发现与可调用面分离。
 * 省略字段时两个入口都允许，只有显式 false 才隐藏对应入口。
 */
export type InvocationPolicy = {
  modelInvocable?: boolean;
  userInvocable?: boolean;
};

export function isModelInvocable(policy?: InvocationPolicy | null): boolean {
  return policy?.modelInvocable !== false;
}

export function isUserInvocable(policy?: InvocationPolicy | null): boolean {
  return policy?.userInvocable !== false;
}
