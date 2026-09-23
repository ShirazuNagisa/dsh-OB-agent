/**
 * 每 agent 协调器：本插件的执行体。
 *
 * 三层结构：
 * 1. **隐藏层** `tools.restrict({ deny })`：让被拦截的名字从模型工具清单里消失。
 *    `restrict` 只作用于「继承面」（全局层与祖先层，永不含自有层），因此它在 agent
 *    作用域安装一次，集合变化时重装。
 * 2. **执行层** `tools.guard(fn)`：每个 agent 只注册一个守卫，闭包读取可变的
 *    「当前允许集合」，因此允许集变化不需要重装；它同时兜住第 3 层重挂的工具
 *    （自有层注册不受 restrict 约束，必须靠守卫拦住）。
 * 3. **重挂层**：按已启用条目在 agent 自有层安装工具（子代理条目调
 *    `@deepseek-ai/dsh-tool-subagent`；原生条目按档 A 放行 / 档 B 重挂）。
 *
 * 幂等与防抖：每次重算先算目标指纹集合，与已安装指纹逐一比较，只增删差异项，因此
 * 本插件自身触发的 `tools/change` 不会引发重装循环；重入通过 `reconciling` 标记
 * 折叠成一次尾随重算。
 *
 * 子代理（`session.header.origin === 'subagent'`）只装第 1、2 层，永不装第 3 层 —
 * 任何子代理都无法再委派。
 */
import type {
  AgentLike,
  Disposer,
  Fiber,
  HostContext,
  LoggerLike,
  SystemPromptLike,
  ToolDefinitionLike,
  ToolRuntimeLike,
} from './context-types.ts'
import { SECTION_NAME, type ObAgentSection } from './contract.ts'
import { createGateMatcher, renderSectionText, renderSubagentRoster, resolveActive, type ActiveEntry } from './plan.ts'
import { planNative, planSubagent, type InstallPlan, type PlanContext, type PlanResult } from './implement.ts'
import { LIST_AGENTS_EMPTY, LIST_AGENTS_NOTE, NATIVE_LIST_EMPTY } from './defaults.ts'
import { docHint } from './docpath.ts'
import { authoringTools, type AuthoringDeps } from './authoring.ts'

/** 本插件需要动态加载的 DSH 实现包；字面量说明符保证 esbuild 保持外部化。 */
const MODULE_LOADERS = {
  'tool-subagent': () => import('@deepseek-ai/dsh-tool-subagent'),
  control: () => import('@deepseek-ai/dsh-tool-subagent-control'),
  'list-agents': () => import('@deepseek-ai/dsh-tool-subagent-control/list-agents'),
  workflow: () => import('@deepseek-ai/dsh-tool-workflow'),
  ralph: () => import('@deepseek-ai/dsh-tool-ralph'),
} as const

export type ModuleName = keyof typeof MODULE_LOADERS

interface LoadedModule {
  apply(ctx: unknown, config?: unknown): void
}

const loadedModules = new Map<ModuleName, LoadedModule>()
const moduleFailures = new Map<ModuleName, string>()

/** 懒加载实现包；失败原因被记录（条目降级为「本会话不可用」而不是让插件崩掉）。 */
export async function loadModules(names: Iterable<ModuleName>): Promise<void> {
  for (const name of new Set(names)) {
    if (loadedModules.has(name) || moduleFailures.has(name)) continue
    try {
      const module = await MODULE_LOADERS[name]() as LoadedModule
      loadedModules.set(name, module)
    } catch (error) {
      moduleFailures.set(name, error instanceof Error ? error.message : String(error))
    }
  }
}

/** 已加载的实现包；未加载或被记录为失败时为 undefined。 */
export function moduleOf(name: ModuleName): LoadedModule | undefined {
  return loadedModules.get(name)
}

/** 实现包加载失败原因（诊断用）。 */
export function moduleFailure(name: ModuleName): string | undefined {
  return moduleFailures.get(name)
}

/** 协调器依赖。 */
export interface ReconcileDeps {
  readonly ctx: HostContext
  /** 读取当前设置段（已补齐默认值）。 */
  read(): ObAgentSection
  /** 设置句柄（模型自助管理写入条目表）；缺失时自助管理条目降级。 */
  scope: { update(patch: object): Promise<void> } | undefined
}

