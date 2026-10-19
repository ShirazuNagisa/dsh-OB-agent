/**
 * 模型自助管理工具的单元测试：写入路径、护栏（作用域/上限/校验）与结果文案。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SECTION } from '../src/defaults.ts'
import { authoringTools, entryFromArgs, parameterSchemaOf, type AuthoringDeps } from '../src/authoring.ts'
import { readSection } from '../src/normalize.ts'
import type { ToolDefinitionLike, ToolExecLike } from '../src/context-types.ts'
import type { ObAgentEntry, ObAgentSection } from '../src/contract.ts'

interface Harness {
  readonly tools: ToolDefinitionLike[]
  readonly writes: Record<string, unknown>[]
  readonly audits: string[]
  readonly deps: AuthoringDeps
  setSection(next: ObAgentSection): void
}

/** 造一台「假主机」：设置读写与审计都被记录下来。 */
function harness(raw: Record<string, unknown> = {}): Harness {
  let section = readSection({ ...DEFAULT_SECTION, ...raw })
  const writes: Record<string, unknown>[] = []
  const audits: string[] = []
  const deps: AuthoringDeps = {
    read: () => section,
    scope: {
      update: (patch: object) => {
        writes.push(patch as Record<string, unknown>)
        return Promise.resolve()
      },
    },
    audit: message => { audits.push(message) },
    sessionIdOf: agent => agent?.session.id,
    docHint: () => 'D:/plugin/docs/model-guide.md',
  }
  return {
    tools: authoringTools(deps),
    writes,
    audits,
    deps,
    setSection: (next) => { section = next },
  }
}

function toolOf(tools: readonly ToolDefinitionLike[], name: string): ToolDefinitionLike {
  const found = tools.find(tool => tool.name === name)
  if (found === undefined) throw new Error(`缺少工具 ${name}`)
  return found
}

const exec: ToolExecLike = { agent: { session: { id: 's1' } } as never }

describe('entryFromArgs', () => {
  it('只有 provider 与 model 同时给出时才钉死路由', () => {
    const partial = entryFromArgs({ id: 'demo', name: 'x', whenPrompt: 'a', identityPrompt: 'b', modelProvider: 'p' })
    expect(typeof partial).not.toBe('string')
    if (typeof partial !== 'string') expect(partial.model).toBeUndefined()
  })

  it('过滤非法模式并按需回退', () => {
    const entry = entryFromArgs({
      id: 'demo',
      name: 'x',
      whenPrompt: 'a',
      identityPrompt: 'b',
      modes: ['continuable'],
      provider: 'fork',
      permission: 'readonly',
    })
    expect(typeof entry).not.toBe('string')
    if (typeof entry === 'string') return
    expect(entry.modes).toEqual(['continuable'])
    expect(entry.provider).toBe('fork')
    expect(entry.permission).toBe('readonly')
    expect(entry.source).toBe('model')
  })

  it('拒绝模型继续创建已退役的一次性模式', () => {
    expect(entryFromArgs({ id: 'demo', name: 'x', whenPrompt: 'a', identityPrompt: 'b', modes: ['one-shot'] })).toContain('只支持 continuable')
  })

  it('缺少 id 时返回中文原因', () => {
    expect(entryFromArgs({ name: 'x' })).toBe('缺少 id')
  })
})

describe('agent_list', () => {
  it('列出全部条目与本会话状态，并给出总开关默认与上限', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: ['general'] } } })
    const text = String(await toolOf(h.tools, 'agent_list').execute({}, exec))
    expect(text).toContain('code_review')
    expect(text).toContain('本会话已启用')
    expect(text).toContain('总开关默认：关')
    expect(text).toContain('条目上限：24 条')
  })
})

