/**
 * 协调器**装配路径**的集成测试（用最小 cordis 替身跑通 `reconcileAgent`）。
 *
 * 纯函数测试证明不了「子代理里 `send_message` 真的被放行且真的装上了」——那正是本功能
 * 的核心行为，因此这里用一个假的工具登记表 + 假注入跑完整条链路：
 * 允许集合 → 隐藏层拒绝名单 → 执行层守卫 → 自有层重挂。
 * 上游实现包由 `vitest.config.ts` 的 alias 指向 `tests/stubs/tool-subagent-control.ts`。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SECTION, DENY_MESSAGE_CHILD } from '../src/defaults.ts'
import { readSection } from '../src/normalize.ts'
import { reconcileAgent, type ReconcileDeps } from '../src/reconcile.ts'
import type {
  AgentLike,
  HostContext,
  LoggerLike,
  SessionEventLike,
  SystemPromptLike,
  ToolDefinitionLike,
  ToolExecLike,
  ToolRuntimeLike,
} from '../src/context-types.ts'
import type { ObAgentSection } from '../src/contract.ts'

/** 最小工具定义（本测试只关心名字与注册行为）。 */
function definitionOf(name: string): ToolDefinitionLike {
  return {
    name,
    description: name,
    parameters: {},
    output: { schema: { type: 'object' }, render: () => [] },
    async execute() {
      return {}
    },
  }
}

interface Harness {
  readonly deps: ReconcileDeps
  readonly agent: AgentLike
  /** 自有层当前注册的工具名 → 定义。 */
  readonly registered: Map<string, ToolDefinitionLike>
  /** 每次 `restrict()` 的 deny 名单（按调用顺序）。 */
  readonly restrictCalls: string[][]
  /** 已注册的执行层守卫。 */
  readonly guards: Array<(exec: ToolExecLike) => string | undefined>
  /** `get()` / `schemas()` 收到的「查看者作用域」实参（必须始终是 agent 本身）。 */
  readonly viewScopes: unknown[]
  /** 协调过程中产生的插件告警（用于断言「没有误报不可用」）。 */
  readonly warnings: string[]
  /** 当前模型能看到的工具名（包含自有层，排除已隐藏的继承面）。 */
  visibleTools(): string[]
  /** 切换设置段（模拟设置热更新后的重算）。 */
  use(section: ObAgentSection): void
  /** 模拟上游工具重新注册后，原先不可隐藏的名字变成继承面名字。 */
  unblock(name: string): void
}

/**
 * 造一个 agent 与它的最小运行环境。
 * @param input - 会话身份、继承面可见工具、子会话事件与初始设置段。
 * @returns 测试把手。
 */
