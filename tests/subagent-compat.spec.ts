/**
 * 新版 activation 适配、策略持久化、home 解析、命名空间边界与恢复失败关闭。
 *
 * 本文件覆盖的是本插件对上游的**假设**：策略目录怎么解析、快照怎么写/怎么拒、身份与
 * 只读怎么装配、代理是否保住了 cordis 的作用域语义。最后一组把这些假设拿到**真实**
 * `@deepseek-ai/cordis` + `dsh-system-prompt` + `dsh-tools` 上跑一遍；找不到 DSH 运行时
 * 时整组跳过（与 `dsh-compat.spec.ts` 同一策略），跳过的原因会打印出来。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLike, HostContext, ToolDefinitionLike, ToolExecLike } from '../src/context-types.ts'
import {
  applyChildPolicy,
  installChildPolicies,
  persistPolicy,
  policyDirectory,
  readChildPolicy,
  resolveHostHome,
  subagentContext,
  validatePolicy,
  type ChildPolicy,
  type DshHomeSource,
} from '../src/subagent-compat.ts'
import { planSubagent } from '../src/implement.ts'
import { DEFAULT_SECTION } from '../src/defaults.ts'

const childId = 'obagent-00000000-0000-4000-8000-000000000001'
const policy: ChildPolicy = { version: 1, childId, parentId: 'parent', mode: 'continuable', identityPrompt: '独立审计员', allow: ['read'] }

const directories: string[] = []
/** 本文件显式改过的环境变量；每个用例前后都复原，保证结果与开发机环境无关。 */
const savedEnv = new Map<string, string | undefined>()
const MANAGED_ENV = ['DSH_HOME', 'DSH_OB_AGENT_POLICY_DIR'] as const

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ob-agent-policy-test-'))
  directories.push(directory)
  return directory
}

beforeEach(() => {
  // 每个用例都从「没有 DSH_HOME / 没有插件逃生口」开始：用例结果不依赖开发机环境。
  for (const name of MANAGED_ENV) setEnv(name, undefined)
})

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('宿主 home 与策略目录解析', () => {
  it('显式 home 优先于 $DSH_HOME，空白显式值视为未配置', async () => {
    const root = await temporaryDirectory()
    const explicit = join(root, 'explicit-home')
    const fromEnv = join(root, 'env-home')
    setEnv('DSH_HOME', fromEnv)

    expect(resolveHostHome(explicit)).toBe(resolve(explicit))
    expect(policyDirectory(explicit)).toBe(join(resolve(explicit), 'plugins', 'dsh-ob-agent', 'child-policies'))
    // 空串绝不能解析成当前工作目录：官方 resolveDshHome('') 会 resolve('')，必须在调用前拦下。
    expect(resolveHostHome('')).toBe(resolve(fromEnv))
    expect(resolveHostHome('   ')).toBe(resolve(fromEnv))
    expect(resolveHostHome(() => undefined)).toBe(resolve(fromEnv))
  })

  it('未配置任何来源时回落到用户 .dsh，并展开 ~ 前缀', () => {
    expect(resolveHostHome()).toBe(resolve(join(homedir(), '.dsh')))
    expect(resolveHostHome('  ')).toBe(resolve(join(homedir(), '.dsh')))
    expect(resolveHostHome('~')).toBe(resolve(homedir()))
    expect(resolveHostHome('~/probe-home')).toBe(resolve(join(homedir(), 'probe-home')))
  })

  it('空白 $DSH_HOME 视为未设置', () => {
    setEnv('DSH_HOME', '   ')
    expect(resolveHostHome()).toBe(resolve(join(homedir(), '.dsh')))
  })

  it('DSH_OB_AGENT_POLICY_DIR 覆盖显式 home，空白值视为未设置', async () => {
    const root = await temporaryDirectory()
    const explicit = join(root, 'explicit-home')
    const override = join(root, 'override')
    setEnv('DSH_OB_AGENT_POLICY_DIR', override)
    expect(policyDirectory(explicit)).toBe(resolve(override))
    setEnv('DSH_OB_AGENT_POLICY_DIR', '  ')
    expect(policyDirectory(explicit)).toBe(join(resolve(explicit), 'plugins', 'dsh-ob-agent', 'child-policies'))
  })

  it('getter 形式跟随设置热更新（创建与恢复用同一来源）', async () => {
    const root = await temporaryDirectory()
    const first = join(root, 'home-1')
    const second = join(root, 'home-2')
    let current: string | undefined = first
    const source: DshHomeSource = () => current
    expect(resolveHostHome(source)).toBe(resolve(first))
    current = second
    expect(policyDirectory(source)).toBe(join(resolve(second), 'plugins', 'dsh-ob-agent', 'child-policies'))
    current = undefined
    expect(resolveHostHome(source)).toBe(resolve(join(homedir(), '.dsh')))
  })
})

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
    { ...policy, identityPrompt: '' }, { ...policy, identityPrompt: '   ' }, { ...policy, identityPrompt: 7 },
  ])('严格校验未知版本/非法身份/白名单/空白身份/未知字段', value => {
    expect(() => validatePolicy(value, childId)).toThrow()
  })
})

