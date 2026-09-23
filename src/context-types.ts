/**
 * 本插件消费的 cordis 服务结构面（主机半与浏览器半共用）。
 *
 * 为什么不直接用 `@deepseek-ai/dsh-*` 的类型：这些包只发布在 DSH 自己的解析链上
 * （见 `src/vendor.d.ts` 的说明），装不进普通 registry 依赖；而且第三方插件与 DSH
 * 单体仓库并不共享同一个 cordis 实例，上游的 `declare module 'cordis'` 增强未必到达
 * 本程序的 Context。因此这里按「实际使用面」给出结构类型，偏差被限制在本文件内。
 */

/** 注册返回值：精确的注销器。 */
export interface Disposer {
  (): void
}

/** cordis 注入出的 fiber（可精确释放该注入带来的全部注册）。 */
export interface Fiber {
  dispose(): Promise<void> | void
}

/** 主机侧 agent：会话、作用域 Context 与稳定 id。 */
export interface AgentLike {
  readonly id: string
  readonly session: SessionLike
  readonly ctx: HostContext
}

/** 会话面（仅本插件读取/追加的部分）。 */
export interface SessionLike {
  readonly id: string
  readonly header: {
    readonly id: string
    readonly cwd?: string
    readonly origin?: 'subagent'
    readonly agentPreset?: string
  }
  append(type: string, data: unknown): unknown
}

/** agent 注册表（`ctx.get('agents')`）。 */
export interface AgentRegistryLike {
  list(): readonly AgentLike[]
}

/** 工具执行上下文（本插件读取调用方 agent 与取消信号）。 */
export interface ToolExecLike {
  readonly name?: string
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
}

/** 模型可见的工具定义。 */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  /** 参数模式：`{ 字段名: { type, required?, description, items?, properties? } }`。 */
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: Record<string, unknown>, value: unknown): readonly ContentBlockLike[]
  }
  readonly isConcurrencySafe?: (args: Record<string, unknown>) => boolean
  readonly timeoutMs?: number
  execute(args: Record<string, unknown>, exec: ToolExecLike): Promise<unknown>
}

/** 模型可见的内容块（本插件只产出文本与错误）。 */
export interface ContentBlockLike {
  readonly type: 'text'
  readonly text: string
}

/** 工具登记表（`ctx.get('tools')`）。 */
export interface ToolRuntimeLike {
  /** 在调用方作用域注册工具；返回精确注销器。 */
  register(definition: ToolDefinitionLike): Disposer
  /** 对调用方作用域屏蔽继承来的工具；`allow` 保留、`deny` 移除。 */
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): Disposer
  /** 注册执行前守卫：返回字符串即拒绝。 */
  guard(guard: (exec: ToolExecLike) => string | undefined): Disposer
  /** 按作用域解析可见工具（省略作用域 = 全局视图）。 */
  get(name: string, scope?: unknown): ToolDefinitionLike | undefined
  /** 按作用域投影当前模型可见的工具模式（用于枚举「继承面到底有哪些名字」）。 */
  schemas?(scope?: unknown): readonly { readonly name: string }[]
}

/** 系统提示注册表。 */
export interface SystemPromptLike {
  section(section: {
    name: string
    order: number
    text: string | ((context: { scope?: unknown }) => string)
    complete?: boolean
  }): Disposer
  getSectionOrder(name: string): number
}

/** 主机设置：一个命名空间的属主句柄。 */
export interface HostSettingsScope<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void | Promise<void>): Disposer
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
}

/** 设置服务（`ctx.get('settings')`）：注册命名空间并取回属主句柄。 */
export interface SettingsServiceLike {
  register<T>(namespace: string, schema: unknown, options?: { base?: object }): HostSettingsScope<T>
}

/** 日志面。 */
export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 主机 Context 的最小结构面（本插件实际用到的成员）。 */
export interface HostContext {
  readonly logger: LoggerLike
  get(name: string): unknown
  inject(services: readonly string[], callback: (ctx: HostContext) => void): Fiber
  effect(callback: () => void | Disposer, label?: string): Fiber
  on(event: string, listener: (...args: never[]) => void): Disposer
}

/** 浏览器侧可观察源：`hooks: { x: source }` 会绑定成组件的 `useX` 钩子。 */
export interface ObservableLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): Disposer
}

/** 浏览器设置命名空间句柄（`ctx.settingsScope.bind(spec)`）。 */
export interface ClientSettingsScope<T> {
  getSnapshot(): {
    readonly status: 'loading' | 'ready' | 'unavailable'
    readonly value: T | undefined
    readonly revision: number | undefined
    readonly writable: boolean
    readonly mode: 'host' | 'memory'
  }
  subscribe(listener: () => void): Disposer
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
  mutate(ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[]): Promise<void>
}

/** 浏览器设置绑定服务（`ctx.get('settingsScope')`）。 */
export interface SettingsScopeBinderLike {
  bind<T>(spec: { namespace: string; decode?: (section: unknown) => T | undefined }): ClientSettingsScope<T>
}

/** 槽位注册面（`ctx.slots`）。 */
export interface SlotsLike {
  inject(name: string, factory: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

/** 浏览器 locale 面（`ctx.locale`）。 */
export interface LocaleLike {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): Disposer
  bind(namespace: string): (key: string, params?: Record<string, string>) => string
}

/** 浏览器 Context 的最小结构面。 */
export interface ClientContext {
  get(name: string): unknown
  effect(callback: () => void | Disposer, label?: string): Fiber
  on(event: string, listener: (...args: never[]) => void): Disposer
  readonly slots: SlotsLike
  readonly locale: LocaleLike
}
