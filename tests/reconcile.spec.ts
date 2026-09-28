/**
 * 协调器纯函数层的单元测试：隐藏层拒绝名单的计算与安装指纹的稳定性。
 *
 * 完整的装配路径（restrict / guard / 动态 apply）需要真实 cordis 作用域，属于人工验收
 * 范围（见 docs/USAGE.md 的验收清单）；这里锁住的是最容易出错的两处纯逻辑。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SECTION, LIST_AGENTS_EMPTY, LIST_AGENTS_NOTE, NATIVE_LIST_EMPTY } from '../src/defaults.ts'
import { readSection } from '../src/normalize.ts'
import {
  augmentListAgents,
  captureRegistrations,
  continuationModeOf,
  denyNamesFor,
  fingerprintOf,
  keyOf,
  registerSelectedTools,
  restrictableNames,
  type ModuleName,
} from '../src/reconcile.ts'
import { CHILD_REPLY_KEY, planChildReply, type InstallPlan } from '../src/implement.ts'
import type { AgentLike, HostContext, ToolDefinitionLike } from '../src/context-types.ts'
import type { ObAgentEntry } from '../src/contract.ts'

const entry: ObAgentEntry = {
  id: 'demo',
  kind: 'subagent',
  source: 'user',
  managed: true,
  defaultEnabled: false,
  name: '演示',
  description: '',
  whenPrompt: 'a',
  identityPrompt: 'b',
  modes: ['one-shot'],
  provider: 'spawn',
  permission: 'full',
}

const subagentPlan = (patch: Partial<Extract<InstallPlan, { kind: 'subagent' }>> = {}): InstallPlan => ({
  kind: 'subagent',
  entry,
  mode: 'one-shot',
  toolName: 'subagent_demo',
  config: {
    provider: 'spawn',
    toolName: 'subagent_demo',
    backgroundMode: 'one-shot',
    enableRunInBackground: true,
    maxDepth: 3,
  },
  ...patch,
})

const nativePlan = (patch: Partial<Extract<InstallPlan, { kind: 'native' }>> = {}): InstallPlan => ({
  kind: 'native',
  entry,
  impl: 'workflow',
  action: 'install',
  toolNames: ['workflow'],
  ...patch,
})

describe('keyOf / fingerprintOf', () => {
  it('安装键按条目与模式区分', () => {
    expect(keyOf(subagentPlan())).toBe('sub:demo:one-shot')
    expect(keyOf(nativePlan())).toBe('nat:demo')
  })

  it('配置不变时指纹稳定（幂等：不触发重装）', () => {
    expect(fingerprintOf(subagentPlan())).toBe(fingerprintOf(subagentPlan()))
    expect(fingerprintOf(nativePlan())).toBe(fingerprintOf(nativePlan()))
  })

  it('配置变化时指纹变化（触发重装）', () => {
    const changed = subagentPlan({
      config: {
        provider: 'fork',
        toolName: 'subagent_demo',
        backgroundMode: 'one-shot',
        enableRunInBackground: true,
        maxDepth: 3,
      },
    })
    expect(fingerprintOf(changed)).not.toBe(fingerprintOf(subagentPlan()))
    expect(fingerprintOf(nativePlan({ action: 'passthrough' }))).not.toBe(fingerprintOf(nativePlan()))
    expect(fingerprintOf(nativePlan({ toolNames: ['workflow', 'x'] }))).not.toBe(fingerprintOf(nativePlan()))
  })
})

describe('denyNamesFor', () => {
  const section = readSection(DEFAULT_SECTION)

  it('闸门关闭时不拦截任何名字', () => {
    const off = readSection({ ...DEFAULT_SECTION, gate: { ...DEFAULT_SECTION.gate, enabled: false } })
    expect(denyNamesFor(off, ['subagent'], ['subagent'], [])).toEqual([])
  })

  it('拦下命中的名字，放过允许集合内的名字', () => {
    const deny = denyNamesFor(section, [], ['subagent_hy4', 'send_message', 'read'], ['send_message'])
    expect(deny).toContain('subagent_hy4')
    expect(deny).not.toContain('send_message')
    expect(deny).not.toContain('read')
  })

  it('配置点名的名字即使当前枚举不到也保留在拒绝集里', () => {
    // workflow 未出现在可见列表里，但配置名单点名了它 → 仍然拦截（防止隐藏层被削弱）
    const deny = denyNamesFor(section, [], ['read'], [])
    expect(deny).toContain('workflow')
    expect(deny).toContain('ralph')
    expect(deny).not.toContain('read')
  })

  it('累计的已知名字参与拦截（二次枚举时不会因为已被隐藏而漏拦）', () => {
    const deny = denyNamesFor(section, ['subagent_legacy'], [], [])
    expect(deny).toContain('subagent_legacy')
  })

  it('未纳管条目的工具名被豁免（其余名单照旧拦截）', () => {
    const entries = DEFAULT_SECTION.entries.map(item => (item.id === 'workflow' ? { ...item, managed: false } : item))
    const relaxed = readSection({ ...DEFAULT_SECTION, entries })
    const deny = denyNamesFor(relaxed, [], ['workflow'], [])
    expect(deny).not.toContain('workflow')
    expect(deny).toContain('ralph')
  })

  it('结果稳定排序（相同输入两次调用一致）', () => {
    const once = denyNamesFor(section, ['ralph'], ['subagent_x'], [])
    const twice = denyNamesFor(section, ['ralph'], ['subagent_x'], [])
    expect(once).toEqual(twice)
  })
})

describe('restrictableNames（隐藏层不可交给 restrict 的名字必须被剔除）', () => {
  const resolvable = (name: string): boolean => name === 'send_message' || name === 'subagent_hy4'

  it('自有层名字一律排除（restrict 会因 scope-local 名抛错）', () => {
    const own = new Set(['subagent_general_session'])
    const result = restrictableNames(['subagent_general_session', 'send_message'], own, new Set(), resolvable)
    expect(result).toEqual(['send_message'])
  })

  it('被隐藏过因而不再可解析的名字仍然保留（否则第二轮会把它放出来）', () => {
    const result = restrictableNames(['subagent_hy4'], new Set(), new Set(['subagent_hy4']), () => false)
    expect(result).toEqual(['subagent_hy4'])
  })

  it('从未存在过、当前也不可解析的名字被剔除（避免 restrict 抛错导致整层失效）', () => {
    const result = restrictableNames(['workflow', 'send_message'], new Set(), new Set(), resolvable)
    expect(result).toEqual(['send_message'])
  })

  it('保持输入顺序', () => {
    const result = restrictableNames(['subagent_hy4', 'send_message'], new Set(), new Set(), resolvable)
    expect(result).toEqual(['subagent_hy4', 'send_message'])
  })
})

describe('实现包加载键', () => {
  it('子代理条目依赖委派工具包，原生条目按实现取包', () => {
    const names: ModuleName[] = ['tool-subagent', 'control', 'list-agents', 'workflow', 'ralph']
    expect(names).toHaveLength(5)
  })
})

describe('augmentListAgents（把「能力清单」拼进上游结果）', () => {
  /** 上游 list_agents 定义的替身：与 defineTool 产出的形状一致。 */
  const nativeDefinition = (text: string): ToolDefinitionLike => ({
    name: 'list_agents',
    description: '原生描述',
    parameters: { scope: { type: 'string' } },
    output: {
      schema: { type: 'array', items: {} },
      render: () => [{ type: 'text', text }],
    },
    execute: async () => [],
  })

  it('描述末尾追加说明，执行与参数模式原样沿用上游', () => {
    const native = nativeDefinition(NATIVE_LIST_EMPTY)
    const augmented = augmentListAgents(native, () => '能力清单')
    expect(augmented.description).toBe(`原生描述 ${LIST_AGENTS_NOTE}`)
    expect(augmented.execute).toBe(native.execute)
    expect(augmented.parameters).toBe(native.parameters)
    expect(augmented.output.schema).toBe(native.output.schema)
  })

  it('空实例结果被替换为不会误读的文案，并与能力清单合并为一个文本块', () => {
    const augmented = augmentListAgents(nativeDefinition(NATIVE_LIST_EMPTY), () => '能力清单')
    const blocks = augmented.output.render({}, [])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toBe(`能力清单\n${LIST_AGENTS_EMPTY}`)
    expect(blocks[0]?.text).not.toContain(NATIVE_LIST_EMPTY)
  })

  it('非空实例结果原样保留在能力清单之后', () => {
    const augmented = augmentListAgents(nativeDefinition('a-1 [running] — 甲'), () => '能力清单')
    const blocks = augmented.output.render({ scope: 'children' }, [])
    expect(blocks[0]?.text).toBe('能力清单\na-1 [running] — 甲')
  })

  it('能力清单每次渲染时实时计算（勾选变化立刻反映）', () => {
    let count = 0
    const augmented = augmentListAgents(nativeDefinition(NATIVE_LIST_EMPTY), () => `第 ${++count} 次`)
    expect(augmented.output.render({}, [])[0]?.text).toContain('第 1 次')
    expect(augmented.output.render({}, [])[0]?.text).toContain('第 2 次')
  })

  it('上游返回空块数组时仍然给出能力清单', () => {
    const empty: ToolDefinitionLike = {
      ...nativeDefinition(NATIVE_LIST_EMPTY),
      output: { schema: { type: 'array', items: {} }, render: () => [] },
    }
    const blocks = augmentListAgents(empty, () => '能力清单').output.render({}, [])
    expect(blocks).toEqual([{ type: 'text', text: '能力清单' }])
  })

  it('能力清单为空串时结果与上游逐字一致（渲染失败不改变工具结果）', () => {
    const native = nativeDefinition('a-1 [running] — 甲')
    const augmented = augmentListAgents(native, () => '')
    expect(augmented.output.render({}, [])).toEqual(native.output.render({}, []))
  })

  it('定义形状不符预期时原样返回（不制造新的失败点）', () => {
    const broken = { ...nativeDefinition(NATIVE_LIST_EMPTY), output: undefined } as unknown as ToolDefinitionLike
    expect(augmentListAgents(broken, () => '能力清单')).toBe(broken)
    const noRender = {
      ...nativeDefinition(NATIVE_LIST_EMPTY),
      output: { schema: { type: 'array', items: {} } },
    } as unknown as ToolDefinitionLike
    expect(augmentListAgents(noRender, () => '能力清单')).toBe(noRender)
  })
})