/** 以假运行时观察装配结果：守卫、提示词段、隐藏层与注入调用。 */
function childHarness(options: {
  id?: string
  header?: Record<string, unknown>
  activate?: boolean
} = {}) {
  const guards: Array<(exec: ToolExecLike) => string | undefined> = []
  const sections: Array<{ name: string; order: number; text: string }> = []
  const filters: unknown[] = []
  const tools = {
    guard: (fn: (exec: ToolExecLike) => string | undefined) => { guards.push(fn); return () => undefined },
    restrict: (filter: { allow: string[] }) => {
      // 自有层名字在真实宿主上会整批抛错；这里同形模拟，验证降级路径不会让白名单整体失效。
      if (filter.allow.includes('own')) throw new Error('unknown global tool')
      filters.push(filter)
      return () => undefined
    },
  }
  const systemPrompt = {
    section: (section: { name: string; order: number; text: string }) => { sections.push(section); return () => undefined },
    getSectionOrder: (name: string) => name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 10200,
  }
  const runtime = {
    get: (name: string) => name === 'tools' ? tools : systemPrompt,
  }
  const agent = {
    id: options.id ?? childId,
    session: { header: options.header ?? { origin: 'subagent', parentSession: 'parent' } },
    ctx: {
      inject: (_services: unknown, fn: (ctx: unknown) => void) => options.activate === false
        ? { await: async () => undefined, dispose: async () => undefined }
        : { await: () => Promise.resolve().then(() => fn(runtime)), dispose: () => undefined },
    },
  } as unknown as AgentLike
  return {
    agent, guards, sections, filters,
    deny: (name: string, args?: Record<string, unknown>) => guards.map(fn => fn({ name, arguments: args })).find(Boolean),
  }
}

/** 造一个只会记录监听器的宿主上下文。 */
function listenerHost(): { ctx: HostContext; fire: (agent: AgentLike) => Promise<void> } {
  let listener!: (payload: { agent: AgentLike }) => Promise<void>
  const ctx = { on: (_event: string, fn: typeof listener) => { listener = fn; return () => undefined } } as unknown as HostContext
  return { ctx, fire: agent => listener({ agent }) }
}

