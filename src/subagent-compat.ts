/**
 * 新版 DSH 委派适配：使用公开 activation API，策略先持久化、后创建子代理。
 *
 * 安全路径只有一条：受管子代理（`obagent-<UUID>`）在**创建之前**把不可覆盖的策略快照落盘，
 * 串行 `agent/created` 阶段再按快照装配身份与白名单；快照缺失、损坏、父子不符或装配服务
 * 缺失一律拒绝发布，绝不降级成「完全权限」。
 *
 * 团队模式（官方实验性 Agent Team）只影响协调器释放哪些**普通**工具：受管快照的只读约束
 * 在这里与其它任何时候一致地生效，任何模式开关都绕不过；官方团队自己的子代理不落在
 * `obagent-` 命名空间，因此本模块既不接管、也不改动它们。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentLike, Disposer, HostContext, ToolRuntimeLike } from './context-types.ts'
import type { SubagentInstallPlan } from './implement.ts'

const CHILD_PREFIX = 'obagent-'
const CHILD_ID = /^obagent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 策略目录的插件级逃生口（测试与运维部署用）；优先级高于设置与宿主 home。 */
const POLICY_DIR_ENV = 'DSH_OB_AGENT_POLICY_DIR'
/** 策略目录在宿主 home 下的相对路径。 */
const POLICY_SUBPATH = ['plugins', 'dsh-ob-agent', 'child-policies'] as const

/**
 * 宿主 home 的显式来源。
 *
 * - 字符串：调用方在装配时读到的快照（例如插件设置里的 `dshHome`）；
 * - getter：每次解析时现读，跟随设置热更新；
 * - 省略 / 空串 / 纯空白：未配置，回落到官方 `resolveDshHome` 的优先级
 *   （`$DSH_HOME` → `~/.dsh`）。
 *
 * 空串必须按「未配置」处理：官方 `resolveDshHome('')` 会把 home 解析成**当前工作目录**。
 */
export type DshHomeSource = string | (() => string | undefined)

export interface ChildPolicy {
  readonly version: 1
  readonly childId: string
  readonly parentId: string
  readonly mode: 'continuable'
  readonly identityPrompt?: string
  readonly allow?: readonly string[]
}

/** 官方 home 解析器形状（`@deepseek-ai/dsh-home-paths`）。 */
type HomeResolver = (configured?: string, env?: Record<string, string | undefined>) => string

/** 官方解析器只在首次使用时加载一次；包不可用时回退到等价实现（null = 还没试过）。 */
let officialResolver: HomeResolver | undefined | null = null

/**
 * 加载官方 home 解析器。
 *
 * 为什么动态解析而不是静态 import：DSH 的包只发布在它自己的解析链上（见 `vendor.d.ts`），
 * 本仓库与普通 CI 都装不进来；静态 import 会让单测直接因缺包而失败。运行期插件由 profile
 * 安装，`createRequire` 从插件自身位置向上走即可拿到官方实现。
 */
function loadOfficialResolver(): HomeResolver | undefined {
  if (officialResolver !== null) return officialResolver
  officialResolver = undefined
  try {
    const loaded = createRequire(import.meta.url)('@deepseek-ai/dsh-home-paths') as { resolveDshHome?: unknown }
    if (typeof loaded?.resolveDshHome === 'function') officialResolver = loaded.resolveDshHome as HomeResolver
  } catch {
    // 无官方包（测试环境、裁剪部署）：用下方等价实现，优先级保持一致。
  }
  return officialResolver
}

/** 展开官方支持的 `~` / `~/` / `~\` 前缀。 */
function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** 回退实现：优先级与官方 `resolveDshHome` 一致（显式 > 非空 `$DSH_HOME` > `~/.dsh`）。 */
function fallbackResolver(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  const chosen = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
  return resolve(expandTilde(chosen))
}