describe('captureRegistrations（代理截获上游注册，不落到真实登记表）', () => {
  const registered: string[] = []
  const definition: ToolDefinitionLike = {
    name: 'list_agents',
    description: '原生描述',
    parameters: {},
    output: { schema: { type: 'array', items: {} }, render: () => [] },
    execute: async () => [],
  }
  /** 上游 apply 的真实用法：读 ctx.tools 注册，并闭包持有 ctx.subagents / ctx.agents。 */
  const upstream = (ctx: unknown): void => {
    const runtime = ctx as { tools: { register(item: ToolDefinitionLike): void }, subagents: unknown, agents: unknown }
    runtime.tools.register(definition)
    expect(runtime.subagents).toBe(subagents)
    expect(runtime.agents).toBe(agents)
  }
  const subagents = { listChildren: async () => [] }
  const agents = { list: () => [] }
  const runtimeCtx = {
    subagents,
    agents,
    tools: { register: (item: ToolDefinitionLike) => { registered.push(item.name) } },
    get: (name: string) => (name === 'subagents' ? subagents : undefined),
  } as unknown as HostContext

  it('截获定义且不写入真实登记表，其余服务原样透传', () => {
    const { captured, error } = captureRegistrations(runtimeCtx, upstream)
    expect(error).toBeUndefined()
    expect(captured).toEqual([definition])
    expect(registered).toEqual([])
  })

  it('get 等方法仍然可用（代理只改 tools 一个属性）', () => {
    captureRegistrations(runtimeCtx, ctx => {
      expect((ctx as { get(name: string): unknown }).get('subagents')).toBe(subagents)
    })
  })

  it('apply 抛错时返回已截获部分与错误信息（不向调用方抛出）', () => {
    const { captured, error } = captureRegistrations(runtimeCtx, ctx => {
      upstream(ctx)
      throw new Error('上游炸了')
    })
    expect(captured).toEqual([definition])
    expect(error).toBe('上游炸了')
  })
})