/** 一个已安装项的指纹、覆盖的工具名与释放器。 */
interface Install {
  readonly fingerprint: string
  readonly names: readonly string[]
  readonly dispose: () => void | Promise<void>
}

/** 一个 agent 的协调状态。 */
interface AgentState {
  /** 基础注入 fiber（守卫 + 系统提示段）。 */
  base: Fiber | undefined
  /** 隔离层：已应用的拒绝名单与释放器。 */
  restrict: { names: readonly string[]; dispose: Disposer } | undefined
  /** 已安装条目（键 = `sub:<条目id>:<模式>` 或 `nat:<条目id>`）。 */
  installs: Map<string, Install>
  /** 闸门匹配：守卫闭包读取（设置变更后立即生效，无需重装守卫）。 */
  denies: (name: string) => boolean
  /** 当前允许集合：守卫闭包读取。 */
  allowed: Set<string>
  /** 已知存在的工具名累计集（避免二次枚举时被自身限制掩盖而漏拦）。 */
  known: Set<string>
  /** 上一次**成功**应用隐藏层的名字集合：它们已被隐藏、因而不在可见枚举里，但仍可被重复限制。 */
  restricted: Set<string>
  /** 调谐中标记：把重入折叠成一次尾随重算。 */
  reconciling: boolean
  pending: boolean
}

const states = new WeakMap<AgentLike, AgentState>()

function stateOf(agent: AgentLike): AgentState {
  let state = states.get(agent)
  if (state === undefined) {
    state = {
      base: undefined,
      restrict: undefined,
      installs: new Map<string, Install>(),
      denies: () => false,
      allowed: new Set<string>(),
      known: new Set<string>(),
      restricted: new Set<string>(),
      reconciling: false,
      pending: false,
    }
    states.set(agent, state)
  }
  return state
}

/** 子代理只受闸门约束，不再委派。 */
function isChildAgent(agent: AgentLike): boolean {
  return agent.session.header.origin === 'subagent'
}

function serviceOf<T>(ctx: HostContext, name: string): T | undefined {
  const value = ctx.get(name)
  return value === undefined || value === null ? undefined : value as T
}

/** 读取一个作用域当前可见的工具名（模型视角）；失败退化为空集合。 */
function readVisibleNames(tools: ToolRuntimeLike, agent: AgentLike, logger: LoggerLike): Set<string> {
  const names = new Set<string>()
  if (typeof tools.schemas !== 'function') return names
  try {
    for (const schema of tools.schemas(agent.ctx)) names.add(schema.name)
  } catch (error) {
    logger.warn(`dsh-ob-agent: 枚举可见工具失败，闸门的名称枚举退化为配置名单：${error instanceof Error ? error.message : String(error)}`)
  }
  return names
}

/** 由计划构造安装键（导出以便测试与诊断）。 */
export function keyOf(plan: InstallPlan): string {
  return plan.kind === 'subagent' ? `sub:${plan.entry.id}:${plan.mode}` : `nat:${plan.entry.id}`
}

/** 由计划构造指纹（配置变化 → 指纹变化 → 重装）。 */
export function fingerprintOf(plan: InstallPlan): string {
  return plan.kind === 'subagent'
    ? `sub|${plan.toolName}|${JSON.stringify(plan.config)}`
    : `nat|${plan.impl}|${plan.action}|${plan.toolNames.join(',')}`
}

/**
 * 从候选集合里挑出**真正可以交给 `tools.restrict`** 的名字（纯函数）。
 *
 * `restrict` 只接受继承面确实存在的名字：自有层名字与未知名字都会让它抛错，而一旦抛错
 * 整个隐藏层就失效。因此规则是：
 * 1. 自有层（本插件注册）的名字一律排除——它们本来就不受 restrict 约束，由守卫兜住；
 * 2. 其余名字必须「当前可解析」或「上一轮已成功限制过」——后者不可省：被限制掉的名字
 *    会从可见枚举里消失，但它仍可被重复限制，否则第二轮就会把它放出来。
 * @param candidates - 已按闸门与允许集合筛过的候选名单。
 * @param ownNames - 本插件在 agent 自有层注册的名字。
 * @param restrictedBefore - 上一次成功限制过的名字。
 * @param resolvable - 该名字当前是否能在作用域里解析出来。
 * @returns 可安全交给 restrict 的名字（保持输入顺序）。
 */
