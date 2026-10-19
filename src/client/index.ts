/**
 * dsh-ob-agent 浏览器插件：聊天输入框上方的「子代理」条 + 设置页「子代理」。
 *
 * 两处界面共用 `dsh-ob-agent` 的配置表单；会话级选择与全局配置保存在同一个
 * `section` 对象中，由 DSH 的 configForms 负责同步和持久化。
 */
import type { ClientContext, ClientSettingsScope, ConfigFormsLike } from '../context-types.ts'
import { ObAgentDock, type ObAgentDockInjected } from './dock.tsx'
import { missingHostComponents } from './host-ui.tsx'
import { NS, en, zh } from './locales.ts'
import { loadModelCatalog, type ModelCatalogResult } from './modelcatalog.ts'
import { ObAgentSection, type ObAgentSectionInjected } from './section.tsx'
import { adoptStyles } from './styles.ts'
import { createObAgentStore, type ObAgentStore, type ObAgentWire } from './store.ts'

/** 必需服务：槽位注册表、文案与 DSH 插件配置表单。 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * 插件体：注册词典、两处槽位与模型清单读取。
 * @param ctx - 浏览器 cordis 上下文。
 */
export function apply(ctx: ClientContext): void {
  // 宿主组件自检只告警、不拦截：真缺件时 React 也只是摘掉本插件那一个槽位条目，
  // 而「因为自检就不注册」会让整个界面消失，是更糟的失败模式。
  const missingHost = missingHostComponents()
  if (missingHost.length > 0) {
    console.error(
      `[dsh-ob-agent] 宿主 UI 组件不兼容（未解析到 ${missingHost.join('、')}）：界面可能渲染失败，`
      + '请把本插件的 @deepseek-ai/dsh-client-ui-primitives 与 DSH 版本对齐后重新构建',
    )
  }

  adoptStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ob-agent: dictionaries')
  const t = ctx.locale.bind(NS)

  const forms = ctx.get('configForms') as ConfigFormsLike | undefined
  if (forms === undefined) {
    console.error('[dsh-ob-agent] configForms 服务不可用：界面未注册（请确认 ui-settings 已装配）')
    return
  }
  const form = forms.get('dsh-ob-agent')
  const scope: ClientSettingsScope<ObAgentWire> = {
    getSnapshot() {
      const snapshot = form.getSnapshot()
      return { ...snapshot, value: snapshot.value as ObAgentWire | undefined }
    },
    subscribe: listener => form.subscribe(listener),
    async set(field, value) {
      return requireAccepted(await form.set(field, value))
    },
    async unset(field) {
      return requireAccepted(await form.unset(field))
    },
    async mutate(ops) {
      return requireAccepted(await form.mutate(ops))
    },
  }

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
        setTeamMode: next => store.patch({ teamMode: next }),
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

function requireAccepted(accepted: boolean): void {
  if (!accepted) throw new Error('DSH 未接受插件配置写入，请刷新页面后重试')
}