describe('创建及冷恢复时策略装配', () => {
  it('身份只覆盖 persona 前缀，不再注册空后缀去遮蔽部署 personaSuffix', async () => {
    const h = childHarness()
    await applyChildPolicy(h.agent, policy)
    // 官方 dsh-subagent 的子代理组合也只写前缀；空后缀会按 dsh-scope 的「最近层同名胜出」
    // 把部署级/父预设的 personaSuffix 抹掉，因此这里必须不存在。
    expect(h.sections).toEqual([{ name: 'deployment:persona-prefix', order: 0, text: '独立审计员' }])
    expect(h.sections.some(section => section.name === 'deployment:persona-suffix')).toBe(false)
  })
  it('无身份快照时不写任何提示词段（继承父预设身份）', async () => {
    const h = childHarness()
    await applyChildPolicy(h.agent, { version: 1, childId, parentId: 'parent', mode: 'continuable', allow: ['read'] })
    expect(h.sections).toEqual([])
    expect(h.deny('write')).toContain('只读')
  })
  it('只读守卫覆盖写入与后注册工具', async () => {
    const h = childHarness()
    await applyChildPolicy(h.agent, policy)
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
    const home = await temporaryDirectory()
    await persistPolicy(policy, policyDirectory(home))
    const host = listenerHost()
    installChildPolicies(host.ctx, home)
    const fresh = childHarness()
    await host.fire(fresh.agent)
    expect(fresh.deny('write')).toContain('只读')
    await host.fire(fresh.agent)
    expect(fresh.sections).toHaveLength(1)
    const resumed = childHarness()
    await host.fire(resumed.agent)
    expect(resumed.deny('write')).toContain('只读')
    const native = { id: 'native-child', session: {}, ctx: {} } as unknown as AgentLike
    await expect(host.fire(native)).resolves.toBeUndefined()
  })
  it('缺失快照、非法标识、缺服务都否决创建，不能假装装配成功', async () => {
    const home = await temporaryDirectory()
    const host = listenerHost()
    installChildPolicies(host.ctx, home)
    await expect(host.fire(childHarness().agent)).rejects.toThrow('拒绝')
    await expect(readChildPolicy('obagent-not-a-uuid', policyDirectory(home))).rejects.toThrow('拒绝')
    // 注入回调根本没跑起来（宿主缺 systemPrompt/tools）时必须拒绝，而不是当成「没有约束」。
    const missing = childHarness({ activate: false })
    await expect(applyChildPolicy(missing.agent, policy)).rejects.toThrow('缺少工具或提示词服务')
  })
  it('只读回发仅限父代理，不同父子身份拒绝装配', async () => {
    const h = childHarness()
    await applyChildPolicy(h.agent, { ...policy, allow: ['read', 'send_message'] })
    expect(h.deny('send_message', { agent_id: 'parent' })).toBeUndefined()
    expect(h.deny('send_message', { agent_id: 'other' })).toContain('直接父代理')
    await expect(applyChildPolicy(h.agent, { ...policy, parentId: 'wrong' })).rejects.toThrow('不匹配')
  })
  it('宿主改用显式 home 后，$DSH_HOME 指向他处也能冷恢复同一快照', async () => {
    const home = await temporaryDirectory()
    const elsewhere = await temporaryDirectory()
    setEnv('DSH_HOME', elsewhere)
    await persistPolicy(policy, policyDirectory(home))
    const host = listenerHost()
    installChildPolicies(host.ctx, home)
    const resumed = childHarness()
    await host.fire(resumed.agent)
    expect(resumed.deny('write')).toContain('只读')
    expect(existsSync(join(elsewhere, 'plugins'))).toBe(false)
  })
  it('home 错开（创建与恢复不是同一目录）时拒绝启动而不是放行', async () => {
    const home = await temporaryDirectory()
    const other = await temporaryDirectory()
    await persistPolicy(policy, policyDirectory(home))
    const host = listenerHost()
    installChildPolicies(host.ctx, other)
    await expect(host.fire(childHarness().agent)).rejects.toThrow('拒绝')
  })
})

