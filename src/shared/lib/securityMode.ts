// 启动前默认严格；有效状态只由 Rust app_boot / security_set 返回值更新。
let strictSecurity = true;

/** 当前是否启用严格安全模式（默认开启）。 */
export function isStrictSecurity(): boolean {
  return strictSecurity;
}

/** 切换严格安全模式（关闭后回退为兼容清洗与链接策略）。 */
export function setStrictSecurity(strict: boolean): void {
  strictSecurity = strict;
}
