/** 新版 DSH 委派适配：使用公开 activation API，策略先持久化、后创建子代理。 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentLike, Disposer, HostContext, ToolRuntimeLike } from './context-types.ts'
import type { SubagentInstallPlan } from './implement.ts'

const CHILD_PREFIX = 'obagent-'
const CHILD_ID = /^obagent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface ChildPolicy {
  readonly version: 1
  readonly childId: string
  readonly parentId: string
  readonly mode: 'continuable'
  readonly identityPrompt?: string
  readonly allow?: readonly string[]
}

/** 策略目录独立于工作目录；重启/冷恢复时必须保留，不做自动 TTL 清理。 */
export function policyDirectory(): string {
  return process.env.DSH_OB_AGENT_POLICY_DIR?.trim()
    ? resolve(process.env.DSH_OB_AGENT_POLICY_DIR)
    : join(process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh'), 'plugins', 'dsh-ob-agent', 'child-policies')
}

export function validatePolicy(value: unknown, childId: string): ChildPolicy {
  if (value === null || typeof value !== 'object') throw new Error('子代理安全策略不是有效对象')
  const p = value as Record<string, unknown>
  if (!CHILD_ID.test(childId) || p.version !== 1 || p.childId !== childId
    || Object.keys(p).some(key => !['version', 'childId', 'parentId', 'mode', 'identityPrompt', 'allow'].includes(key))
    || typeof p.parentId !== 'string' || p.parentId.length === 0
    || p.mode !== 'continuable'
    || (p.identityPrompt !== undefined && typeof p.identityPrompt !== 'string')
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
      // allow:[] 合法且拒绝全部继承工具；非空时逐名试探可限制面，不能把自有层误当继承层。
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
      prompt.section({ name: 'deployment:persona-prefix', order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: policy.identityPrompt })
      prompt.section({ name: 'deployment:persona-suffix', order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: '' })
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

export function installChildPolicies(ctx: HostContext): void {
  const installed = new WeakSet<AgentLike>()
  ctx.on('agent/created', async ({ agent }: { agent: AgentLike }) => {
    if (installed.has(agent)) return
    const policy = await readChildPolicy(agent.id)
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

/** 保留上游参数/路由预检，只在公开 startActivation 边界补充已废弃的条目策略。 */
export function subagentContext(runtimeCtx: HostContext, plan: SubagentInstallPlan): HostContext {
  const nativeSubagents = runtimeCtx.get('subagents') as Subagents
  const subagents = new Proxy(nativeSubagents, {
    get(target, property) {
      if (property !== 'startActivation') return Reflect.get(target, property, target)
      return async (spec: ActivationSpec): Promise<Activation> => {
        const childId = `${CHILD_PREFIX}${randomUUID()}`
        await persistPolicy({
          version: 1, childId, parentId: spec.request.parent.id, mode: plan.mode,
          ...(plan.identityPrompt !== undefined ? { identityPrompt: plan.identityPrompt } : {}),
          ...(plan.readOnlyAllow !== undefined ? { allow: plan.readOnlyAllow } : {}),
        })
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
  })
}
