/**
 * 浏览器侧设置桥的单元测试：默认值回落、会话选择写入（含最近使用裁剪）、原子写入
 * 与订阅失效。用假的作用域句柄覆盖，不需要真实浏览器环境。
 */
import { describe, expect, it } from 'vitest'
import { MAX_SESSION_STATES } from '../src/contract.ts'
import type { ClientSettingsScope } from '../src/context-types.ts'
import { createObAgentStore, type ObAgentWire } from '../src/client/store.ts'
import { normalizeCatalog } from '../src/client/modelcatalog.ts'

/** 假的作用域句柄：记录写入、可手工推送新快照。 */
function fakeScope(initial: unknown = undefined): ClientSettingsScope<ObAgentWire> & {
  readonly sets: { field: string; value: unknown }[]
  readonly mutates: unknown[]
  push(value: unknown): void
  failNext(message: string): void
} {
  const listeners = new Set<() => void>()
  const sets: { field: string; value: unknown }[] = []
  const mutates: unknown[] = []
  let value = initial
  let writable = true
  let failure: string | undefined
  return {
    sets,
    mutates,
    getSnapshot: () => ({ status: 'ready', value: value as ObAgentWire, revision: 1, writable, mode: 'host' }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field, next) => {
      if (failure !== undefined) {
        const message = failure
        failure = undefined
        throw new Error(message)
      }
      sets.push({ field, value: next })
    },
    unset: async () => undefined,
    mutate: async (ops) => {
      if (failure !== undefined) {
        const message = failure
        failure = undefined
        throw new Error(message)
      }
      mutates.push(ops)
    },
    push: (next) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
    failNext: (message) => {
      failure = message
      writable = true
    },
  }
}

describe('createObAgentStore', () => {
  it('命名空间为空时给出出厂默认视图', () => {
    const store = createObAgentStore(fakeScope(), 's1')
    const snapshot = store.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.section.entries.length).toBeGreaterThan(0)
    expect(snapshot.session.enabled).toBe(false)
    expect(snapshot.session.selected).toContain('general')
  })

  it('getSnapshot 在失效前返回同一引用', () => {
    const store = createObAgentStore(fakeScope(), 's1')
    expect(store.getSnapshot()).toBe(store.getSnapshot())
  })

  it('作用域推送新快照后订阅者被通知且快照重建', () => {
    const scope = fakeScope()
    const store = createObAgentStore(scope, 's1')
    let notified = 0
    store.subscribe(() => { notified += 1 })
    const before = store.getSnapshot()
    scope.push({ masterEnabledDefault: true })
    expect(notified).toBe(1)
    expect(store.getSnapshot()).not.toBe(before)
    expect(store.getSnapshot().session.enabled).toBe(true)
  })

  it('写入会话选择时把本会话放在最后，并裁剪到上限', () => {
    const scope = fakeScope()
    const sessions: Record<string, unknown> = {}
    for (let i = 0; i < MAX_SESSION_STATES; i += 1) sessions[`old${i}`] = { enabled: true, selected: [] }
    scope.push({ sessions })
    const store = createObAgentStore(scope, 'new')
    return store.setSession({ enabled: true, selected: ['general'] }).then((failure) => {
      expect(failure).toBeUndefined()
      const written = scope.sets[0]?.value as Record<string, unknown>
      const keys = Object.keys(written)
      expect(keys).toHaveLength(MAX_SESSION_STATES)
      expect(keys[keys.length - 1]).toBe('new')
      expect(keys).not.toContain('old0')
    })
  })

  it('原子写入把字段映射成路径操作', async () => {
    const scope = fakeScope()
    const store = createObAgentStore(scope, 's1')
    const failure = await store.patch({ masterEnabledDefault: true, entries: [] })
    expect(failure).toBeUndefined()
    expect(scope.mutates[0]).toEqual([
      { op: 'set', path: ['masterEnabledDefault'], value: true },
      { op: 'set', path: ['entries'], value: [] },
    ])
  })

  it('写入失败时返回中文原因，冲突单独提示重试', async () => {
    const scope = fakeScope()
    const store = createObAgentStore(scope, 's1')
    scope.failNext('SETTINGS_CONFLICT: revision moved')
    expect(await store.setSession({ enabled: true, selected: [] })).toContain('请刷新后重试')
    scope.failNext('boom')
    expect(await store.patch({})).toContain('设置写入失败')
  })

  it('dispose 之后不再收到通知', () => {
    const scope = fakeScope()
    const store = createObAgentStore(scope, 's1')
    let notified = 0
    store.subscribe(() => { notified += 1 })
    store.dispose()
    scope.push({ masterEnabledDefault: true })
    expect(notified).toBe(0)
  })
})

describe('normalizeCatalog', () => {
  it('抽取 provider / model / 思考等级', () => {
    const providers = normalizeCatalog({
      groups: [
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          models: [{ id: 'hy4-preview', name: 'Hy4', reasoning: { efforts: [{ id: 'high' }, { id: 'max' }] } }],
        },
      ],
    })
    expect(providers).toHaveLength(1)
    expect(providers[0]?.models[0]).toEqual({ id: 'hy4-preview', name: 'Hy4', efforts: ['high', 'max'] })
  })

  it('形状异常时给出空清单而不是抛错', () => {
    expect(normalizeCatalog(undefined)).toEqual([])
    expect(normalizeCatalog({ groups: 'nope' })).toEqual([])
    expect(normalizeCatalog({ groups: [{ models: [] }, { id: 'ok', models: [{ name: '无 id' }] }] })).toEqual([
      { id: 'ok', name: 'ok', models: [] },
    ])
  })
})
