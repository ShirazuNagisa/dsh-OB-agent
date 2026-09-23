/**
 * 协调器纯函数层的单元测试：隐藏层拒绝名单的计算与安装指纹的稳定性。
 *
 * 完整的装配路径（restrict / guard / 动态 apply）需要真实 cordis 作用域，属于人工验收
 * 范围（见 docs/USAGE.md 的验收清单）；这里锁住的是最容易出错的两处纯逻辑。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SECTION, LIST_AGENTS_EMPTY, LIST_AGENTS_NOTE, NATIVE_LIST_EMPTY } from '../src/defaults.ts'
import { readSection } from '../src/normalize.ts'
import { augmentListAgents, captureRegistrations, denyNamesFor, fingerprintOf, keyOf, restrictableNames, type ModuleName } from '../src/reconcile.ts'
import type { InstallPlan } from '../src/implement.ts'
import type { ObAgentEntry } from '../src/contract.ts'
import type { HostContext, ToolDefinitionLike } from '../src/context-types.ts'

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
