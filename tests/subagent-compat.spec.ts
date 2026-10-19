/** 新版 activation 适配、策略持久化及恢复失败关闭。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLike, HostContext, ToolDefinitionLike, ToolExecLike } from '../src/context-types.ts'
import { applyChildPolicy, installChildPolicies, persistPolicy, readChildPolicy, subagentContext, validatePolicy, type ChildPolicy } from '../src/subagent-compat.ts'
import { planSubagent } from '../src/implement.ts'
import { DEFAULT_SECTION } from '../src/defaults.ts'

const childId = 'obagent-00000000-0000-4000-8000-000000000001'
const policy: ChildPolicy = { version: 1, childId, parentId: 'parent', mode: 'continuable', identityPrompt: '独立审计员', allow: ['read'] }
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ob-agent-policy-test-'))
  directories.push(directory)
  return directory
}

function childHarness() {
  const guards: Array<(exec: ToolExecLike) => string | undefined> = []
  const sections: Array<{ name: string; text: string }> = []
  const filters: unknown[] = []
  const runtime = {
    get: (name: string) => name === 'tools' ? {
      guard: (fn: (exec: ToolExecLike) => string | undefined) => { guards.push(fn); return () => undefined },
      restrict: (filter: { allow: string[] }) => {
        if (filter.allow.includes('own')) throw new Error('unknown global tool')
        filters.push(filter)
        return () => undefined
      },
    } : { section: (s: { name: string; text: string }) => { sections.push(s) }, getSectionOrder: () => 0 },
  }
  const agent = {
    id: childId,
    session: { header: { origin: 'subagent', parentSession: 'parent' } },
    ctx: { inject: (_: unknown, fn: (ctx: unknown) => void) => {
      const ready = Promise.resolve().then(() => fn(runtime))
      return { await: () => ready, dispose: () => undefined }
    } },
  } as unknown as AgentLike
  return { agent, guards, sections, filters, deny: (name: string, args?: Record<string, unknown>) => guards.map(fn => fn({ name, arguments: args })).find(Boolean) }
}

describe('子代理策略持久化', () => {
  it('创建前写入不可覆盖快照，冷读取保持身份和权限', async () => {
    const directory = await temporaryDirectory()
    await persistPolicy(policy, directory)
    expect(await readChildPolicy(childId, directory)).toEqual(policy)
    await expect(persistPolicy({ ...policy, allow: ['write'] }, directory)).rejects.toThrow()
    expect(await readChildPolicy(childId, directory)).toEqual(policy)
  })
  it('原生 UUID 不受影响，插件命名空间缺失或损坏均拒绝', async () => {
    const directory = await temporaryDirectory()
    expect(await readChildPolicy('native-child', directory)).toBeUndefined()
    await expect(readChildPolicy(childId, directory)).rejects.toThrow('拒绝')
    await writeFile(join(directory, `${childId}.json`), '{broken')
    await expect(readChildPolicy(childId, directory)).rejects.toThrow('拒绝')
  })
  it.each([
    { ...policy, version: 2 }, { ...policy, parentId: '' }, { ...policy, childId: '../escape' },
    { ...policy, allow: [] }, { ...policy, allow: ['run_code'] }, { ...policy, allow: ['read', 'read'] },
    { ...policy, unexpected: true }, { ...policy, mode: 'one-shot' },
  ])('严格校验未知版本/非法身份/白名单/未知字段', value => {
    expect(() => validatePolicy(value, childId)).toThrow()
  })
})

describe('创建及冷恢复时策略装配', () => {
  it('身份覆盖父预设前后缀，只读守卫覆盖写入与后注册工具', async () => {
    const h = childHarness()
    await applyChildPolicy(h.agent, policy)
    expect(h.sections).toEqual([
      { name: 'deployment:persona-prefix', order: 0, text: '独立审计员' },
      { name: 'deployment:persona-suffix', order: 0, text: '' },
    ])
    expect(h.deny('read')).toBeUndefined()
    for (const name of ['write', 'pwsh', 'workflow', 'new_mcp_tool', 'run_code']) expect(h.deny(name)).toContain('只读')
    expect(h.filters.at(-1)).toEqual({ allow: ['read'] })
  })
  it('自有层白名单无法 restrict 时，其他工具仍被守卫拒绝', async () => {
    const h = childHarness()
    await applyChildPolicy(h.agent, { ...policy, allow: ['own'] })
    expect(h.filters.at(-1)).toEqual({ allow: [] })
    expect(h.deny('own')).toBeUndefined()
    expect(h.deny('write')).toContain('只读')
  })
  it('串行创建钩子等待策略，冷恢复重装同一快照，原生子代理不受影响', async () => {
    vi.stubEnv('DSH_OB_AGENT_POLICY_DIR', await temporaryDirectory())
    await persistPolicy(policy)
    let listener!: (payload: { agent: AgentLike }) => Promise<void>
    installChildPolicies({ on: (_event: string, fn: typeof listener) => { listener = fn; return () => undefined } } as unknown as HostContext)
    const fresh = childHarness()
    await listener({ agent: fresh.agent })
    expect(fresh.deny('write')).toContain('只读')
    await listener({ agent: fresh.agent })
    expect(fresh.sections).toHaveLength(2)
    const resumed = childHarness()
    await listener({ agent: resumed.agent })
    expect(resumed.deny('write')).toContain('只读')
    const native = { id: 'native-child', session: {}, ctx: {} } as unknown as AgentLike
    await expect(listener({ agent: native })).resolves.toBeUndefined()
  })
  it('缺失快照和缺服务都会否决创建，不能假装装配成功', async () => {
    vi.stubEnv('DSH_OB_AGENT_POLICY_DIR', await temporaryDirectory())
    let listener!: (payload: { agent: AgentLike }) => Promise<void>
    installChildPolicies({ on: (_event: string, fn: typeof listener) => { listener = fn; return () => undefined } } as unknown as HostContext)
    await expect(listener({ agent: childHarness().agent })).rejects.toThrow('拒绝')
    const missing = childHarness().agent
    ;(missing as { ctx: unknown }).ctx = { inject: () => ({ await: async () => undefined, dispose: async () => undefined }) }
    await expect(applyChildPolicy(missing, policy)).rejects.toThrow('缺少工具或提示词服务')
  })

  it('只读回发仅限父代理，不同父子身份拒绝装配', async () => {
    const h = childHarness()
    await applyChildPolicy(h.agent, { ...policy, allow: ['read', 'send_message'] })
    expect(h.deny('send_message', { agent_id: 'parent' })).toBeUndefined()
    expect(h.deny('send_message', { agent_id: 'other' })).toContain('直接父代理')
    await expect(applyChildPolicy(h.agent, { ...policy, parentId: 'wrong' })).rejects.toThrow('不匹配')
  })
})

function delegationHarness(mode: 'continuable', start?: (spec: Record<string, unknown>) => Promise<unknown>) {
  const entry = { ...DEFAULT_SECTION.entries.find(e => e.id === 'general')!, modes: [mode] }
  const result = planSubagent(entry, mode, DEFAULT_SECTION, { visibleTool: () => true })
  if (!result.ok || result.plan.kind !== 'subagent') throw new Error('plan failed')
  let registered: ToolDefinitionLike | undefined
  const calls: Record<string, unknown>[] = []
  const dispose = vi.fn(async () => undefined)
  const service = { startActivation: async (spec: Record<string, unknown>) => {
    calls.push(spec)
    const saved = await readChildPolicy(spec.childId as string)
    expect(saved?.parentId).toBe('parent')
    return start ? start(spec) : { childId: spec.childId, result: Promise.resolve({ output: [{ type: 'text', text: '结论' }], stopReason: 'completed' }), dispose }
  } }
  const tools = { register: (definition: ToolDefinitionLike) => { registered = definition; return () => undefined } }
  const ctx = { get: (name: string) => name === 'subagents' ? service : tools } as unknown as HostContext
  const adapted = subagentContext(ctx, result.plan)
  const native = {
    name: result.plan.toolName, description: 'delegate', parameters: { type: 'object' }, output: { schema: {}, render: () => [] },
    execute: async () => {
      const activation = await (adapted.get('subagents') as typeof service).startActivation({ request: { parent: { id: 'parent' } }, signal: new AbortController().signal }) as { childId: string }
      return { kind: 'activation', subagentId: activation.childId }
    },
  }
  ;(adapted.get('tools') as typeof tools).register(native)
  return { definition: () => registered!, calls, dispose }
}

describe('公开 activation 适配', () => {
  it('可继续模式立刻返回 ID，且启动前已保存策略', async () => {
    vi.stubEnv('DSH_OB_AGENT_POLICY_DIR', await temporaryDirectory())
    const h = delegationHarness('continuable')
    const value = await h.definition().execute({}, {}) as { subagentId: string }
    expect(value.subagentId).toMatch(/^obagent-/)
    expect(h.calls[0].delivery).toBeUndefined()
    expect(h.dispose).not.toHaveBeenCalled()
  })
  it('策略目录不可写时不创建子代理', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'blocked')
    await writeFile(file, 'not a directory')
    vi.stubEnv('DSH_OB_AGENT_POLICY_DIR', file)
    const h = delegationHarness('continuable')
    await expect(h.definition().execute({}, {})).rejects.toThrow()
    expect(h.calls).toHaveLength(0)
    expect(await readFile(file, 'utf8')).toBe('not a directory')
  })

})