function harness(input: {
  origin?: 'subagent'
  parentSession?: string
  events?: readonly SessionEventLike[]
  inherited?: readonly string[]
  /** 提供方（而非本插件）已在 agent 自有层注册的工具；继承限制不能遮掉它们。 */
  local?: readonly string[]
  section?: ObAgentSection
  /**
   * 模拟「不是继承面名字」：名单里只要出现其中之一，`restrict` 就整次抛错
   * （上游行为：名单含未知/自有层名字时全或无地失败）。
   */
  rejectNames?: readonly string[]
  onToolChange?: () => void
}): Harness {
  let section = input.section ?? readSection(DEFAULT_SECTION)
  const inherited = new Set(input.inherited ?? [])
  const definitions = new Map([...inherited].map(name => [name, definitionOf(name)]))
  const rejected = new Set(input.rejectNames ?? [])
  const registered = new Map((input.local ?? []).map(name => [name, definitionOf(name)]))
  const restrictions = new Map<number, Set<string>>()
  let nextRestriction = 0
  const hidden = (name: string): boolean => [...restrictions.values()].some(names => names.has(name))
  const restrictCalls: string[][] = []
  const guards: Array<(exec: ToolExecLike) => string | undefined> = []
  const viewScopes: unknown[] = []
  const warnings: string[] = []
  /** 由下面的 agent 字面量回填：假 tools 据此判断「查看者作用域」是否正确。 */
  let agentRef: AgentLike | undefined
  const scopedLogger: LoggerLike = {
    info: () => undefined,
    error: () => undefined,
    warn: (message: string) => {
      warnings.push(message)
    },
  }

  const tools: ToolRuntimeLike = {
    register(definition) {
      registered.set(definition.name, definition)
      input.onToolChange?.()
      return () => {
        registered.delete(definition.name)
        input.onToolChange?.()
      }
    },
    restrict(filter) {
      const deny = [...(filter.deny ?? [])]
      const invalid = deny.find(name => rejected.has(name) || !inherited.has(name))
      if (invalid !== undefined) {
        throw new Error(`tools.restrict() names unknown global tool "${invalid}"`)
      }
      restrictCalls.push(deny)
      const id = nextRestriction++
      restrictions.set(id, new Set(deny))
      input.onToolChange?.()
      return () => {
        restrictions.delete(id)
        input.onToolChange?.()
      }
    },
    guard(fn) {
      guards.push(fn)
      return () => undefined
    },
    get: (name, scope) => {
      viewScopes.push(scope)
      // 作用域敏感：只有查看着是 agent 本身时才看得到继承面（与上游语义一致）。
      // 传 agent.ctx 会得到空视图 —— 于是行为断言本身就成了这条契约的回归闸。
      if (scope !== agentRef) return undefined
      return registered.get(name) ?? (hidden(name) ? undefined : definitions.get(name))
    },
    schemas: (scope) => {
      viewScopes.push(scope)
      if (scope !== agentRef) return []
      return [...new Set([
        ...[...inherited].filter(name => !hidden(name)),
        ...registered.keys(),
      ])].map(name => ({ name }))
    },
  }
  const systemPrompt: SystemPromptLike = {
    section: () => () => undefined,
    getSectionOrder: () => 0,
  }
  // 「直接 get 到的实例」与「注入面拿到的实例」在本替身里刻意不同：只有注入面的那个能
  // 改作用域（register / guard / restrict）。这正好复刻上游事实 —— `agent.ctx.get('tools')`
  // 拿到的实例不带调用方作用域，`restrict` 会在 `scopeOf(this.ctx)` 处抛错。
  const unscopedTools: ToolRuntimeLike = {
    ...tools,
    register: () => {
      throw new Error('unscoped registry cannot register')
    },
    guard: () => {
      throw new Error('unscoped registry cannot guard')
    },
    restrict: () => {
      throw new Error('tools.restrict() requires a scoped context')
    },
  }
  const scopedCtx = {
    logger: scopedLogger,
    get: (name: string) => (name === 'tools' ? tools : name === 'systemPrompt' ? systemPrompt : undefined),
    on: () => () => undefined,
    effect: () => ({ dispose: () => undefined }),
    inject: () => ({ dispose: () => undefined }),
  } as unknown as HostContext
  const agentCtx = {
    logger: scopedLogger,
    // 属性访问同样拿到不带作用域的实例（模拟 cordis 里 receiver 未绑定的情形）。
    tools: unscopedTools,
    get: (name: string) => (name === 'tools' ? unscopedTools : name === 'systemPrompt' ? systemPrompt : undefined),
    // 模拟 cordis 注入的 fiber 语义：回调拿到的是带作用域的上下文；这次注入期间新增的注册随释放一起消失。
    inject: (_services: readonly string[], callback: (ctx: HostContext) => void) => {
      const before = new Set(registered.keys())
      callback(scopedCtx)
      const added = [...registered.keys()].filter(name => !before.has(name))
      return {
        dispose: () => {
          for (const name of added) registered.delete(name)
        },
      }
    },
    on: () => () => undefined,
    effect: () => ({ dispose: () => undefined }),
  } as unknown as HostContext

  const header: Record<string, unknown> = { id: 'agent-1' }
  if (input.origin !== undefined) header.origin = input.origin
  if (input.parentSession !== undefined) header.parentSession = input.parentSession
  const agent = {
    id: 'agent-1',
    session: {
      id: 'agent-1',
      header,
      append: () => undefined,
      ownEvents: () => input.events ?? [],
    },
    ctx: agentCtx,
  } as unknown as AgentLike
  agentRef = agent

  const hostCtx = {
    logger: scopedLogger,
    get: () => undefined,
    inject: (_services: readonly string[], callback: (ctx: HostContext) => void) => {
      callback(hostCtx as unknown as HostContext)
      return { dispose: () => undefined }
    },
    on: () => () => undefined,
    effect: () => ({ dispose: () => undefined }),
  } as unknown as HostContext

  return {
    deps: { ctx: hostCtx, read: () => section, scope: undefined },
    agent,
    registered,
    restrictCalls,
    guards,
    viewScopes,
    warnings,
    visibleTools: () => tools.schemas?.(agent).map(schema => schema.name) ?? [],
    use: (next) => {
      section = next
    },
    unblock: (name) => {
      rejected.delete(name)
      definitions.set(name, definitionOf(name))
    },
  }
}

