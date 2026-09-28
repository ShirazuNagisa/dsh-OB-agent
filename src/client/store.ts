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
