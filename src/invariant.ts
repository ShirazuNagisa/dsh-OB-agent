/**
 * 包不变量伴生（`dsh-ob-agent/invariant`）。
 *
 * 本插件不注册任何运行时诊断不变量：它的全部状态都来自设置段与 DSH 自身的注册表，
 * 没有需要跨进程断言的自有数据结构。保留该入口是为了让 profile 组合可以统一引用
 * `<包>/invariant` 而无需对单个插件做特例。
 */

/** 伴生入口名。 */
export const name = 'dsh-ob-agent:invariant'

/** 无操作：本插件没有可断言的不变量。 */
export function apply(): void {
  // 有意为空。
}
