/**
 * dsh-ob-agent 主机插件：把 DSH 的全部 agent 类工具收口到一处统一管理。
 *
 * 职责：
 * - 注册设置命名空间 `ob-agent`（条目表、闸门名单、自助管理开关等）；
 * - 在 `agent/created` 上为每个 agent 建立协调状态：执行层守卫 + 隐藏层 +
 *   按勾选装配工具 + 每会话的「Agent 工具信息」系统提示段；
 * - 设置变更、工具集变更、agent 生命周期变化时重算（幂等，只增删差异项）。
 *
 * 会话级选择存放在设置段的 `sessions` 映射里（键为会话 id），由浏览器经
 * `ctx.settingsScope` 写入；主机只读它，因此不需要自定义 Remote、投影或 HTTP 路由。
 */
import type { AgentLike, AgentRegistryLike, HostContext, HostSettingsScope, SettingsServiceLike } from './context-types.ts'
import { DEFAULT_SECTION, DEFAULTS_REVISION } from './defaults.ts'
import { readSection, storedRevision } from './normalize.ts'
import { registerSettings } from './settings.ts'
import { disposeAgent, reconcileAgent, type ReconcileDeps } from './reconcile.ts'
import type { ObAgentSection } from './contract.ts'

/** Cordis 插件名（Loader 入口与客户端 bundle id）。 */
export const name = 'dsh-ob-agent'

/** 必需服务：全部按需注入（见 apply），因此这里声明为空。 */
export const inject: string[] = []

/** 配置：本插件没有 Loader 侧配置，全部走设置命名空间。 */
export interface Config {}

/**
 * 插件体。
 * @param ctx - 主机 cordis 上下文。
 */
export function apply(ctx: HostContext): void {
  let scope: HostSettingsScope<unknown> | undefined
  let section: ObAgentSection = DEFAULT_SECTION
  let queued = false

  /** 读取当前设置段（设置未就绪时给出厂默认）。 */
  const read = (): ObAgentSection => section

  const deps: ReconcileDeps = {
    ctx,
    read,
    get scope() {
      return scope
    },
  }

  /** 全量重算所有顶层与子代理（幂等；并发由协调器内部折叠）。 */
  const runAll = async (): Promise<void> => {
    const agents = ctx.get('agents') as AgentRegistryLike | undefined
    if (agents === undefined) return
    for (const agent of agents.list()) {
      try {
        // 串行：同一份设置快照下逐个 agent 应用，避免设置热更新时的交叉状态。
        // eslint-disable-next-line no-await-in-loop
        await reconcileAgent(deps, agent)
      } catch (error) {
        ctx.logger.warn(
          `dsh-ob-agent: 协调 agent ${agent.id} 失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /** 合并同一轮内的多次触发（设置提交、工具变更、agent 创建）。 */
  const schedule = (): void => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      void runAll()
    })
  }

  // 设置命名空间：可选服务（没有 settings 时插件仍以出厂默认工作，只是无法持久化）。
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as SettingsServiceLike | undefined
    if (settings === undefined) {
      ctx.logger.warn('dsh-ob-agent: 设置服务不可用，条目改为只读的出厂默认')
      return
    }
    const registered = registerSettings(settings)
    scope = registered
    const stored = registered.get()
    section = readSection(stored)
    // settings 服务可能在 apply() 之后才就绪：此时首次 reconcile 已用出厂默认跑过，
    // 必须再触发一次，否则早于设置就绪创建的 agent 会停在出厂默认上。
    schedule()
    // 历史设置段（版本落后于出厂默认）在内存里已经迁移完毕，这里把它落盘。
    // 三个字段必须一笔写入：只写版本号会让旧的内置条目永久留在文件里，只写条目表
    // 又会让改名条目的会话勾选在下次读取时被封存（读取只在版本落后时才迁移）。
    if (storedRevision(stored) < DEFAULTS_REVISION) {
      void registered.update({
        defaultsRevision: DEFAULTS_REVISION,
        entries: section.entries,
        sessions: section.sessions,
      }).then(() => {
        ctx.logger.info(
          `dsh-ob-agent: 出厂默认已迁移到第 ${DEFAULTS_REVISION} 版（内置条目与会话选择已同步）`,
        )
      }).catch((error: unknown) => {
        ctx.logger.warn(
          `dsh-ob-agent: 迁移结果落盘失败（内存中已按新默认工作，重启后会重试）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
    settingsCtx.effect(() => registered.watch((next) => {
      const parsed = readSection(next)
      const errors = validate(parsed)
      if (errors.length > 0) {
        ctx.logger.warn(`dsh-ob-agent: 设置段存在问题（已按可用部分继续）：${errors.join('；')}`)
      }
      section = parsed
      schedule()
    }), 'dsh-ob-agent: settings watch')
    settingsCtx.effect(() => () => {
      scope = undefined
      section = DEFAULT_SECTION
    }, 'dsh-ob-agent: settings release')
  })

  // agent 生命周期：创建即装配；销毁即释放（协调状态同时由 WeakMap 回收）。
  ctx.on('agent/created', (payload: { agent: AgentLike }) => {
    try {
      // 处理器必须同步返回：同步抛错会否决 agent 发布，因此这里只登记重算。
      const agent = payload?.agent
      if (agent === undefined) return
      void reconcileAgent(deps, agent).catch(error => {
        ctx.logger.warn(
          `dsh-ob-agent: 初始化 agent ${agent.id} 失败：${error instanceof Error ? error.message : String(error)}`,
        )
      })
    } catch (error) {
      ctx.logger.error(`dsh-ob-agent: agent/created 处理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.on('agent/disposed', (payload: { agent: AgentLike }) => {
    const agent = payload?.agent
    if (agent === undefined) return
    void disposeAgent(agent)
  })

  // 工具集变化（预设切换、MCP 上下线、本插件自身的装配）→ 重算。幂等保证不成环。
  ctx.on('tools/change', () => schedule())

  // 首次装配：已有 agent（HMR / 重新挂载）也要纳入管理。
  schedule()
}

/** 校验设置段的最小不变量；只告警不阻断（用户的半成品配置不应让插件失效）。 */
function validate(section: ObAgentSection): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const entry of section.entries) {
    if (seen.has(entry.id)) errors.push(`条目标识重复：${entry.id}`)
    seen.add(entry.id)
  }
  if (section.entries.length === 0) errors.push('条目表为空，已回退为无任何 Agent 工具')
  return errors
}