describe('命名空间与模式边界', () => {
  it('OB 命名空间快照始终生效：会话头带团队标记也收紧到白名单', async () => {
    const header = { origin: 'subagent', parentSession: 'parent', teamMember: 'frontend', agentTeam: { lead: 'main' } }
    const h = childHarness({ header })
    await applyChildPolicy(h.agent, { ...policy, allow: ['read', 'send_message'] })
    expect(h.sections).toHaveLength(1)
    expect(h.deny('write')).toContain('只读')
    // 团队模式只影响协调器释放哪些普通工具；回发限制等快照约束不因模式变化而放宽。
    expect(h.deny('send_message', { agent_id: 'teammate' })).toContain('直接父代理')
    expect(h.deny('send_message', { agent_id: 'parent' })).toBeUndefined()
  })
  it('官方团队/原生子代理不在 obagent 命名空间：不读快照、不装配任何约束', async () => {
    const home = await temporaryDirectory()
    const teamId = 'team-member-1'
    await mkdir(policyDirectory(home), { recursive: true })
    await writeFile(join(policyDirectory(home), `${teamId}.json`), JSON.stringify({ ...policy, childId: teamId }))
    expect(await readChildPolicy(teamId, policyDirectory(home))).toBeUndefined()
    const host = listenerHost()
    installChildPolicies(host.ctx, home)
    const team = childHarness({ id: teamId, header: { origin: 'subagent', parentSession: 'lead', teamMember: 'frontend' } })
    await expect(host.fire(team.agent)).resolves.toBeUndefined()
    expect(team.guards).toEqual([])
    expect(team.filters).toEqual([])
    expect(team.sections).toEqual([])
  })
})

function delegationHarness(
  mode: 'continuable',
  start?: (spec: Record<string, unknown>) => Promise<unknown>,
  home?: DshHomeSource,
  entryPatch: Record<string, unknown> = {},
) {
  const entry = { ...DEFAULT_SECTION.entries.find(e => e.id === 'general')!, modes: [mode], ...entryPatch }
  const result = planSubagent(entry, mode, DEFAULT_SECTION, { visibleTool: () => true })
  if (!result.ok || result.plan.kind !== 'subagent') throw new Error('plan failed')
  let registered: ToolDefinitionLike | undefined
  const calls: Record<string, unknown>[] = []
  const dispose = vi.fn(async () => undefined)
  const service = {
    startActivation: async (spec: Record<string, unknown>) => {
      calls.push(spec)
      // 创建调用发生时快照必须已经可读：读的是与装配侧同一个目录来源。
      const saved = await readChildPolicy(spec.childId as string, policyDirectory(home))
      expect(saved?.parentId).toBe('parent')
      return start ? start(spec) : { childId: spec.childId, result: Promise.resolve({ output: [{ type: 'text', text: '结论' }], stopReason: 'completed' }), dispose }
    },
  }
  const tools = { register: (definition: ToolDefinitionLike) => { registered = definition; return () => undefined } }
  const ctx = { get: (name: string) => name === 'subagents' ? service : tools } as unknown as HostContext
  const adapted = subagentContext(ctx, result.plan, home)
  const native = {
    name: result.plan.toolName, description: 'delegate', parameters: { type: 'object' }, output: { schema: {}, render: () => [] },
    execute: async () => {
      const activation = await (adapted.get('subagents') as typeof service).startActivation({ request: { parent: { id: 'parent' } }, signal: new AbortController().signal }) as { childId: string }
      return { kind: 'activation', subagentId: activation.childId }
    },
  }
  ;(adapted.get('tools') as typeof tools).register(native)
  return { definition: () => registered!, calls, dispose, adapted, ctx }
}

