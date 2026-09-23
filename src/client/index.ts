/**
 * dsh-ob-agent 浏览器插件：聊天输入框上方的「子代理」条 + 设置页「子代理」。
 *
 * 两处界面共用同一个设置桥（`ctx.settingsScope` 绑定的 `ob-agent` 命名空间）：
 * 会话级选择存放在该命名空间的 `sessions` 映射里，因此不需要自定义 Remote、投影或
 * HTTP 路由，也不存在「界面与主机状态不一致」的中间层。
 */
import type { ClientContext, SettingsScopeBinderLike } from '../context-types.ts'
import { OB_AGENT_NAMESPACE } from '../contract.ts'
import { ObAgentDock, type ObAgentDockInjected } from './dock.tsx'
import { NS, en, zh } from './locales.ts'
import { loadModelCatalog, type ModelCatalogResult } from './modelcatalog.ts'
import { ObAgentSection, type ObAgentSectionInjected } from './section.tsx'
import { adoptStyles } from './styles.ts'
import { createObAgentStore, type ObAgentStore, type ObAgentWire } from './store.ts'

/** 必需服务：槽位注册表、文案、设置命名空间句柄。 */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * 插件体：注册词典、两处槽位与模型清单读取。
 * @param ctx - 浏览器 cordis 上下文。
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ob-agent: dictionaries')
  const t = ctx.locale.bind(NS)

  const binder = ctx.get('settingsScope') as SettingsScopeBinderLike | undefined
  if (binder === undefined) {
    console.error('[dsh-ob-agent] settingsScope 服务不可用：界面未注册（请确认 ui-settings 已装配）')
    return
  }
  const scope = binder.bind<ObAgentWire>({ namespace: OB_AGENT_NAMESPACE })

  // 每个会话一个设置桥；插件卸载时统一释放订阅。
  const stores = new Map<string, ObAgentStore>()
  const storeFor = (sessionId: string): ObAgentStore => {
    const existing = stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createObAgentStore(scope, sessionId)
    stores.set(sessionId, created)
    return created
  }
  ctx.effect(() => () => {
    for (const store of stores.values()) store.dispose()
    stores.clear()
  }, 'dsh-ob-agent: stores')

  // 模型清单只成功读取一次；失败允许下次进入设置页重试。
  let catalog: ModelCatalogResult | undefined
  const loadModels = async (): Promise<ModelCatalogResult> => {
    if (catalog !== undefined && catalog.error === undefined) return catalog
    catalog = await loadModelCatalog(ctx)
    return catalog
  }

  // 输入框上方整行：总开关 + 条目勾选（会话作用域）。
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'ob-agent',
    order: 30,
    locale: NS,
    inject: (sessionId: string): ObAgentDockInjected => {
      const store = storeFor(sessionId)
      return {
        hooks: { obAgent: store },
        sessionId,
        setSession: next => store.setSession(next),
      }
    },
  }, ObAgentDock))

  // 设置页：全局默认值、条目管理、闸门名单、自助管理开关。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ob-agent',
    order: 60,
    label: () => t('nav'),
    locale: NS,
    inject: (): ObAgentSectionInjected => {
      // 设置页与会话无关：用一个空会话键取全局默认视图。
      const store = storeFor('')
      return {
        hooks: { obAgent: store },
        patch: fields => store.patch(fields),
        loadModels,
      }
    },
  }, ObAgentSection))
}
