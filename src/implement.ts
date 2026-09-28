/**
 * 纯函数层：一条条目 → 实装动作（档 A 放行 / 档 B 重挂 / 档 C 不可用）。
 *
 * 「可见性」通过注入的 `visibleTool(name)` 判定，因此本模块不依赖任何服务，可被
 * 单元测试完整覆盖。
 */
import {
  CHILD_REPLY_TOOL,
  subagentToolName,
  type EntryMode,
  type NativeImpl,
  type ObAgentEntry,
  type ObAgentSection,
} from './contract.ts'
import { UNAVAILABLE_READONLY } from './defaults.ts'

/** 实装判定所需的只读能力查询。 */
export interface PlanContext {
  /** 该 agent 作用域内某工具名是否已可见（继承层或自有层）。 */
  visibleTool(name: string): boolean
}

/** 子代理条目的实装动作：调用 `@deepseek-ai/dsh-tool-subagent` 的 apply。 */
export interface SubagentInstallPlan {
  readonly kind: 'subagent'
  readonly entry: ObAgentEntry
  readonly mode: EntryMode
  readonly toolName: string
  readonly config: {
    readonly provider: string
    readonly toolName: string
    readonly backgroundMode: EntryMode
    readonly enableRunInBackground: boolean
    readonly maxDepth: number
    readonly agentOptions?: { provider: string; model: string; reasoningEffort?: string }
    readonly persona?: string
    readonly toolFilter?: { allow: readonly string[] }
  }
}

/** 原生条目的实装动作。 */
export interface NativeInstallPlan {
  readonly kind: 'native'
  readonly entry: ObAgentEntry
  readonly impl: NativeImpl
  /**
   * `passthrough`：继承层已经提供（档 A），只需从拒绝集移除；
   * `install`：本层重挂（档 B）；
   * `plugin`：由本插件自己注册（自助管理工具）。
   */
  readonly action: 'passthrough' | 'install' | 'plugin'
  readonly toolNames: readonly string[]
  /**
   * 只安装实现包里的这些工具名（缺省 = 安装该包提供的全部工具）。
   *
   * 用途：子代理回发父代理只放行 `send_message`，而 `@deepseek-ai/dsh-tool-subagent-control`
   * 一次注册 `send_message` 与 `interrupt_agent` 两个工具 —— 整包装配会把子代理不该有的
   * 中断能力一并带出来。
   */
  readonly onlyTools?: readonly string[]
}

export type InstallPlan = SubagentInstallPlan | NativeInstallPlan

/** 实装判定结果。 */
export type PlanResult =
  | { readonly ok: true; readonly plan: InstallPlan }
  | { readonly ok: false; readonly reason: string }

/** 只读条目的有效白名单 = 条目白名单（或全局白名单）∩ 该作用域真实可见工具。 */
export function effectiveReadOnly(
  entry: ObAgentEntry,
  section: Pick<ObAgentSection, 'readOnlyTools'>,
  context: PlanContext,
): string[] {
  const declared = entry.readOnlyAllow ?? section.readOnlyTools
  return declared.filter(name => context.visibleTool(name))
}

/** 子代理条目 → 一次装配（一种模式一个工具）。 */
export function planSubagent(
  entry: ObAgentEntry,
  mode: EntryMode,
  section: Pick<ObAgentSection, 'readOnlyTools'>,
  context: PlanContext,
): PlanResult {
  const toolName = subagentToolName(entry.id, mode)
  let toolFilter: { allow: readonly string[] } | undefined
  if (entry.permission === 'readonly') {
    const allow = effectiveReadOnly(entry, section, context)
    if (allow.length === 0) return { ok: false, reason: UNAVAILABLE_READONLY }
    toolFilter = { allow }
  }
  return {
    ok: true,
    plan: {
      kind: 'subagent',
      entry,
      mode,
      toolName,
      config: {
        provider: entry.provider,
        toolName,
        backgroundMode: mode,
        enableRunInBackground: true,
        maxDepth: 3,
        ...(entry.model !== undefined
          ? {
              agentOptions: {
                provider: entry.model.provider,
                model: entry.model.model,
                ...(entry.model.reasoningEffort !== undefined ? { reasoningEffort: entry.model.reasoningEffort } : {}),
              },
            }
          : {}),
        ...(entry.identityPrompt !== undefined ? { persona: entry.identityPrompt } : {}),
        ...(toolFilter !== undefined ? { toolFilter } : {}),
      },
    },
  }
}

/** 原生条目 → 放行 / 重挂 / 本插件注册。 */export function planNative(entry: ObAgentEntry, context: PlanContext): PlanResult {
  const impl = entry.impl
  const declared = entry.toolNames ?? []
  if (impl === undefined) return { ok: false, reason: '原生条目缺少实现标识' }
  if (declared.length === 0) return { ok: false, reason: '原生条目未声明工具名' }
  if (impl === 'authoring') {
    return { ok: true, plan: { kind: 'native', entry, impl, action: 'plugin', toolNames: declared } }
  }
  const visible = declared.filter(name => context.visibleTool(name))
  if (impl === 'subagent-preset') {
    if (visible.length === 0) {
      return { ok: false, reason: `当前会话预设没有装配这些具名子代理工具：${declared.join('、')}` }
    }
    return { ok: true, plan: { kind: 'native', entry, impl, action: 'passthrough', toolNames: visible } }
  }
  // list-agents 由本插件改写结果（补「本会话可用的子代理工具」清单），因此必须自己持有该工具：
  // 即使继承层已经可见也走 install。自有层注册会遮蔽全局同名工具（合法、不抛错），
  // 否则首轮 passthrough 会让改写依赖「第二轮重算」这一隐式时序。
  if (impl === 'list-agents') {
    return { ok: true, plan: { kind: 'native', entry, impl, action: 'install', toolNames: declared } }
  }
  if (visible.length === declared.length) {
    return { ok: true, plan: { kind: 'native', entry, impl, action: 'passthrough', toolNames: declared } }
  }
  return { ok: true, plan: { kind: 'native', entry, impl, action: 'install', toolNames: declared } }
}

/**
 * 子代理回发计划的安装键。
 *
 * 刻意不采用 `keyOf` 的 `nat:<条目 id>` 形状：`~` 不是合法条目标识字符
 * （见 `ENTRY_ID_PATTERN`），因此用户自建条目永远不可能撞上这个键。
 */
export const CHILD_REPLY_KEY = 'nat:~child-reply'

/**
 * 子代理回发给直接父代理的装配计划（只安装 `send_message`）。
 *
 * 为什么在子代理自有层重挂而不是「继承面有就不装」：委派工具在父会话里既能放行继承面、
 * 也能由本插件重挂在父 agent 自有层，而父自有层不会传播给子代理（子代理只与父代理
 * 共用同一份预设组合）。统一重挂让两种来源表现一致；自有层注册遮蔽同名继承工具是合法操作。
 * @param entry - 提供 `send_message` 的原生条目（`impl === 'control'`）。
 * @returns 只安装 `send_message` 的重挂计划；没有可用条目时 undefined。
 */
export function planChildReply(entry: ObAgentEntry | undefined): InstallPlan | undefined {
  if (entry === undefined || entry.impl !== 'control') return undefined
  if (!entry.toolNames?.includes(CHILD_REPLY_TOOL)) return undefined
  return {
    kind: 'native',
    entry,
    impl: 'control',
    action: 'install',
    toolNames: [CHILD_REPLY_TOOL],
    onlyTools: [CHILD_REPLY_TOOL],
  }
}