describe('registerSelectedTools（只安装指名工具）', () => {
  const definitionOf = (name: string): ToolDefinitionLike => ({
    name,
    description: '',
    parameters: {},
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({}),
  })
  /** 上游 control 实现包的真实注册行为：一次注册两个工具。 */
  const upstream = (ctx: unknown): void => {
    const runtime = ctx as { tools: { register(item: ToolDefinitionLike): void } }
    runtime.tools.register(definitionOf('send_message'))
    runtime.tools.register(definitionOf('interrupt_agent'))
  }
  function runtimeOf(reject?: string): { ctx: HostContext; registered: string[] } {
    const registered: string[] = []
    const ctx = {
      get: (name: string) => (name === 'tools'
        ? {
            register: (item: ToolDefinitionLike) => {
              if (item.name === reject) throw new Error('同层重名')
              registered.push(item.name)
            },
          }
        : undefined),
    } as unknown as HostContext
    return { ctx, registered }
  }

  it('只注册点名的工具（子代理不会连带拿到 interrupt_agent）', () => {
    const { ctx, registered } = runtimeOf()
    const installed = registerSelectedTools(ctx, upstream, ['send_message'], () => undefined)
    expect(installed).toBe(1)
    expect(registered).toEqual(['send_message'])
  })

  it('实现包没有提供该定义时返回 0 并告警（不抛错）', () => {
    const { ctx, registered } = runtimeOf()
    const warnings: string[] = []
    const installed = registerSelectedTools(ctx, upstream, ['send_to_parent'], message => warnings.push(message))
    expect(installed).toBe(0)
    expect(registered).toEqual([])
    expect(warnings).toHaveLength(0)
  })

  it('注册被拒时记告警并继续后续名字', () => {
    const { ctx, registered } = runtimeOf('send_message')
    const warnings: string[] = []
    const installed = registerSelectedTools(ctx, upstream, ['send_message', 'interrupt_agent'], m => warnings.push(m))
    expect(installed).toBe(1)
    expect(registered).toEqual(['interrupt_agent'])
    expect(warnings[0]).toContain('注册 send_message 失败')
  })

  it('截获过程抛错时返回已截获部分的安装结果并告警', () => {
    const { ctx, registered } = runtimeOf()
    const warnings: string[] = []
    const installed = registerSelectedTools(ctx, (inner) => {
      upstream(inner)
      throw new Error('上游炸了')
    }, ['send_message'], message => warnings.push(message))
    expect(installed).toBe(1)
    expect(registered).toEqual(['send_message'])
    expect(warnings[0]).toContain('截获工具定义失败')
  })

  it('作用域没有工具登记表时返回 0（不抛错）', () => {
    const ctx = { get: () => undefined } as unknown as HostContext
    expect(registerSelectedTools(ctx, upstream, ['send_message'], () => undefined)).toBe(0)
  })
})