const descriptor = (mode: 'one-shot' | 'continuable'): SessionEventLike => ({
  type: 'subagent/descriptor',
  data: { version: 3, provider: 'spawn', mode, label: '演示任务' },
})

/** 继承面：一个非 Agent 工具、放行目标、一个委派工具。 */
const INHERITED = ['read', 'send_message', 'subagent_general_session']

describe('reconcileAgent：子代理回发父代理', () => {
  it('枚举与解析可见工具时，查看者作用域传的是 agent 本身（不是它的 ctx）', async () => {
    // 上游把模型可见工具放在 agent 平面上：`tools.schemas(agent)` / `tools.get(name, agent)`
    // 才能看到继承面。传 agent.ctx 会枚举为空 → 拒绝名单算空 → 隐藏层静默失效。
    const h = harness({ origin: 'subagent', parentSession: 'parent-1', events: [descriptor('continuable')], inherited: INHERITED })
    await reconcileAgent(h.deps, h.agent)
    expect(h.viewScopes.length).toBeGreaterThan(0)
    for (const scope of h.viewScopes) expect(scope).toBe(h.agent)
  })

  it('可继续对话的子代理只装上 send_message，委派工具照旧被隐藏与拦截', async () => {
    const h = harness({ origin: 'subagent', parentSession: 'parent-1', events: [descriptor('continuable')], inherited: INHERITED })
    await reconcileAgent(h.deps, h.agent)

    // 自有层重挂：只有 send_message，不含 interrupt_agent
    expect([...h.registered.keys()]).toEqual(['send_message'])
    // 隐藏层：委派工具被隐藏，放行目标不在拒绝名单里
    expect(h.restrictCalls.at(-1)).toEqual(['subagent_general_session'])
    // 执行层：放行 send_message，拒绝其余 Agent 工具，且用子代理专属文案
    const guard = h.guards[0]
    expect(guard?.({ name: 'send_message' })).toBeUndefined()
    // 拒绝文案必须是子代理专属那份（且占位已被替换），否则模型会被指去「面板勾选条目」
    expect(guard?.({ name: 'subagent_general_session' }))
      .toBe(DENY_MESSAGE_CHILD.replace('{name}', 'subagent_general_session'))
    expect(guard?.({ name: 'read' })).toBeUndefined()
  })

  it('模式读不到时按放行处理（判定失败不该让子代理失去回发通道）', async () => {
    const h = harness({ origin: 'subagent', parentSession: 'parent-1', inherited: INHERITED })
    await reconcileAgent(h.deps, h.agent)
    expect([...h.registered.keys()]).toEqual(['send_message'])
  })

  it('一次性子代理不装回发工具，调用被拒', async () => {
    const h = harness({ origin: 'subagent', parentSession: 'parent-1', events: [descriptor('one-shot')], inherited: INHERITED })
    await reconcileAgent(h.deps, h.agent)
    expect([...h.registered.keys()]).toEqual([])
    const guard = h.guards[0]
    expect(guard?.({ name: 'send_message' })).toContain('子代理内部不可用')
    // 一次性子代理里它同样要被隐藏层挡住
    expect(h.restrictCalls.at(-1)).toContain('send_message')
  })

  it('关闭开关后不仅不放行，还会把已装上的工具卸载掉', async () => {
    const h = harness({ origin: 'subagent', parentSession: 'parent-1', events: [descriptor('continuable')], inherited: INHERITED })
    await reconcileAgent(h.deps, h.agent)
    expect([...h.registered.keys()]).toEqual(['send_message'])

    h.use(readSection({ ...DEFAULT_SECTION, childReplyToParent: false }))
    await reconcileAgent(h.deps, h.agent)
    expect([...h.registered.keys()]).toEqual([])
    expect(h.guards[0]?.({ name: 'send_message' })).toContain('子代理内部不可用')
    expect(h.restrictCalls.at(-1)).toContain('send_message')
  })

  it('主会话不受该开关影响（子代理专属能力）', async () => {
    const h = harness({ inherited: INHERITED, section: readSection(DEFAULT_SECTION) })
    await reconcileAgent(h.deps, h.agent)
    expect([...h.registered.keys()]).toEqual([])
    expect(h.guards[0]?.({ name: 'send_message' })).toContain('子代理总开关')
  })

  it('逃生舱（闸门关闭）时不干预：子代理按 DSH 原生行为可用', async () => {
    const section = readSection({ ...DEFAULT_SECTION, gate: { ...DEFAULT_SECTION.gate, enabled: false } })
    const h = harness({ origin: 'subagent', parentSession: 'parent-1', events: [descriptor('one-shot')], inherited: INHERITED, section })
    await reconcileAgent(h.deps, h.agent)
    expect(h.restrictCalls).toEqual([])
    expect(h.guards[0]?.({ name: 'send_message' })).toBeUndefined()
  })
})

