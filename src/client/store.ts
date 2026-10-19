/**
 * 浏览器侧的状态桥：把插件配置快照归一化成界面直接可用的形状。
 *
 * 会话选择存在配置段的 `sessions` 映射里（键为会话 id），因此这里不需要自定义
 * Remote / 投影 / HTTP 路由——写入直接走宿主已有的 configForms 通道，读取走同一
 * 份快照，天然与主机看到的状态一致。
 */
import {
  MAX_SESSION_STATES,
  type ObAgentSection,
  type ObAgentSessionState,
} from '../contract.ts'
import type { ClientSettingsScope, Disposer, ObservableLike } from '../context-types.ts'
import { readSection } from '../normalize.ts'
import { effectiveSelection } from '../plan.ts'

/** 浏览器侧拿到的设置段（字段可能缺失，由 readSection 补齐）。 */
export type ObAgentWire = Record<string, unknown>

/** 界面快照。 */
export interface ObAgentSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly writable: boolean
  /** 归一化后的设置段（含出厂默认）。 */
  readonly section: ObAgentSection
  /** 本会话的有效选择（无记录时回落到出厂默认）。 */
  readonly session: ObAgentSessionState
  /**
   * 「智能体团队模式」是否开启（取自设置段的同名字段）：
   * 开启后本插件不接管代理，界面转为只读说明 + 一个可退出该模式的开关，
   * 与官方团队的实际避让由主机侧（backend）完成。
   */
  readonly teamMode: boolean
}

/** 浏览器侧设置桥。 */
export interface ObAgentStore extends ObservableLike<ObAgentSnapshot> {
  /** 写入本会话选择（含按最近使用的裁剪）。 */
  setSession(next: ObAgentSessionState): Promise<string | undefined>
  /** 原子写入若干设置字段。 */
  patch(fields: Record<string, unknown>): Promise<string | undefined>
  /** 释放订阅。 */
  dispose(): void
}

// ── 界面决策（纯函数，界面只调用不重写，便于离线回归） ────────────────────────

/** dock 条目区是否只读。 */
export interface DockLockState {
  readonly writable: boolean
  readonly pending: boolean
  readonly teamMode: boolean
}

/** dock 首行摘要的输入。 */
export interface DockSummaryState extends DockLockState {
  readonly enabled: boolean
  readonly count: number
}

/** 设置页两个锁的输入。 */
export interface SettingsLockState {
  readonly writable: boolean
  readonly saving: boolean
  readonly teamMode: boolean
}

/** dock 首行摘要对应的文案键（优先级的唯一定义处）。 */
export type DockSummaryKey =
  | 'dock.pending' | 'dock.teamLocked' | 'dock.readonly' | 'dock.blocked' | 'dock.none' | 'dock.count'

/**
 * dock 条目区是否只读。
 *
 * 团队模式也算锁：此时本插件不接管代理，勾选条目没有意义。注意**首行展开按钮不受它影响**
 * （见 `isDockExpandable`），否则团队模式打开后就无法从 dock 退出了。
 * @param state - 写入中 / 设置只读 / 团队模式。
 * @returns 只读时为 true。
 */
export function dockLocked(state: DockLockState): boolean {
  return state.pending || !state.writable || state.teamMode
}

/**
 * dock 首行是否可展开（也决定首行按钮是否可点、要不要显示箭头）。
 *
 * 团队模式下即使会话总开关是关的也必须可展开：展开里的那行开关是退出团队模式唯一的入口。
 * @param state - 会话总开关与团队模式。
 * @returns 可展开时为 true。
 */
export function isDockExpandable(state: { enabled: boolean; teamMode: boolean }): boolean {
  return state.enabled || state.teamMode
}

/**
 * dock 首行摘要的文案键（写入中 → 团队模式 → 只读 → 未开启 → 未勾选 → 计数）。
 *
 * 顺序即优先级：团队模式排在最前（它一开启，条目勾选与总开关都失去意义，摘要必须说明让位），
 * 「未开启」在「未勾选」之前——总开关关着时说「未勾选任何条目」会掩盖真正的原因。
 * @param state - 摘要所需状态。
 * @returns 文案键。
 */
export function dockSummaryKey(state: DockSummaryState): DockSummaryKey {
  if (state.pending) return 'dock.pending'
  if (state.teamMode) return 'dock.teamLocked'
  if (!state.writable) return 'dock.readonly'
  if (!state.enabled) return 'dock.blocked'
  if (state.count === 0) return 'dock.none'
  return 'dock.count'
}

/**
 * 设置页的两把锁。
 *
 * 团队模式只锁「其它字段」：那一行开关本身必须保持可操作（否则打开后就再也关不掉）。
 * @param state - 保存中 / 设置只读 / 团队模式。
 * @returns 其它字段是否只读，以及团队模式开关是否可操作。
 */
export function settingsLocked(state: SettingsLockState): { others: boolean; teamModeSwitch: boolean } {
  const basic = state.saving || !state.writable
  return { others: basic || state.teamMode, teamModeSwitch: basic }
}

/** 把写入失败翻译成中文原因（冲突单独提示重试）。 */
function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/conflict|revision|409/i.test(raw)) return `设置已被其它窗口或进程修改，请刷新后重试（${raw}）`
  return `设置写入失败：${raw}`
}

/**
 * 建立设置桥。
 * @param scope - 插件配置的字段读写句柄。
 * @param sessionId - 会话 id；设置页与主机侧全局判断可传空串（只会命中默认选择）。
 */
export function createObAgentStore(scope: ClientSettingsScope<ObAgentWire>, sessionId: string): ObAgentStore {
  const listeners = new Set<() => void>()
  let cached: ObAgentSnapshot | undefined

  const compute = (): ObAgentSnapshot => {
    const raw = scope.getSnapshot()
    const section = readSection(raw.value)
    return {
      status: raw.status,
      writable: raw.writable,
      section,
      session: effectiveSelection(section, sessionId),
      teamMode: section.teamMode,
    }
  }

  const invalidate = (): void => {
    cached = undefined
    for (const listener of [...listeners]) listener()
  }

  const off: Disposer = scope.subscribe(invalidate)

  return {
    getSnapshot(): ObAgentSnapshot {
      cached ??= compute()
      return cached
    },
    subscribe(listener: () => void): Disposer {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async setSession(next: ObAgentSessionState): Promise<string | undefined> {
      const section = compute().section
      const map: Record<string, ObAgentSessionState> = {}
      for (const [key, value] of Object.entries(section.sessions)) {
        if (key !== sessionId) map[key] = value
      }
      // 本会话放在最后：对象键序即「最近使用」序，裁剪时丢弃最早的键。
      map[sessionId] = { enabled: next.enabled, selected: [...next.selected] }
      const keys = Object.keys(map)
      if (keys.length > MAX_SESSION_STATES) {
        for (const key of keys.slice(0, keys.length - MAX_SESSION_STATES)) delete map[key]
      }
      try {
        await scope.set('sessions', map)
        return undefined
      } catch (error) {
        return messageOf(error)
      }
    },
    async patch(fields: Record<string, unknown>): Promise<string | undefined> {
      const ops = Object.entries(fields).map(([path, value]) => ({ op: 'set' as const, path: [path], value }))
      try {
        await scope.mutate(ops)
        return undefined
      } catch (error) {
        return messageOf(error)
      }
    },
    dispose(): void {
      off()
      listeners.clear()
    },
  }
}