describe('agent_create', () => {
  const args = {
    id: 'doc_writer',
    name: '文档撰写',
    whenPrompt: '需要写使用文档时调用',
    identityPrompt: '你是文档撰写子代理',
  }

  it('写入新条目（source=model）并给出「下一轮可用」提示与审计', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: [] } } })
    const text = String(await toolOf(h.tools, 'agent_create').execute(args, exec))
    expect(h.writes).toHaveLength(1)
    const entries = h.writes[0]?.entries as ObAgentEntry[]
    expect(entries).toHaveLength(DEFAULT_SECTION.entries.length + 1)
    const created = entries.find(entry => entry.id === 'doc_writer')
    expect(created?.source).toBe('model')
    expect(created?.modes).toEqual(['continuable'])
    expect(text).toContain('下一轮请求')
    expect(h.audits[0]).toContain('doc_writer')
  })

  it('默认 enableNow 时把新条目写进本会话勾选（同一次合并写入）', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: ['general'] } } })
    const text = String(await toolOf(h.tools, 'agent_create').execute(args, exec))
    const sessions = h.writes[0]?.sessions as Record<string, { enabled: boolean; selected: string[] }>
    expect(sessions.s1?.selected).toEqual(['general', 'doc_writer'])
    expect(sessions.s1?.enabled).toBe(true)
    expect(text).toContain('已加入本会话勾选')
  })

  it('总开关关闭时写入勾选但不声称可用', async () => {
    const h = harness()
    const text = String(await toolOf(h.tools, 'agent_create').execute(args, exec))
    const sessions = h.writes[0]?.sessions as Record<string, { enabled: boolean; selected: string[] }>
    expect(sessions.s1?.selected).toEqual(['doc_writer'])
    expect(sessions.s1?.enabled).toBe(false)
    expect(text).toContain('总开关')
  })

  it('enableNow=false 时既不写会话记录也不声称已启用', async () => {
    const h = harness({ sessions: { s1: { enabled: true, selected: [] } } })
    const text = String(await toolOf(h.tools, 'agent_create').execute({ ...args, enableNow: false }, exec))
    expect(h.writes[0]?.sessions).toBeUndefined()
    expect(text).toContain('未在本会话启用')
  })

  it('标识冲突时拒绝写入并提示先查重', async () => {
    const h = harness()
    const text = String(await toolOf(h.tools, 'agent_create').execute({ ...args, id: 'general' }, exec))
    expect(text).toContain('已被占用')
    expect(h.writes).toHaveLength(0)
  })

  it('未知提示词变量被拒绝', async () => {
    const h = harness()
    const text = String(await toolOf(h.tools, 'agent_create').execute({ ...args, whenPrompt: '见 {{nope}}' }, exec))
    expect(text).toContain('{{nope}}')
    expect(h.writes).toHaveLength(0)
  })

  it('只读权限且交集为空时仍可创建（可见性在装配期判定），但缺白名单会被拒', async () => {
    const h = harness({ readOnlyTools: [] })
    const text = String(await toolOf(h.tools, 'agent_create').execute({ ...args, permission: 'readonly' }, exec))
    expect(text).toContain('只读权限需要非空的只读工具白名单')
    expect(h.writes).toHaveLength(0)
  })

  it('达到条目上限时拒绝', async () => {
    const h = harness({ authoring: { ...DEFAULT_SECTION.authoring, maxEntries: DEFAULT_SECTION.entries.length } })
    const text = String(await toolOf(h.tools, 'agent_create').execute(args, exec))
    expect(text).toContain('已达上限')
    expect(h.writes).toHaveLength(0)
  })

  it('自助管理被关闭时拒绝', async () => {
    const h = harness({ authoring: { ...DEFAULT_SECTION.authoring, enabled: false } })
    const text = String(await toolOf(h.tools, 'agent_create').execute(args, exec))
    expect(text).toContain('已被用户关闭')
    expect(h.writes).toHaveLength(0)
  })
})