describe('reconcileAgent：档 A（passthrough）在多轮重算下的稳定性', () => {
  const mainSection = (selected: readonly string[]): ObAgentSection => readSection({
    ...DEFAULT_SECTION,
    sessions: { 'agent-1': { enabled: true, selected: [...selected] } },
  })

  it('放行继承面工具的原生条目连续两轮都保持放行（不因自己「已安装」翻成重挂）', async () => {
    // `workflow` 由预设提供 → 档 A；若把它记成「自有层名字」，第二轮 `visibleTool` 会
    // 判它不可见，于是翻成档 B（在测试里就是「实现包加载失败」的误报告警）。
    const h = harness({ inherited: ['read', 'workflow'], section: mainSection(['workflow']) })
    await reconcileAgent(h.deps, h.agent)
    await reconcileAgent(h.deps, h.agent)
    expect([...h.registered.keys()]).toEqual([])
    expect(h.warnings).toEqual([])
  })

  it('具名预设子代理条目不会被误判为「预设没有装配」（无每两轮一次的震荡告警）', async () => {
    const h = harness({ inherited: ['read', 'subagent_hy4'], section: mainSection(['subagent_native']) })
    await reconcileAgent(h.deps, h.agent)
    await reconcileAgent(h.deps, h.agent)
    await reconcileAgent(h.deps, h.agent)
    expect([...h.registered.keys()]).toEqual([])
    expect(h.warnings).toEqual([])
  })
})