describe('公开 activation 适配', () => {
  it('可继续模式立刻返回 ID，且启动前已保存策略', async () => {
    const directory = await temporaryDirectory()
    setEnv('DSH_OB_AGENT_POLICY_DIR', directory)
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
    setEnv('DSH_OB_AGENT_POLICY_DIR', file)
    const h = delegationHarness('continuable')
    await expect(h.definition().execute({}, {})).rejects.toThrow()
    expect(h.calls).toHaveLength(0)
    expect(await readFile(file, 'utf8')).toBe('not a directory')
  })
  it('显式 home 时策略写入 <home>/plugins/dsh-ob-agent/child-policies 并可冷恢复', async () => {
    const home = await temporaryDirectory()
    setEnv('DSH_HOME', join(home, 'unused'))
    // 只读条目的快照才带白名单：用它同时验证「目录布局」和「冷恢复真的收紧了权限」。
    const h = delegationHarness('continuable', undefined, home, { permission: 'readonly' })
    const value = await h.definition().execute({}, {}) as { subagentId: string }
    expect(existsSync(join(policyDirectory(home), `${value.subagentId}.json`))).toBe(true)
    const host = listenerHost()
    installChildPolicies(host.ctx, home)
    const resumed = childHarness({ id: value.subagentId })
    await host.fire(resumed.agent)
    expect(resumed.deny('write')).toContain('只读')
    expect(resumed.deny('grep')).toBeUndefined()
  })
  it('getter 形式的 home 在每次调用时现读（设置热更新后按新目录查，读不到即拒绝）', async () => {
    const first = await temporaryDirectory()
    const second = await temporaryDirectory()
    let current = first
    const source: DshHomeSource = () => current
    const h = delegationHarness('continuable', undefined, source)
    const value = await h.definition().execute({}, {}) as { subagentId: string }
    expect(await readChildPolicy(value.subagentId, policyDirectory(first))).toBeDefined()
    current = second
    await expect(readChildPolicy(value.subagentId, policyDirectory(second))).rejects.toThrow('拒绝')
  })
  it('适配代理对读写透明：符号读透传、写入落在真实上下文', () => {
    const kScope = Symbol('dsh.scope')
    const subagents = { startActivation: async () => ({ childId: 'unused' }) }
    const real = {
      [kScope]: { id: 'agent-scope' },
      marker: 1,
      get: (name: string) => name === 'subagents' ? subagents : name === 'tools' ? { register: () => () => undefined } : undefined,
    }
    const adapted = subagentContext(real as unknown as HostContext, { kind: 'subagent', entry: DEFAULT_SECTION.entries[0]!, mode: 'continuable', toolName: 'probe', config: { provider: 'spawn', toolName: 'probe' } })
    // 符号自有属性必须读到真实上下文上的值：cordis 的 scopeOf(ctx) 就是读 ctx[kScope]。
    expect((adapted as unknown as Record<symbol, unknown>)[kScope]).toEqual({ id: 'agent-scope' })
    expect(adapted.get('tools')).toBeDefined()
    expect(adapted.get('subagents')).not.toBe(subagents)
    ;(adapted as unknown as { marker: number }).marker = 2
    expect(real.marker).toBe(2)
    expect((adapted as unknown as { marker: number }).marker).toBe(2)
  })
})

/* ------------------------------------------------------------------ *
 * 真实宿主：代理是否保住 cordis 的作用域语义（找不到 DSH 时整组跳过）
 * ------------------------------------------------------------------ */

const CORE_PACKAGES = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-scope'] as const

function resolveDshRoot(): string | undefined {
  const fromEnv = process.env.DSH_PROFILE_NODE_MODULES
  const candidates = fromEnv !== undefined && fromEnv !== ''
    ? [fromEnv]
    : [join(homedir(), '.dsh', 'profiles', 'node_modules'), join(homedir(), '.dsh', 'profiles', 'web', 'node_modules')]
  for (const root of candidates) {
    if (CORE_PACKAGES.every(name => existsSync(join(root, ...name.split('/'), 'package.json')))) return root
  }
  return undefined
}

const dshRoot = resolveDshRoot()
if (dshRoot === undefined) {
  console.warn('[subagent-compat] 未找到 DSH 运行时（可设 DSH_PROFILE_NODE_MODULES 指向其 node_modules），真实宿主组已跳过')
}

async function loadDsh(specifier: string): Promise<Record<string, unknown>> {
  const entry = join(dshRoot as string, ...specifier.split('/'), 'lib', 'index.js')
  return await import(pathToFileURL(entry).href) as Record<string, unknown>
}

const realHostSuite = dshRoot === undefined ? describe.skip : describe

