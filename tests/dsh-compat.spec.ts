/**
 * 与**真实 DSH 运行时**的兼容性测试（大版本升级后的回归闸）。
 *
 * 为什么需要它：`src/context-types.ts` / `src/vendor.d.ts` 是手写的「使用面镜像」，
 * `tests/reconcile*.spec.ts` 用的是同形替身 —— 两者都能在 DSH 换了实现之后继续通过，
 * 因为它们校验的是本插件的**假设**，不是上游的**事实**。本文件把假设拿到真实
 * `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` 上跑一遍。
 *
 * DSH 的包只发布在它自己的解析链上（见 `src/vendor.d.ts`），本仓库装不进来，因此这里用
 * **绝对路径动态导入**加载 profile 里的副本：
 * - 解析根目录：`DSH_PROFILE_NODE_MODULES`，缺省 `~/.dsh/profiles/node_modules`；
 * - 找不到 DSH 时整组跳过（普通 CI / 没装 DSH 的机器上仍然是绿的），跳过的原因会打印出来。
 *
 * 升级 DSH 后请务必跑一次：`npm test`。任何一条挂掉都说明本插件的使用面假设已经过时。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { authoringTools, type AuthoringDeps } from '../src/authoring.ts'
import { DEFAULT_SECTION } from '../src/defaults.ts'
import { readSection } from '../src/normalize.ts'
import type { ToolDefinitionLike } from '../src/context-types.ts'

/**
 * 决定「这台机器上有没有 DSH」的最小包集。
 *
 * 只放核心包：定位失败时整组跳过，而**升级时真的消失的包必须在测试里失败而不是跳过** ——
 * 否则上游删掉 `dsh-tool-ralph` 这类包时，本组会静默变绿，把真实的不兼容藏起来。
 */
const CORE_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-scope',
] as const

/** 本插件的加载路径依赖的包；缺任何一个都应当让测试**失败**。 */
const LOADED_PACKAGES = [
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-workflow',
] as const

/** 解析 DSH 包的安装根目录；找不到时返回 undefined。 */
function resolveDshRoot(): string | undefined {
  const fromEnv = process.env.DSH_PROFILE_NODE_MODULES
  const candidates = fromEnv !== undefined && fromEnv !== ''
    ? [fromEnv]
    : [join(homedir(), '.dsh', 'profiles', 'node_modules')]
  for (const root of candidates) {
    if (CORE_PACKAGES.every(name => existsSync(join(root, ...name.split('/'), 'package.json')))) {
      return root
    }
  }
  return undefined
}

const dshRoot = resolveDshRoot()

if (dshRoot === undefined) {
  console.warn(
    '[dsh-compat] 未找到 DSH 运行时（可设 DSH_PROFILE_NODE_MODULES 指向其 node_modules），'
    + '本组兼容性测试已跳过',
  )
}

/** 以绝对路径导入 DSH 包的主入口（绕开只解析本仓库依赖的打包器）。 */
async function loadDsh(specifier: string): Promise<Record<string, unknown>> {
  const entry = join(dshRoot as string, ...specifier.split('/'), 'lib', 'index.js')
  return await import(pathToFileURL(entry).href) as Record<string, unknown>
}

const suite = dshRoot === undefined ? describe.skip : describe