describe('continuationModeOf（子代理续话模式判定）', () => {  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

  /** 造一个子代理替身；session 额外字段用于注入投影/事件读取面。 */
  function agentOf(session: Record<string, unknown> = {}): AgentLike {
    return {
      id: 'child-1',
      session: {
        id: 'child-1',
        header: { id: 'child-1', origin: 'subagent', parentSession: 'parent-9' },
        append: () => undefined,
        ...session,
      },
      ctx: {},
    } as unknown as AgentLike
  }

  function ctxOf(projections?: unknown): HostContext {
    return {
      logger,
      get: (name: string) => (name === 'sessionProjections' ? projections : undefined),
    } as unknown as HostContext
  }

  const descriptor = (mode: string): unknown => ({ type: 'subagent/descriptor', data: { version: 3, provider: 'spawn', mode } })

  it('优先读会话投影（不必扫描日志）', () => {
    const projections = { stateOf: () => ({ mode: 'continuable', label: '任务', seq: 3 }) }
    expect(continuationModeOf(ctxOf(projections), agentOf())).toBe('continuable')
  })

  it('投影的宿主状态形状（identity 包一层）同样能读出模式', () => {
    // 上游 `subagent` 投影的 host state 是 `{ identity?: { mode, … } }`，
    // `{ mode, … }` 只是它的 wire 视图；两种形状都要认，否则首选路径静默失效。
    const projections = { stateOf: () => ({ identity: { mode: 'one-shot', label: '一次性', seq: 2 } }) }
    expect(continuationModeOf(ctxOf(projections), agentOf())).toBe('one-shot')
  })

  it('投影宿主状态里没有身份（identity 缺省 / null）时返回 unknown，而不是当作一次性', () => {
    expect(continuationModeOf(ctxOf({ stateOf: () => ({}) }), agentOf())).toBe('unknown')
    expect(continuationModeOf(ctxOf({ stateOf: () => ({ identity: null }) }), agentOf())).toBe('unknown')
  })

  it('投影不可用时退化为子会话日志里的首个 descriptor', () => {
    const events = [descriptor('one-shot'), descriptor('continuable')]
    const agent = agentOf({ ownEvents: () => events })
    expect(continuationModeOf(ctxOf(undefined), agent)).toBe('one-shot')
  })

  it('只有完整日志快照时取最后一个 descriptor（fork 可能重放祖先的一次性身份）', () => {
    // `ownEvents` 缺失（上游未来可能移除）时退到 `snapshotEvents`：此时首个事件可能是
    // fork 种子重放的祖先 descriptor，取最后一个才与上游身份投影的 last-wins 一致。
    const events = [descriptor('one-shot'), descriptor('continuable')]
    const agent = agentOf({ snapshotEvents: () => events })
    expect(continuationModeOf(ctxOf(undefined), agent)).toBe('continuable')
  })

  it('投影读取抛错时同样退化为日志扫描（不向调用方抛出）', () => {
    const projections = {
      stateOf: () => {
        throw new Error('投影炸了')
      },
    }
    const agent = agentOf({ ownEvents: () => [descriptor('continuable')] })
    expect(continuationModeOf(ctxOf(projections), agent)).toBe('continuable')
  })

  it('投影没有该键（返回 null/undefined）时继续找日志', () => {
    const projections = { stateOf: () => null }
    const agent = agentOf({ snapshotEvents: () => [descriptor('continuable')] })
    expect(continuationModeOf(ctxOf(projections), agent)).toBe('continuable')
  })

  it('两个来源都拿不到时返回 unknown（调用方按放行处理）', () => {
    expect(continuationModeOf(ctxOf(undefined), agentOf())).toBe('unknown')
    expect(continuationModeOf(ctxOf(undefined), agentOf({ ownEvents: () => [{ type: 'turn/start' }] }))).toBe('unknown')
  })

  it('载荷里的非法模式被忽略，不会当成确定结论', () => {
    const agent = agentOf({ ownEvents: () => [descriptor('unknown')] })
    expect(continuationModeOf(ctxOf(undefined), agent)).toBe('unknown')
  })
})

