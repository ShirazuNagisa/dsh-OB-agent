/**
 * 运行期由 profile 解析的 DSH 包在本插件里的最小声明。
 *
 * 为什么不用 `@deepseek-ai/dsh-*` 作为 devDependencies：这些包只发布在 DSH 自己的
 * 解析链上（`~/.dsh/profiles/node_modules/@deepseek-ai/*` → npx 缓存），它们的依赖图
 * 含未发布的内部包（例如 `@deepseek-ai/dsh-tasks`），从公共 registry 安装会 404。
 * 本插件的构建把 `@deepseek-ai/*` 全部外部化，运行期由 profile 提供；开发期则在此
 * 声明实际用到的成员，使 typecheck 不依赖任何 DSH 包的本地安装。
 *
 * 这些声明只是「使用面」的镜像：每个成员都在 dsh 侧的实现里核对过。若上游签名变化，
 * 偏差被限制在本文件内。
 */

/** 委派工具装配：`apply(ctx, config)` 在传入的 ctx 所属层注册一个工具实例。 */
declare module '@deepseek-ai/dsh-tool-subagent' {
  /** 工具配置（仅列出本插件写入的字段）。 */
  export interface SubagentToolConfig {
    provider: string
    toolName?: string
    enableRunInBackground?: boolean
    backgroundMode?: 'one-shot' | 'continuable'
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
    persona?: string
    toolFilter?: { allow?: string[]; deny?: string[] }
    maxDepth?: number | 'provider-managed'
  }
  export const name: string
  export const inject: string[]
  export function apply(ctx: unknown, config: SubagentToolConfig): void
}

/** 子代理续话 / 中止工具（`send_message`、`interrupt_agent`）。 */
declare module '@deepseek-ai/dsh-tool-subagent-control' {
  export const name: string
  export const inject: string[]
  export function apply(ctx: unknown): void
}

/** 子代理清单工具（`list_agents`）。 */
declare module '@deepseek-ai/dsh-tool-subagent-control/list-agents' {
  export const name: string
  export const inject: string[]
  export function apply(ctx: unknown): void
}

/** 工作流编排工具（`workflow`）。 */
declare module '@deepseek-ai/dsh-tool-workflow' {
  export const name: string
  export const inject: string[]
  export function apply(ctx: unknown, config?: { toolName?: string; maxResultChars?: number }): void
}

/** 深度迭代工具（`ralph`）。 */
declare module '@deepseek-ai/dsh-tool-ralph' {
  export const name: string
  export const inject: string[]
  export function apply(ctx: unknown, config?: { subagentProvider?: string; maxRounds?: number }): void
}

/** 工作流引擎（worker thread 实现，`workflow` 工具依赖 `workflowEngine` 服务）。 */
declare module '@deepseek-ai/dsh-workflow-worker-thread' {
  const WorkerThreadWorkflowEngine: unknown
  export default WorkerThreadWorkflowEngine
}

/** 设置服务的模式描述（DSH 内部使用同一份实现）。 */
declare module '@deepseek-ai/schemastery' {
  export interface SchemasterySchema {
    (value: unknown): unknown
    toString(): string
    default(value: unknown): SchemasterySchema
    volatile(): SchemasterySchema
  }
  export interface Schemastery {
    object(shape: Record<string, unknown>): SchemasterySchema
    array(inner: unknown): SchemasterySchema
    string(): SchemasterySchema
    number(): SchemasterySchema
    natural(): SchemasterySchema
    boolean(): SchemasterySchema
    any(): SchemasterySchema
    union(types: readonly unknown[]): SchemasterySchema
    const(value: unknown): SchemasterySchema
  }
  const z: Schemastery
  export default z
}