describe('agent_update', () => {
  it('默认作用域下拒绝修改内置条目', async () => {
    const h = harness()
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'code_review', name: '改名' }, exec))
    expect(text).toContain('不是模型创建的条目')
    expect(h.writes).toHaveLength(0)
  })

  it('允许修改模型自建条目', async () => {
    const h = harness()
    await toolOf(h.tools, 'agent_create').execute({
      id: 'tmp_agent',
      name: '临时',
      whenPrompt: 'a',
      identityPrompt: 'b',
    }, exec)
    const created = h.writes[0]?.entries as ObAgentEntry[]
    h.setSection(readSection({ ...DEFAULT_SECTION, entries: created }))
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'tmp_agent', name: '改名后' }, exec))
    expect(text).toContain('已保存')
    const updated = h.writes[1]?.entries as ObAgentEntry[]
    expect(updated.find(entry => entry.id === 'tmp_agent')?.name).toBe('改名后')
  })

  it('作用域为 all 时可修改内置条目的可编辑字段', async () => {
    const h = harness({ authoring: { ...DEFAULT_SECTION.authoring, scope: 'all' } })
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'code_review', description: '新描述' }, exec))
    expect(text).toContain('已保存')
    const updated = h.writes[0]?.entries as ObAgentEntry[]
    expect(updated.find(entry => entry.id === 'code_review')?.description).toBe('新描述')
  })

  it('原生工具条目不能按子代理字段修改', async () => {
    const h = harness({ authoring: { ...DEFAULT_SECTION.authoring, scope: 'all' } })
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'workflow', name: 'x' }, exec))
    expect(text).toContain('DSH 原生工具条目')
    expect(h.writes).toHaveLength(0)
  })

  it('不存在的条目给出查重提示', async () => {
    const h = harness()
    const text = String(await toolOf(h.tools, 'agent_update').execute({ id: 'nope', name: 'x' }, exec))
    expect(text).toContain('没有这个条目')
  })
})

describe('工具定义自身', () => {
  it('三个工具都声明了输出渲染与并发分类', () => {
    const h = harness()
    expect(h.tools.map(tool => tool.name)).toEqual(['agent_create', 'agent_update', 'agent_list'])
    for (const tool of h.tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.output.render({}, 'x')).toEqual([{ type: 'text', text: 'x' }])
    }
    expect(toolOf(h.tools, 'agent_list').isConcurrencySafe?.({})).toBe(true)
    expect(toolOf(h.tools, 'agent_create').isConcurrencySafe?.({})).toBe(false)
  })

  it('参数模式是模型可见的 JSON Schema（根为 object），不是作者侧属性表', () => {
    // 上游 `ToolSchema.parameters` 的契约是 JSON Schema；直接把属性表注册上去不会报错，
    // 只会静默降级：Anthropic 系 provider 因 input_schema 非 object 拒绝，OpenAI 系则把
    // 字段名当未知关键字。这条断言就是防止再次退化。
    const h = harness()
    const create = toolOf(h.tools, 'agent_create').parameters
    expect(create.type).toBe('object')
    const props = create.properties as Record<string, Record<string, unknown>>
    expect(Object.keys(props).sort()).toEqual([
      'defaultEnabled', 'description', 'enableNow', 'id', 'identityPrompt', 'model', 'modelProvider',
      'modes', 'name', 'permission', 'provider', 'readOnlyAllow', 'whenPrompt',
    ])
    expect(create.required).toEqual(['id', 'name', 'whenPrompt', 'identityPrompt'])
    // 属性表里的 `required: true` 必须被搬进根 required 数组，不能留在属性定义里
    for (const property of Object.values(props)) expect(property.required).toBeUndefined()
    expect(props.id?.type).toBe('string')
    expect(props.modes?.type).toBe('array')

    const list = toolOf(h.tools, 'agent_list').parameters
    expect(list).toEqual({ type: 'object', properties: {} })
  })

  it('parameterSchemaOf 保留非对象字段定义并忽略非 true 的 required', () => {
    const schema = parameterSchemaOf({
      a: { type: 'string', required: true },
      b: { type: 'number', required: false },
      c: { type: 'boolean' },
    })
    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } },
      required: ['a'],
    })
  })
})
