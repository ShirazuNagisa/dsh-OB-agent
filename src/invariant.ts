/**
 * 包不变量伴生（`dsh-ob-agent/invariant`）。
 *
 * 本插件不注册额外的运行时诊断不变量：子代理策略快照在创建及冷恢复入口严格校验。
 * 保留该入口是为了让 profile 组合可以统一引用
 * `<包>/invariant` 而无需对单个插件做特例。
 */

/** 伴生入口名。 */
export const name = 'dsh-ob-agent:invariant'

/** 无操作：本插件没有可断言的不变量。 */
export function apply(): void {
  // 有意为空。
}
