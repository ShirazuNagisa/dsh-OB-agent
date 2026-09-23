/**
 * 设置命名空间 `ob-agent` 的 host 侧：schemastery 模式、注册、写入。
 *
 * 模式刻意宽松（复杂字段用 `z.any()`）：真实校验在 `normalize.ts` 里用 TypeScript
 * 完成并给出中文原因；这样一次非法写入不会让整个命名空间解析失败（那会连带设置页
 * 不可用）。缺省字段由 `readSection` 补齐，因此 `replace({})` 就是「恢复出厂」。
 *
 * 本文件 import schemastery，**只能被 host 半引用**（浏览器 bundle 无法 require 它）；
 * 纯逻辑都在 `normalize.ts`。
 */
import z from '@deepseek-ai/schemastery'
import { OB_AGENT_NAMESPACE } from './contract.ts'
import type { HostSettingsScope, SettingsServiceLike } from './context-types.ts'

/** 设置段模式：结构合法即可，语义校验交给 `normalize.ts`。 */
export const SECTION_SCHEMA = z.object({
  defaultsRevision: z.number(),
  masterEnabledDefault: z.boolean(),
  readOnlyTools: z.array(z.string()),
  promptVariables: z.array(z.string()),
  autoEnableControlWithContinuable: z.boolean(),
  gate: z.any(),
  authoring: z.any(),
  modelGuide: z.any(),
  entries: z.any(),
  sessions: z.any(),
})

/** 注册本插件的设置命名空间，返回属主句柄。 */
export function registerSettings(settings: SettingsServiceLike): HostSettingsScope<unknown> {
  return settings.register<unknown>(OB_AGENT_NAMESPACE, SECTION_SCHEMA)
}