describe('reconcileAgent：隐藏层的取法与降级', () => {
  it('提供方自有层的 subagent 可见但不可执行，不牵连继承工具、回发或重算收敛', async () => {
    let changes = 0
    const h = harness({
      origin: 'subagent',
      parentSession: 'parent-1',
      events: [descriptor('continuable')],
      inherited: [...INHERITED, 'job_list', 'subagent_fork', 'workflow', 'list_agents', 'interrupt_agent'],
      local: ['subagent'],
      onToolChange: () => { changes += 1 },
    })
    const localDefinition = h.registered.get('subagent')
    await reconcileAgent(h.deps, h.agent)

    expect(h.visibleTools().sort()).toEqual(['job_list', 'read', 'send_message', 'subagent'])
    expect(h.registered.get('subagent')).toBe(localDefinition)
    expect(h.registered.has('send_message')).toBe(true)
    expect(h.guards[0]?.({ name: 'subagent' })).toBe(DENY_MESSAGE_CHILD.replace('{name}', 'subagent'))
    expect(h.guards[0]?.({ name: 'send_message' })).toBeUndefined()
    expect(h.guards[0]?.({ name: 'job_list' })).toBeUndefined()
    expect(h.warnings).toEqual([
      expect.stringContaining('subagent（tools.restrict() names unknown global tool "subagent"）'),
    ])
    const settledChanges = changes
    const settledCalls = h.restrictCalls.length
    for (let round = 0; round < 20; round += 1) await reconcileAgent(h.deps, h.agent)
    expect(changes).toBe(settledChanges)
    expect(h.restrictCalls).toHaveLength(settledCalls)
    expect(h.warnings).toHaveLength(1)
  })

  it('自有层与继承面同名时，restrict 成功也只隐藏继承版本，守卫仍拒绝自有版本', async () => {
    const h = harness({
      origin: 'subagent',
      parentSession: 'parent-1',
      events: [descriptor('continuable')],
      inherited: [...INHERITED, 'subagent'],
      local: ['subagent'],
    })
    await reconcileAgent(h.deps, h.agent)
    expect(h.restrictCalls.at(-1)).toContain('subagent')
    expect(h.visibleTools()).toContain('subagent')
    expect(h.guards[0]?.({ name: 'subagent' })).toBe(DENY_MESSAGE_CHILD.replace('{name}', 'subagent'))
    expect(h.warnings).toEqual([])
  })

  it('隐藏层必须走注入面的工具登记表（直接 get 的实例不带作用域，会被上游拒绝）', async () => {
    // 替身里 `agent.ctx.get('tools')` 返回的实例 restrict 一律抛错；只有 inject 回调里的
    // 那个能用。若实现退回「直接 get」，隐藏层会整层失效 —— 这条断言就会挂。
    const h = harness({ origin: 'subagent', parentSession: 'parent-1', events: [descriptor('continuable')], inherited: INHERITED })
    await reconcileAgent(h.deps, h.agent)
    expect(h.restrictCalls.length).toBeGreaterThan(0)
    expect(h.warnings.filter(message => message.includes('隐藏层'))).toEqual([])
  })

  it('整批失败时逐个降级：能隐藏的仍被隐藏，隐藏不了的名字给出告警', async () => {
    const h = harness({
      origin: 'subagent',
      parentSession: 'parent-1',
      events: [descriptor('continuable')],
      inherited: [...INHERITED, 'subagent_general_session', 'subagent_fork', 'workflow'],
      // 模拟「名单里混进一个非继承面名字」：上游 restrict 会整次抛错（全或无）
      rejectNames: ['subagent_fork'],
    })
    await reconcileAgent(h.deps, h.agent)
    expect(h.restrictCalls).toContainEqual(['subagent_general_session'])
    expect(h.restrictCalls).toContainEqual(['workflow'])
    expect(h.restrictCalls.some(names => names.includes('subagent_fork'))).toBe(false)
    expect(h.warnings.some(message => message.includes('subagent_fork') && message.includes('无法进入隐藏层'))).toBe(true)
  })

  it('逐个降级产生的 tools/change 会收敛，工具定义变化后仍会重试', async () => {
    let changes = 0
    let h: Harness
    h = harness({
      origin: 'subagent',
      inherited: [...INHERITED, 'subagent_fork', 'workflow'],
      rejectNames: ['subagent_fork'],
      onToolChange: () => {
        changes += 1
        if (changes <= 12) void reconcileAgent(h.deps, h.agent)
      },
    })

    await reconcileAgent(h.deps, h.agent)
    expect(changes).toBeLessThan(12)
    expect(h.restrictCalls).toContainEqual(['workflow'])
    expect(h.warnings.filter(message => message.includes('无法进入隐藏层'))).toHaveLength(1)
    expect(h.visibleTools()).toContain('subagent_fork')
    expect(h.visibleTools()).not.toContain('workflow')

    h.unblock('subagent_fork')
    await reconcileAgent(h.deps, h.agent)
    expect(h.restrictCalls.at(-1)).toEqual(['subagent_fork', 'subagent_general_session', 'workflow'])
  })
})