export function restrictableNames(
  candidates: readonly string[],
  ownNames: ReadonlySet<string>,
  restrictedBefore: ReadonlySet<string>,
  resolvable: (name: string) => boolean,
): string[] {
  return candidates.filter(name => !ownNames.has(name) && (restrictedBefore.has(name) || resolvable(name)))
}

/**
 * 计算隐藏层的拒绝名单（纯函数，便于测试）。
 *
 * 只包含「确实存在」（枚举到、配置里点名、或本插件已知）且命中闸门、又不在允许集合内
 * 的名字：`tools.restrict()` 对未知名字会抛错，多给名字会让整个隐藏层失效。
 * @param section - 当前设置段。
 * @param known - 已知存在的工具名（上一次枚举的累计集）。
 * @param visible - 本次枚举到的可见工具名。
 * @param allowed - 本次允许的集合（已启用条目的工具名）。
 * @returns 排序后的拒绝名单。
 */
export function denyNamesFor(
  section: ObAgentSection,
  known: Iterable<string>,
  visible: Iterable<string>,
  allowed: Iterable<string>,
): string[] {
  if (!section.gate.enabled) return []
  const permitted = new Set(allowed)
  const candidates = new Set<string>([...known, ...visible, ...section.gate.tools])
  const gate = createGateMatcher(section)
  return [...candidates].filter(name => gate.denies(name) && !permitted.has(name)).sort()
}

/** 一条已启用条目本次需要的实现包（子代理条目用委派工具包）。 */
function modulesFor(plan: InstallPlan): ModuleName[] {
  if (plan.kind === 'subagent') return ['tool-subagent']
  if (plan.action !== 'install') return []
  return plan.impl in MODULE_LOADERS ? [plan.impl as ModuleName] : []
}

/** 计算目标安装集合；不可用条目记入 failures。 */
function plansFor(
  section: ObAgentSection,
  active: readonly ActiveEntry[],
  visibleTool: (name: string) => boolean,
): { plans: Map<string, InstallPlan>; failures: Map<string, string> } {
  const context: PlanContext = { visibleTool }
  const plans = new Map<string, InstallPlan>()
  const failures = new Map<string, string>()
  for (const item of active) {
    const entry = item.entry
    if (entry.kind === 'native') {
      const result: PlanResult = planNative(entry, context)
      if (!result.ok) {
        failures.set(entry.id, result.reason)
        continue
      }
      plans.set(keyOf(result.plan), result.plan)
      continue
    }
    for (const mode of entry.modes) {
      const result = planSubagent(entry, mode, section, context)
      if (!result.ok) {
        failures.set(`${entry.id}:${mode}`, result.reason)
        continue
      }
      plans.set(keyOf(result.plan), result.plan)
    }
  }
  return { plans, failures }
}

/**
 * 用代理截获一次 `apply` 里注册的工具定义（不落到真实登记表）。
 *
 * 上游 `list_agents` 只读 `ctx.tools` / `ctx.subagents` / `ctx.agents`，因此只替换
 * `tools` 即可拿到定义，其余服务与上下文原样透传。
 * @param runtimeCtx - 真实作用域上下文。
 * @param apply - 上游模块的 `apply`。
 * @returns 截获到的定义与（可选的）失败原因；失败时已截获的部分仍然返回。
 */
