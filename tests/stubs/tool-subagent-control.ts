/**
 * `@deepseek-ai/dsh-tool-subagent-control` 的测试替身。
 *
 * 真实实现包只发布在 DSH 自己的解析链上（见 `src/vendor.d.ts`），本仓库装不进来；
 * vitest 通过 `resolve.alias` 把它指到这里，用于覆盖「子代理只重挂 `send_message`」
 * 这条装配路径。形状与上游一致：具名导出 `apply` / `inject` / `name`，`apply` 一次
 * 注册两个工具，且 `execute` 闭包持有 `apply` 收到的上下文（上游也是这么写的）。
 */
import type { ToolDefinitionLike } from '../../src/context-types.ts'

export const name = 'tool-subagent-control'

export const inject = ['tools', 'subagents']

/** 与上游同形的工具定义：只有名字对本插件可见，其余字段仅满足形状校验。 */
function definitionOf(toolName: string): ToolDefinitionLike {
  return {
    name: toolName,
    description: `${toolName}（测试替身）`,
    parameters: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
    output: {
      schema: { type: 'object' },
      render: () => [{ type: 'text', text: `${toolName} ok` }],
    },
    async execute() {
      return {}
    },
  }
}

/**
 * 注册 `send_message` 与 `interrupt_agent`。
 * @param ctx - 工具登记表所在的作用域上下文。
 */
export function apply(ctx: unknown): void {
  const runtime = ctx as { tools: { register(item: ToolDefinitionLike): unknown } }
  runtime.tools.register(definitionOf('send_message'))
  runtime.tools.register(definitionOf('interrupt_agent'))
}