describe('planChildReply（子代理回发父代理的装配计划）', () => {
  const control = DEFAULT_SECTION.entries.find(item => item.impl === 'control') as ObAgentEntry

  it('只安装 send_message，且安装键不可能与用户自建条目冲突', () => {
    const plan = planChildReply(control)
    expect(plan?.kind).toBe('native')
    if (plan?.kind !== 'native') return
    expect(plan.onlyTools).toEqual(['send_message'])
    expect(plan.toolNames).toEqual(['send_message'])
    expect(plan.action).toBe('install')
    // `~` 不是合法条目标识字符，因此 keyOf 的 `nat:<id>` 形状永远不会撞上这个键
    expect(CHILD_REPLY_KEY).toBe('nat:~child-reply')
    expect(CHILD_REPLY_KEY.startsWith('nat:')).toBe(true)
  })

  it('指纹只由实现与工具名决定（设置不变则不重装）', () => {
    const first = planChildReply(control)
    const second = planChildReply({ ...control })
    expect(first).toBeDefined()
    expect(fingerprintOf(second as InstallPlan)).toBe(fingerprintOf(first as InstallPlan))
  })

  it('没有提供 send_message 的条目时不给计划（宁可没有工具，也不装错工具）', () => {
    expect(planChildReply(undefined)).toBeUndefined()
    expect(planChildReply({ ...control, impl: 'workflow' })).toBeUndefined()
    expect(planChildReply({ ...control, toolNames: ['interrupt_agent'] })).toBeUndefined()
  })
})