export function captureRegistrations(
  runtimeCtx: HostContext,
  apply: (ctx: unknown) => void,
): { captured: ToolDefinitionLike[]; error?: string } {
  const captured: ToolDefinitionLike[] = []
  const shim = new Proxy(runtimeCtx as object, {
    get(target, property) {
      if (property === 'tools') {
        return {
          register(definition: ToolDefinitionLike): Disposer {
            captured.push(definition)
            return () => undefined
          },
        }
      }
      return Reflect.get(target, property, target)
    },
  })
  try {
    apply(shim)
    return { captured }
  } catch (error) {
    return { captured, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 改写上游 `list_agents` 的定义：结果开头补上「本会话可用的子代理工具」清单。
 *
 * 为什么需要：上游只列**可继续对话的实例**（一次性子代理被过滤），空结果渲染成
 * `(no subagents)`，因此「当前会话有几个子代理」会被答成 0 —— 明明已经勾选了子代理条目。
 * 这里只改模型看到的文本与工具描述，执行、参数模式与输出模式原样沿用上游，避免语义漂移。
 * @param definition - 上游 `defineTool` 产出的定义。
 * @param roster - 每次渲染时实时计算的能力清单（勾选随时可变，不能缓存）。
 * @returns 可直接注册的定义。
 */
export function augmentListAgents(
  definition: ToolDefinitionLike,
  roster: () => string,
): ToolDefinitionLike {
  // 形状不符预期时原样返回：交给注册方的校验去报错，本函数不制造新的失败点。
  if (definition.output === undefined || typeof definition.output.render !== 'function') return definition
  const nativeRender = definition.output.render.bind(definition.output)
  return {
    ...definition,
    description: `${definition.description} ${LIST_AGENTS_NOTE}`,
    output: {
      ...definition.output,
      render(args, value) {
        const blocks = nativeRender(args, value)
        const head = roster()
        // 能力清单拿不到（渲染失败）时保持上游原样，绝不因为本插件让工具结果变形。
        if (head === '') return blocks
        const first = blocks[0]
        // 上游只会返回文本块（ContentBlockLike 只有 text 一种）；其余形状按原样保留在 head 之后。
        if (first === undefined) return [{ type: 'text', text: head }]
        const body = first.text === NATIVE_LIST_EMPTY ? LIST_AGENTS_EMPTY : first.text
        return [{ type: 'text', text: `${head}\n${body}` }, ...blocks.slice(1)]
      },
    },
  }
}

/** 安装一个计划；返回释放器或不可用原因。 */
function installPlan(
  deps: ReconcileDeps,
  agent: AgentLike,
  plan: InstallPlan,
  authoring: AuthoringDeps | undefined,
): { dispose: () => void | Promise<void> } | { reason: string } {
  if (plan.kind === 'subagent') {
    const module = moduleOf('tool-subagent')
    if (module === undefined) return { reason: moduleFailure('tool-subagent') ?? '委派工具包不可用' }
    // 注入面必须与 dsh-tool-subagent 自己的 scoped 装配一致（它读 subagents 提供方、
    // 注册 systemPrompt 段、往 tools 注册工具），少一个都会让 apply 内部拿不到服务。
    const fiber = agent.ctx.inject(['tools', 'subagents', 'systemPrompt'], (runtimeCtx) => {
      try {
        module.apply(runtimeCtx, plan.config)
      } catch (error) {
        deps.ctx.logger.warn(
          `dsh-ob-agent: 装配子代理工具 ${plan.toolName} 失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
    return { dispose: () => fiber.dispose() }
  }
  if (plan.action === 'passthrough') return { dispose: () => undefined }
  if (plan.action === 'plugin') {
    if (authoring === undefined) return { reason: '自助管理不可用（设置句柄缺失）' }
    const fiber = agent.ctx.inject(['tools'], (runtimeCtx) => {
      const tools = serviceOf<ToolRuntimeLike>(runtimeCtx, 'tools')
      if (tools === undefined) return
      for (const tool of authoringTools(authoring)) tools.register(tool)
    })
    return { dispose: () => fiber.dispose() }
  }
  const module = moduleOf(plan.impl as ModuleName)
  if (module === undefined) return { reason: moduleFailure(plan.impl as ModuleName) ?? `实现包 ${plan.impl} 不可用` }
  if (plan.impl === 'list-agents') {
    const sessionId = agent.session.id
    const fiber = agent.ctx.inject(['tools', 'subagents', 'agents'], (runtimeCtx) => {
      const tools = serviceOf<ToolRuntimeLike>(runtimeCtx, 'tools')
      if (tools === undefined) return
      const { captured, error } = captureRegistrations(runtimeCtx, ctx => module.apply(ctx))
      if (error !== undefined) {
        deps.ctx.logger.warn(`dsh-ob-agent: 截获 list_agents 定义失败：${error}`)
      }
      // 只改写清单工具本身：上游若在同一次 apply 里多注册一个工具，不能把它也套上这段说明。
      const targets = captured.filter(definition => definition.name === 'list_agents')
      const fallback = (): void => {
        // 退回原生行为 —— 宁可没有能力清单，也不能让工具消失。
        try {
          module.apply(runtimeCtx)
        } catch (failure) {
          deps.ctx.logger.warn(
            `dsh-ob-agent: 装配 list_agents 失败：${failure instanceof Error ? failure.message : String(failure)}`,
          )
        }
      }
      if (targets.length === 0) {
        // 上游改了注册方式（没截获到）：退回原生装配。若上游那次已经真的注册成功，
        // 这里的二次注册会被同层重名检查拒绝——异常在 fallback 内被兜住，只留一条告警。
        fallback()
        return
      }
      const roster = (): string => {
        try {
          return renderSubagentRoster(deps.read(), sessionId)
        } catch (error) {
          // 渲染发生在工具结果的展示路径上：这里抛错会毁掉整条结果，退化为「不追加」。
          deps.ctx.logger.warn(
            `dsh-ob-agent: 渲染子代理清单失败（本次不追加能力清单）：`
            + `${error instanceof Error ? error.message : String(error)}`,
          )
          return ''
        }
      }
      let installed = 0
      for (const definition of targets) {
        try {
          tools.register(augmentListAgents(definition, roster))
          installed += 1
        } catch (failure) {
          deps.ctx.logger.warn(
            `dsh-ob-agent: 注册改写后的 list_agents 失败：${failure instanceof Error ? failure.message : String(failure)}`,
          )
        }
      }
      if (installed === 0) fallback()
    })
    return { dispose: () => fiber.dispose() }
  }
  const fiber = agent.ctx.inject(['tools', 'subagents', 'systemPrompt'], (runtimeCtx) => {
    if (plan.impl === 'workflow' && serviceOf<unknown>(runtimeCtx, 'workflowEngine') === undefined) {
      deps.ctx.logger.warn(
        'dsh-ob-agent: 缺少 workflowEngine 服务，workflow 条目本会话不可用'
        + '（需要装配 @deepseek-ai/dsh-workflow-worker-thread）',
      )
      return
    }
    try {
      module.apply(runtimeCtx, plan.impl === 'ralph' ? { subagentProvider: 'spawn' } : undefined)
    } catch (error) {
      deps.ctx.logger.warn(
        `dsh-ob-agent: 装配 ${plan.impl} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
  return { dispose: () => fiber.dispose() }
}

/** 协调一个 agent（可重入，重入折叠为一次尾随重算）。 */
export async function reconcileAgent(deps: ReconcileDeps, agent: AgentLike): Promise<void> {
  const state = stateOf(agent)
  if (state.reconciling) {
    state.pending = true
    return
  }
  state.reconciling = true
  try {
    do {
      state.pending = false
      // eslint-disable-next-line no-await-in-loop -- 尾随重算必须串行，避免并发改同一份状态
      await reconcileOnce(deps, agent, state)
    } while (state.pending)
  } finally {
    state.reconciling = false
  }
}

async function reconcileOnce(deps: ReconcileDeps, agent: AgentLike, state: AgentState): Promise<void> {
  const section = deps.read()
  const managing = section.gate.enabled
  const active = managing && !isChildAgent(agent) ? resolveActive(section, agent.session.id) : []

  // 闸门匹配与允许集合先行更新：守卫闭包读取它们，因此「未开启/未勾选就不可用」
  // 这条语义始终成立，即使后面的装配失败。
  const gate = createGateMatcher(section)
  state.denies = managing ? (name: string) => gate.denies(name) : () => false
  state.allowed = new Set(active.flatMap(item => [...item.toolNames]))

  const tools = serviceOf<ToolRuntimeLike>(agent.ctx, 'tools')
  if (tools === undefined) {
    deps.ctx.logger.warn(`dsh-ob-agent: agent ${agent.id} 的作用域没有工具登记表，闸门未生效`)
    return
  }

  // 基础注入（每个 agent 一次）：执行层守卫 + 系统提示段。
  if (state.base === undefined) {
    const sessionId = agent.session.id
    state.base = agent.ctx.inject(['tools', 'systemPrompt'], (runtimeCtx) => {
      const scopedTools = serviceOf<ToolRuntimeLike>(runtimeCtx, 'tools')
      const systemPrompt = serviceOf<SystemPromptLike>(runtimeCtx, 'systemPrompt')
      if (scopedTools === undefined || systemPrompt === undefined) return
      scopedTools.guard((exec) => {
        const name = exec.name
        if (name === undefined || name === '') return undefined
        if (!state.denies(name)) return undefined
        if (state.allowed.has(name)) return undefined
        return `「${name}」在本会话被 dsh-ob-agent 拦截：子代理总开关未开启，或该能力未被勾选。`
          + '请在聊天框的「子代理」面板打开总开关并勾选对应条目后重试。'
      })
      systemPrompt.section({
        name: SECTION_NAME,
        order: systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 1,
        text: () => {
          try {
            const current = deps.read()
            return renderSectionText(current, sessionId, docHint(current.modelGuide))
          } catch (error) {
            deps.ctx.logger.warn(
              `dsh-ob-agent: 渲染 Agent 提示段失败：${error instanceof Error ? error.message : String(error)}`,
            )
            return ''
          }
        },
      })
    })
  }

  // 目标计划：先枚举可见名字，再判定档 A 放行 / 档 B 重挂。
  // 自有层已安装的名字要被排除在「继承面可见」之外，否则档 A 会误判为「原生已提供」。
  const visible = readVisibleNames(tools, agent, deps.ctx.logger)
  const ownNames = new Set([...state.installs.values()].flatMap(install => [...install.names]))
  const { plans, failures } = plansFor(section, active, name => visible.has(name) && !ownNames.has(name))
  for (const [key, reason] of failures) {
    deps.ctx.logger.warn(`dsh-ob-agent: 条目 ${key} 本会话不可用：${reason}`)
  }

  // 实现包必须在 inject 回调之外加载完成（回调保持同步）。
  await loadModules([...plans.values()].flatMap(modulesFor))
  const usable = new Map<string, InstallPlan>()
  for (const [key, plan] of plans) {
    const missing = modulesFor(plan).filter(name => moduleOf(name) === undefined)
    if (missing.length === 0) {
      usable.set(key, plan)
      continue
    }
    // 清单条目的实现包只用于「补能力清单」：加载失败时降级为放行原生工具，
    // 而不是把条目判为不可用——那样会打出「条目不可用」的误导告警，工具却照旧可用。
    if (plan.kind === 'native' && plan.impl === 'list-agents') {
      usable.set(key, { ...plan, action: 'passthrough' })
      for (const name of missing) {
        deps.ctx.logger.warn(
          `dsh-ob-agent: 实现包 ${name} 加载失败，list_agents 的能力清单不可用，已沿用原生工具`,
        )
      }
      continue
    }
    for (const name of missing) {
      deps.ctx.logger.warn(`dsh-ob-agent: 条目 ${key} 本会话不可用：实现包 ${name} 加载失败`)
    }
  }

  // 差异应用：先卸载「不再需要或配置已变」的项，再安装新增项（指纹相同则完全不动）。
  for (const [key, install] of [...state.installs]) {
    const target = usable.get(key)
    if (target !== undefined && fingerprintOf(target) === install.fingerprint) continue
    state.installs.delete(key)
    try {
      await install.dispose()
    } catch (error) {
      deps.ctx.logger.warn(`dsh-ob-agent: 卸载 ${key} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const authoring: AuthoringDeps | undefined = deps.scope === undefined ? undefined : {
    read: () => deps.read(),
    scope: deps.scope,
    audit: (message: string) => deps.ctx.logger.info(`dsh-ob-agent 审计：${message}`),
    sessionIdOf: (target) => target?.session.id,
    docHint: () => '插件文档 docs/model-guide.md',
  }
  for (const [key, plan] of usable) {
    if (state.installs.has(key)) continue
    const installed = installPlan(deps, agent, plan, authoring)
    if ('reason' in installed) {
      deps.ctx.logger.warn(`dsh-ob-agent: 条目 ${key} 本会话不可用：${installed.reason}`)
      continue
    }
    state.installs.set(key, {
      fingerprint: fingerprintOf(plan),
      names: plan.kind === 'subagent' ? [plan.toolName] : plan.toolNames,
      dispose: installed.dispose,
    })
  }

  // 隐藏层最后应用：此时允许集合与已安装集合都是最新的，拒绝名单一次算准。
  applyDenyLayer(deps, agent, state, section, tools)
}

/**
 * 计算并应用隐藏层。
 *
 * `tools.restrict()` 只接受**继承面确实存在**的名字（自有层名字与未知名字都会抛错），
 * 而 `restrictableNames` 是私有视图，因此这里用两个公开事实交叉判断：
 * 1. 自有层已安装的名字永远不进拒绝集（本来就不受 restrict 约束，由守卫兜住）；
 * 2. 其余名字必须是「当前可解析」或「上一轮已成功限制过」——
 *    后者很重要：被限制掉的名字从可见枚举里消失，但它仍可被重复限制，
 *    否则第二轮就会把它放出来。
 * 若仍然抛错（例如预设切换让某个名字彻底消失），退化为只用当前可解析的名字重试一次，
 * 失败则保留告警并放弃隐藏层（守卫仍然生效）。
 */
function applyDenyLayer(
  deps: ReconcileDeps,
  agent: AgentLike,
  state: AgentState,
  section: ObAgentSection,
  tools: ToolRuntimeLike,
): void {
  const visibleNow = readVisibleNames(tools, agent, deps.ctx.logger)
  for (const name of visibleNow) state.known.add(name)
  const ownNames = new Set<string>()
  for (const install of state.installs.values()) {
    for (const name of install.names) {
      state.known.add(name)
      ownNames.add(name)
    }
  }
  const resolvable = (name: string): boolean => {
    try {
      return tools.get(name, agent.ctx) !== undefined
    } catch {
      return false
    }
  }
  const deny = restrictableNames(
    denyNamesFor(section, state.known, visibleNow, state.allowed),
    ownNames,
    state.restricted,
    resolvable,
  )

  const unchanged = state.restrict !== undefined
    && state.restrict.names.length === deny.length
    && state.restrict.names.every((name, index) => name === deny[index])
  if (unchanged) return

  if (attemptRestrict(deps, agent, state, tools, deny)) return
  // 退化：预设切换可能让某个「上一轮限制过」的名字彻底消失，只保留当前可解析的名字重试。
  const fallback = deny.filter(name => resolvable(name))
  if (fallback.length !== deny.length) attemptRestrict(deps, agent, state, tools, fallback)
}

/**
 * 应用一次隐藏层（含空名单）。
 *
 * 每次调用都先释放上一层的 disposer：否则「目标名单变空」时旧限制会一直挂着，
 * 而 `state.restricted` 却已被清空 —— 之后需要重新隐藏时会因为「不可解析且不在
 * restricted 里」把本该隐藏的名字放出来。
 * @param deps - 协调器依赖。
 * @param agent - 目标 agent。
 * @param state - 该 agent 的协调状态。
 * @param tools - 工具登记表。
 * @param names - 本次要隐藏的名字。
 * @returns 是否应用成功。
 */
function attemptRestrict(
  deps: ReconcileDeps,
  agent: AgentLike,
  state: AgentState,
  tools: ToolRuntimeLike,
  names: readonly string[],
): boolean {
  state.restrict?.dispose()
  state.restrict = undefined
  if (names.length === 0) {
    state.restricted = new Set<string>()
    return true
  }
  try {
    state.restrict = { names: [...names], dispose: tools.restrict({ deny: [...names] }) }
    state.restricted = new Set(names)
    return true
  } catch (error) {
    state.restricted = new Set<string>()
    deps.ctx.logger.warn(
      `dsh-ob-agent: agent ${agent.id} 应用工具隐藏层失败（闸门仍由执行层兜住）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

/** 释放一个 agent 的全部注册（agent 销毁时调用）。 */
export async function disposeAgent(agent: AgentLike): Promise<void> {
  const state = states.get(agent)
  if (state === undefined) return
  states.delete(agent)
  for (const install of state.installs.values()) {
    try {
      await install.dispose()
    } catch {
      // agent 已经销毁：释放失败无需诊断噪音。
    }
  }
  state.restrict?.dispose()
  try {
    await state.base?.dispose()
  } catch {
    // 同上。
  }
}