realHostSuite('真实 cordis 上的代理语义', () => {
  interface RealTools {
    register(definition: unknown): () => void
    schemas(scope?: unknown): readonly { name: string }[]
  }
  interface RealCtx {
    plugin(plugin: unknown): unknown
    inject(services: string[], callback: (ctx: RealCtx) => void): unknown
    provide(name: string, value: unknown): void
    tools: RealTools
    systemPrompt: { assemble(context: unknown): Promise<unknown>; section(section: unknown): unknown }
  }

  /** 起一台真实运行时（SystemPrompt + ToolRuntime）并造一个 agent 作用域。 */
  async function boot(overrideSubagents?: unknown): Promise<{ ctx: RealCtx; agentKey: object; scopeCtx: RealCtx; dispose(): Promise<void> }> {
    const { Context } = await loadDsh('@deepseek-ai/cordis')
    const { ToolRuntime } = await loadDsh('@deepseek-ai/dsh-tools')
    const { SystemPrompt } = await loadDsh('@deepseek-ai/dsh-system-prompt')
    const { createScope } = await loadDsh('@deepseek-ai/dsh-scope')
    const ctx = new (Context as new () => RealCtx)()
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    await new Promise(resolve => setTimeout(resolve, 50))
    ctx.provide('subagents', overrideSubagents ?? {
      startActivation: async () => ({ childId: 'unused', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => undefined }),
    })
    const agentKey = { id: 'proxy-probe-agent' }
    const scope = await new Promise<{ ctx: RealCtx; dispose(): Promise<void> }>((resolveScope, reject) => {
      ctx.inject(['tools', 'systemPrompt'], inner => {
        try {
          resolveScope(createScope(inner, agentKey) as { ctx: RealCtx; dispose(): Promise<void> })
        } catch (error) {
          reject(error)
        }
      })
    })
    return { ctx, agentKey, scopeCtx: scope.ctx, dispose: () => scope.dispose() }
  }

  const probePlan = { kind: 'subagent' as const, entry: DEFAULT_SECTION.entries[0]!, mode: 'continuable' as const, toolName: 'probe_tool', config: { provider: 'spawn', toolName: 'probe_tool' } }

  it('经适配代理注册的提示词段与工具都落在调用方作用域，且不泄漏到全局', async () => {
    const runtime = await boot()
    try {
      const adapted = subagentContext(runtime.scopeCtx as unknown as HostContext, probePlan)
      const prompt = adapted.get('systemPrompt') as { section(section: unknown): unknown }
      prompt.section({ name: 'probe:scoped', order: 0, text: '代理作用域探针' })
      const tools = adapted.get('tools') as RealTools
      tools.register({
        name: 'probe_tool',
        description: 'probe',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [] },
        execute: () => Promise.resolve({}),
      })

      const assembly = JSON.stringify(await runtime.ctx.systemPrompt.assemble({ scope: runtime.agentKey }))
      expect(assembly).toContain('代理作用域探针')
      expect(runtime.scopeCtx.tools.schemas(runtime.agentKey).map(schema => schema.name)).toContain('probe_tool')

      // 若代理把包装器当 receiver 传给 cordis，scopeOf(ctx) 读不到符号作用域，注册会落到全局层。
      const globalAssembly = JSON.stringify(await runtime.ctx.systemPrompt.assemble({}))
      expect(globalAssembly).not.toContain('代理作用域探针')
      expect(runtime.ctx.tools.schemas({ id: 'other-agent' }).map(schema => schema.name)).not.toContain('probe_tool')
    } finally {
      await runtime.dispose()
    }
  })

  it('适配代理把 startActivation 的 childId 交给真实服务，并保持父请求参数原样', async () => {
    const directory = await temporaryDirectory()
    setEnv('DSH_OB_AGENT_POLICY_DIR', directory)
    const starts: Record<string, unknown>[] = []
    const runtime = await boot({
      startActivation: async (spec: Record<string, unknown>) => {
        starts.push(spec)
        return { childId: spec.childId, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => undefined }
      },
    })
    try {
      const adapted = subagentContext(runtime.scopeCtx as unknown as HostContext, probePlan)
      const service = adapted.get('subagents') as { startActivation(spec: Record<string, unknown>): Promise<{ childId: string }> }
      const activation = await service.startActivation({ request: { parent: { id: 'parent' } }, signal: new AbortController().signal, extra: 1 })
      expect(activation.childId).toMatch(/^obagent-/)
      expect(starts[0].extra).toBe(1)
      expect(starts[0].request).toEqual({ parent: { id: 'parent' } })
      expect(await readChildPolicy(activation.childId, directory)).toBeDefined()
    } finally {
      await runtime.dispose()
    }
  })
})