/** 读取显式 home；空白视为未配置，避免把设置项默认空串解析成当前目录。 */
function explicitHome(source?: DshHomeSource): string | undefined {
  const raw = typeof source === 'function' ? source() : source
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 解析宿主 home（官方 `resolveDshHome` 优先，缺失时用等价实现）。 */
export function resolveHostHome(source?: DshHomeSource): string {
  const configured = explicitHome(source)
  const official = loadOfficialResolver()
  return official === undefined ? fallbackResolver(configured) : official(configured)
}

/**
 * 策略目录解析：插件逃生口 > 显式 home > 官方 `resolveDshHome`（`$DSH_HOME` > `~/.dsh`）。
 *
 * 策略目录独立于工作目录；重启/冷恢复时必须保留，不做自动 TTL 清理。
 * 创建与冷恢复共用本函数，任何一处改了 home 来源都会让另一边读不到快照而**拒绝启动**，
 * 因此调用方必须把同一个 home 来源同时交给 `subagentContext` 与 `installChildPolicies`。
 */
export function policyDirectory(dshHome?: DshHomeSource): string {
  const override = process.env[POLICY_DIR_ENV]?.trim()
  if (override !== undefined && override.length > 0) return resolve(expandTilde(override))
  return join(resolveHostHome(dshHome), ...POLICY_SUBPATH)
}

export function validatePolicy(value: unknown, childId: string): ChildPolicy {
  if (value === null || typeof value !== 'object') throw new Error('子代理安全策略不是有效对象')
  const p = value as Record<string, unknown>
  if (!CHILD_ID.test(childId) || p.version !== 1 || p.childId !== childId
    || Object.keys(p).some(key => !['version', 'childId', 'parentId', 'mode', 'identityPrompt', 'allow'].includes(key))
    || typeof p.parentId !== 'string' || p.parentId.length === 0
    || p.mode !== 'continuable'
    // 空白身份与 `allow: []` 一样按「明确写坏了」处理：身份段一旦注册就会遮蔽父预设身份，
    // 空字符串等于把子代理身份清空，必须当场拒绝而不是静默发布一个没有角色的子代理。
    || (p.identityPrompt !== undefined && (typeof p.identityPrompt !== 'string' || p.identityPrompt.trim().length === 0))
    || (p.allow !== undefined && (!Array.isArray(p.allow) || p.allow.length === 0
      || new Set(p.allow).size !== p.allow.length
      || !p.allow.every(name => typeof name === 'string' && name.length > 0 && name !== 'run_code')))) {
    throw new Error('子代理安全策略校验失败，已拒绝启动，避免身份或权限降级')
  }
  return p as unknown as ChildPolicy
}

export async function persistPolicy(policy: ChildPolicy, directory = policyDirectory()): Promise<void> {
  validatePolicy(policy, policy.childId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // 不覆盖已有身份；写入完成前绝不调用宿主创建接口。中断留下坏文件也会在恢复时拒绝。
  await writeFile(join(directory, `${policy.childId}.json`), JSON.stringify(policy), { flag: 'wx', mode: 0o600, flush: true })
}

export async function readChildPolicy(childId: string, directory = policyDirectory()): Promise<ChildPolicy | undefined> {
  if (!childId.startsWith(CHILD_PREFIX)) return undefined
  if (!CHILD_ID.test(childId)) throw new Error('插件子代理标识非法，已拒绝恢复')
  try {
    return validatePolicy(JSON.parse(await readFile(join(directory, `${childId}.json`), 'utf8')), childId)
  } catch (error) {
    throw new Error(`无法读取子代理安全策略，已拒绝启动或恢复：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 在宿主串行 agent/created 阶段完成装配；失败直接否决发布，不允许后台降级运行。 */
export async function applyChildPolicy(agent: AgentLike, policy: ChildPolicy): Promise<void> {
  validatePolicy(policy, agent.id)
  if (agent.session.header.origin !== 'subagent' || agent.session.header.parentSession !== policy.parentId) {
    throw new Error('子代理安全策略与会话父子身份不匹配')
  }
  let applied = false
  const fiber = agent.ctx.inject(['tools', 'systemPrompt'], runtimeCtx => {
    const tools = runtimeCtx.get('tools') as ToolRuntimeLike
    if (policy.allow !== undefined) {
      const allowed = new Set(policy.allow)
      // 新注册与自有层工具同样必须被拒绝；隐藏失败不影响守卫的单调拒绝。
      tools.guard(exec => {
        if (exec.name !== undefined && !allowed.has(exec.name)) return `子代理处于只读模式，工具 ${exec.name} 不在授权白名单内`
        if (exec.name === 'send_message' && exec.arguments?.agent_id !== policy.parentId) return '只读子代理只能回发给直接父代理'
        return undefined
      })
      // 隐藏层允许空名单（拒绝全部继承工具）；非空白名单逐名试探可限制面，自有层名字会整批
      // 抛错，只能由上面的守卫兜底，不能让整个白名单限制失效。
      const restrictable: string[] = []
      for (const name of allowed) {
        try {
          const lift = tools.restrict({ allow: [name] })
          lift()
          restrictable.push(name)
        } catch {
          // 自有层名字只能由守卫兜底，不能让整个白名单限制失效。
        }
      }
      tools.restrict({ allow: restrictable })
    }
    if (policy.identityPrompt !== undefined) {
      const prompt = runtimeCtx.get('systemPrompt') as { section(value: unknown): Disposer; getSectionOrder(name: string): number }
      // 只覆盖身份前缀。**不注册空的 persona-suffix**：作用域内的同名段会遮蔽（dsh-scope 的
      // merge 按名字让最近的层胜出），注册空串等于替用户抹掉部署级 personaSuffix 以及父预设
      // 的后缀；官方子代理组合（dsh-subagent 的 applyChildOverrides）也只写前缀。
      prompt.section({ name: 'deployment:persona-prefix', order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: policy.identityPrompt })
    }
    applied = true
  })
  try {
    if (fiber.await === undefined) throw new Error('当前 DSH 缺少可等待的作用域装配接口，拒绝不安全降级')
    await fiber.await()
    if (!applied) throw new Error('子代理安全策略缺少工具或提示词服务，已拒绝启动')
  } catch (error) {
    await fiber.dispose()
    throw error
  }
}

/**
 * 安装「创建/冷恢复即装配策略」的串行监听。
 *
 * @param ctx - 宿主上下文。
 * @param dshHome - 宿主 home 来源；与 `subagentContext` 必须一致，否则冷恢复读不到快照而拒绝。
 */
export function installChildPolicies(ctx: HostContext, dshHome?: DshHomeSource): void {
  const installed = new WeakSet<AgentLike>()
  ctx.on('agent/created', async ({ agent }: { agent: AgentLike }) => {
    if (installed.has(agent)) return
    // 每次事件现解析：getter 形式跟随设置热更新，字符串形式是调用方给的快照。
    const policy = await readChildPolicy(agent.id, policyDirectory(dshHome))
    if (policy === undefined) return
    await applyChildPolicy(agent, policy)
    installed.add(agent)
  })
}

interface Activation {
  readonly childId: string
  readonly result: Promise<{ output: readonly unknown[]; stopReason: string; diagnostic?: string }>
  dispose(): Promise<void>
}
interface ActivationSpec {
  readonly request: { readonly parent: AgentLike; readonly [key: string]: unknown }
  readonly signal: AbortSignal
  readonly [key: string]: unknown
}
interface Subagents {
  startActivation(spec: ActivationSpec): Promise<Activation>
}

/**
 * 保留上游参数/路由预检，只在公开 startActivation 边界补充受管条目策略。
 *
 * 代理的读写语义按真实 cordis 实现对齐（勿改成 `Reflect.get(target, property, receiver)`）：
 * - `get` 必须把**真实上下文**当 receiver 传给内层代理——cordis 的 `scopeOf(ctx)` 读的是
 *   `ctx[kScope]` 这类符号自有属性，访问器式方法（`ctx.inject` / `ctx.get`）也由内层
 *   trap 用该 receiver 绑定 `this`；换成包装器会让注册落到全局层。
 * - 方法调用本身仍以包装器为 `this`，cordis 的 Context 方法只读内部状态（属性与符号都
 *   经本 trap 转发到真实上下文），因此不受影响；已知边界：若调用方对包装器调用
 *   `extend/isolate/intercept`，派生上下文会以包装器为原型。被消费的工具装配面不调用它们。
 * - `set` 必须转发到真实上下文：cordis 自己的 `set` trap 负责拒绝未声明属性，默认的
 *   `[[Set]]`（receiver = 包装器）只会在包装层留下影子状态，真实上下文看不到。
 *
 * @param runtimeCtx - 工具装配用的作用域上下文。
 * @param plan - 条目实装计划（身份、只读白名单、模式）。
 * @param dshHome - 宿主 home 来源；与 `installChildPolicies` 必须一致。
 */
export function subagentContext(runtimeCtx: HostContext, plan: SubagentInstallPlan, dshHome?: DshHomeSource): HostContext {
  const nativeSubagents = runtimeCtx.get('subagents') as Subagents
  const subagents = new Proxy(nativeSubagents, {
    // 只覆写创建入口：写入留在包装层（宿主服务不应能被包装器改写），读取逐项转发。
    get(target, property) {
      if (property !== 'startActivation') return Reflect.get(target, property, target)
      return async (spec: ActivationSpec): Promise<Activation> => {
        const childId = `${CHILD_PREFIX}${randomUUID()}`
        // 先落盘再创建：任何失败都不会留下「已创建但无策略」的子代理。
        await persistPolicy({
          version: 1, childId, parentId: spec.request.parent.id, mode: plan.mode,
          ...(plan.identityPrompt !== undefined ? { identityPrompt: plan.identityPrompt } : {}),
          ...(plan.readOnlyAllow !== undefined ? { allow: plan.readOnlyAllow } : {}),
        }, policyDirectory(dshHome))
        // 经由 traceable 代理调用，cordis 才会把调用方作用域绑进服务的 `this.ctx`。
        return await target.startActivation({ ...spec, childId })
      }
    },
  })
  return new Proxy(runtimeCtx, {
    get(target, property) {
      if (property === 'subagents') return subagents
      if (property === 'get') return (name: string): unknown => name === 'subagents' ? subagents : target.get(name)
      return Reflect.get(target, property, target)
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target)
    },
  })
}