suite('DSH 运行时兼容：工具登记表', () => {
  /** 造一台真实 cordis 运行时（SystemPrompt + ToolRuntime），并给出一个 agent 作用域。 */
  async function boot(): Promise<{
    rootCtx: { tools: RealTools, systemPrompt: unknown }
    agentKey: object
    scopeCtx: { tools: RealTools }
    scoped: <T>(body: (ctx: { tools: RealTools }) => T) => Promise<T>
    dispose(): Promise<void>
  }> {
    const { Context } = await loadDsh('@deepseek-ai/cordis')
    const { ToolRuntime } = await loadDsh('@deepseek-ai/dsh-tools')
    const { SystemPrompt } = await loadDsh('@deepseek-ai/dsh-system-prompt')
    const { createScope } = await loadDsh('@deepseek-ai/dsh-scope')
    const ctx = new (Context as new () => Record<string, unknown>)()
    ;(ctx.plugin as (plugin: unknown) => unknown)(SystemPrompt)
    ;(ctx.plugin as (plugin: unknown) => unknown)(ToolRuntime)
    await new Promise(resolve => setTimeout(resolve, 50))
    const agentKey = { id: 'compat-agent' }
    const scoped = async <T>(body: (inner: { tools: RealTools }) => T): Promise<T> => await new Promise<T>((resolve, reject) => {
      ;(ctx.inject as (services: string[], cb: (inner: unknown) => void) => unknown)(['tools'], (inner) => {
        try {
          resolve(body(inner as { tools: RealTools }))
        } catch (error) {
          reject(error)
        }
      })
    })
    const scope = await scoped(inner => createScope(inner, agentKey)) as {
      ctx: { tools: RealTools }
      dispose(): Promise<void>
    }
    return {
      rootCtx: ctx as unknown as { tools: RealTools; systemPrompt: unknown },
      agentKey,
      scopeCtx: scope.ctx,
      scoped,
      dispose: () => scope.dispose(),
    }
  }

  it('register / restrict / guard / get / schemas 的语义与本插件的假设一致', async () => {
    const runtime = await boot()
    try {
      const inherited = ['read', 'send_message', 'list_agents', 'workflow']
      for (const name of inherited) runtime.rootCtx.tools.register(definitionOf(name))

      // `schemas(scope)` 的 scope 是「查看者作用域键」：必须传 agent 本身。
      const visible = () => runtime.scopeCtx.tools.schemas(runtime.agentKey).map(schema => schema.name).sort()
      expect(visible()).toEqual([...inherited].sort())

      // 隐藏层：整批应用于继承面，成功即从可见清单消失，释放后恢复。
      const lift = runtime.scopeCtx.tools.restrict({ deny: ['list_agents', 'workflow'] })
      expect(visible()).toEqual(['read', 'send_message'])
      // 限制是**按作用域**的：别的查看者键照旧看得到，这正是隐藏层必须装在 agent 作用域上的原因。
      expect(runtime.rootCtx.tools.schemas({ id: 'other' }).map(schema => schema.name)).toContain('workflow')
      lift()
      expect(visible()).toEqual([...inherited].sort())

      // 未知名字与自有层名字都必须整批抛错 —— 协调器的逐个降级路径依赖这一点。
      expect(() => runtime.scopeCtx.tools.restrict({ deny: ['nope_not_a_tool'] }))
        .toThrow(/unknown global tool/)
      const own = runtime.scopeCtx.tools.register(definitionOf('own_tool'))
      expect(() => runtime.scopeCtx.tools.restrict({ deny: ['own_tool'] }))
        .toThrow(/unknown global tool/)
      // 自有层注册不受 restrict 约束，只能靠执行层守卫兜住。
      expect(visible()).toContain('own_tool')
      own()

      // `get(name, scope)` 按同一个作用域键解析（传 agent 本身）。
      expect(runtime.scopeCtx.tools.get('read', runtime.agentKey)?.name).toBe('read')

      // 守卫接受协调器写入的回调形状（返回字符串即拒绝，undefined 即放行），注册本身不抛错。
      expect(() => runtime.scopeCtx.tools.guard(exec => (exec.name === 'workflow' ? '被闸门拒绝' : undefined)))
        .not.toThrow()
    } finally {
      await runtime.dispose()
    }
  })

  it('本插件的裸定义能被真实 register 接受，且参数模式是 object 根的 JSON Schema', async () => {
    const runtime = await boot()
    try {
      const deps: AuthoringDeps = {
        read: () => readSection(DEFAULT_SECTION),
        scope: { update: () => Promise.resolve() },
        audit: () => undefined,
        sessionIdOf: () => 'session-1',
        docHint: () => 'docs/model-guide.md',
      }
      const definitions = authoringTools(deps)
      const disposers = definitions.map(definition =>
        runtime.scopeCtx.tools.register(definition as unknown as never))

      // 真实注册表按名字 + 参数模式投影；`schemaOf` 只白名单 name/description/parameters。
      const schemas = runtime.scopeCtx.tools.schemas(runtime.agentKey)
        .filter(schema => schema.name.startsWith('agent_'))
      expect(schemas.map(schema => schema.name).sort()).toEqual(['agent_create', 'agent_list', 'agent_update'])
      for (const schema of schemas) {
        const parameters = schema.parameters as { type?: unknown; properties?: unknown }
        expect(parameters.type, `${schema.name} 的 parameters 必须是 object 根的 JSON Schema`).toBe('object')
        expect(typeof parameters.properties).toBe('object')
      }
      for (const dispose of disposers) dispose()
    } finally {
      await runtime.dispose()
    }
  })

  it('上游工具包与实现包都还能被本插件的加载路径解析出来', async () => {
    // 协调器用字面量动态导入这些说明符（esbuild 靠它保持外部化）；少一个就有一条条目降级。
    for (const specifier of LOADED_PACKAGES.slice(0, 4)) {
      const module = await loadDsh(specifier)
      expect(typeof module.apply, `${specifier} 必须具名导出 apply`).toBe('function')
      expect(module.name, `${specifier} 必须具名导出 name`).toBeTruthy()
    }
    // 子路径导出：子代理回发只重挂 `send_message` 时用它。
    const listAgents = await import(
      pathToFileURL(join(dshRoot as string, '@deepseek-ai', 'dsh-tool-subagent-control', 'lib', 'types', 'list-agents.js')).href
    ) as Record<string, unknown>
    expect(typeof listAgents.apply).toBe('function')

    // workflowEngine 服务由 @deepseek-ai/dsh-workflow 提供（不是已下线的 worker-thread 包）。
    const workflow = await loadDsh('@deepseek-ai/dsh-workflow')
    expect(Object.keys(workflow)).toContain('WorkflowEngine')
  })
})

/** 真实登记表的最小形状（只列出本测试用到的成员）。 */
interface RealTools {
  register(definition: unknown): () => void
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
  guard(guard: (exec: { name: string }) => string | undefined): () => void
  get(name: string, scope?: unknown): { name?: string } | undefined
  schemas(scope?: unknown): readonly { name: string; parameters: unknown }[]
}

/** 与上游同形的裸工具定义（只满足 `register` 的校验面）。 */
function definitionOf(name: string): ToolDefinitionLike {
  return {
    name,
    description: `compat probe ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: name }] },
    execute: () => Promise.resolve({}),
  }
}
