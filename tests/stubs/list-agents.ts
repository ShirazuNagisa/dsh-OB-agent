/**
 * `@deepseek-ai/dsh-tool-subagent-control/list-agents` 的测试替身。
 *
 * 与同目录的 `tool-subagent-control.ts` 成对：上游把这一个工具拆成**独立子路径**发布
 * （根入口只注册 `send_message` / `interrupt_agent`），因此 vitest 必须为子路径单独配别名，
 * 否则本插件 `agents_list` 条目的装配路径会静默降级成放行（`moduleOf('list-agents')`
 * 取不到 → 计划改成 `passthrough` → 工具根本没注册），让真实不兼容藏起来。
 *
 * 形状与上游一致：具名导出 `name` / `inject` / `apply`，`apply` 注册一个带 `output.render`
 * 的 `list_agents`（渲染空结果时必须是上游的 `(no subagents)` 文案，本插件的清单改写靠它识别）。
 */
import type { ToolDefinitionLike } from '../../src/context-types.ts'

export const name = 'tool-subagent-list-agents'

export const inject = ['tools', 'subagents', 'agents']

/** 与上游同形的 `list_agents` 定义：只有名字与渲染文案对本插件可见。 */
function definitionOf(): ToolDefinitionLike {
  return {
    name: 'list_agents',
    description: 'list_agents（测试替身）',
    parameters: { type: 'object', properties: { scope: { type: 'string' } } },
    output: {
      schema: { type: 'array' },
      render: () => [{ type: 'text', text: '(no subagents)' }],
    },
    async execute() {
      return []
    },
  }
}

/**
 * 注册 `list_agents`。
 * @param ctx - 工具登记表所在的作用域上下文。
 */
export function apply(ctx: unknown): void {
  const runtime = ctx as { tools: { register(item: ToolDefinitionLike): unknown } }
  runtime.tools.register(definitionOf())
}
