/**
 * 模型自助管理工具：`agent_create` / `agent_update` / `agent_list`。
 *
 * 设计要点：
 * - 三个工具由本插件直接注册在 agent 自有层（不依赖任何 DSH 工具包），条目写入设置段；
 * - 默认作用域 `own`：模型只能创建/修改 `source === 'model'` 的条目，内置与用户条目安全；
 * - 每次写入都过 {@link validateEntry}，失败返回结构化中文原因，绝不写坏设置；
 * - 工具可见性在「下一轮请求」才生效，结果文案必须显式说明，否则模型会在同一轮里调用
 *   一个还不存在的工具；
 * - 每次创建/修改都写一条中文审计日志，便于用户回溯模型改了什么。
 */
import {
  ENTRY_LIMITS,
  subagentToolName,
  type EntryMode,
  type ObAgentEntry,
  type ObAgentSection,
  type ObAgentSessionState,
  type SubagentProviderName,
} from './contract.ts'
import type { ToolDefinitionLike } from './context-types.ts'
import { normalizeEntry, validateEntry } from './normalize.ts'

/** 写入条目表（可选同时写入会话记录）；合并写入，避免整段 replace 丢字段。 */
async function writeEntries(
  scope: { update(patch: object): Promise<void> },
  entries: readonly ObAgentEntry[],
  extra?: Record<string, unknown>,
): Promise<void> {
  await scope.update({ entries: entries.map(entry => ({ ...entry })), ...extra })
}

/**
 * 把一个新条目加入本会话勾选（`enableNow`）。
 *
 * 主机与浏览器写的是同一份 `sessions` 映射：这里按「读到的当前值 + 新 id」整体写入，
 * 与设置页复选框的写法一致；总开关本身仍由用户控制，这里不会替用户打开它。
 * @param section - 当前设置段。
 * @param sessionId - 目标会话。
 * @param entryId - 新条目 id。
 * @returns 合并后的 `sessions` 补丁；会话未知时返回 undefined。
 */
function selectionPatch(
  section: ObAgentSection,
  sessionId: string | undefined,
  entryId: string,
): { sessions: Record<string, ObAgentSessionState>; enabled: boolean } | undefined {
  if (sessionId === undefined) return undefined
  const stored = section.sessions[sessionId]
  const enabled = stored?.enabled ?? section.masterEnabledDefault
  const selected = [...new Set([...(stored?.selected ?? []), entryId])]
  return { sessions: { ...section.sessions, [sessionId]: { enabled, selected } }, enabled }
}

/** 自助管理工具运行所需的上下文。 */
export interface AuthoringDeps {
  /** 读取当前设置段。 */
  read(): ObAgentSection
  /** 设置句柄（写入条目表）。 */
  scope: { update(patch: object): Promise<void> }
  /** 写一条中文审计日志。 */
  audit(message: string): void
  /** 由工具调用的 agent 解析会话 id。 */
  sessionIdOf(agent: { readonly session: { readonly id: string } } | undefined): string | undefined
  /** 面向模型的文档提示（路径或说明）。 */
  docHint(): string
}

/** 工具执行面的最小形状（本插件只读 agent 与会话）。 */
interface AuthoringExec {
  readonly agent?: { readonly session: { readonly id: string } }
}

const CREATE_PARAMETERS: Record<string, unknown> = {
  id: {
    type: 'string',
    required: true,
    description: 'Agent 标识：2-24 位、小写字母开头，仅含小写字母/数字/下划线；它决定工具名 subagent_<id>。',
  },
  name: { type: 'string', required: true, description: `显示名称（不超过 ${ENTRY_LIMITS.name} 字符）。` },
  whenPrompt: {
    type: 'string',
    required: true,
    description: '给主模型看的「何时调用」提示词：必须写清何时该调用、何时不要调用。',
  },
  identityPrompt: {
    type: 'string',
    required: true,
    description: '给子代理看的身份提示词：它看不到父会话，必须自包含。',
  },
  description: { type: 'string', description: '一句话描述，用于界面展示。' },
  modes: {
    type: 'array',
    items: { type: 'string' },
    description: '运行模式：one-shot（一次性）与/或 continuable（可继续对话）；默认 one-shot。',
  },
  provider: { type: 'string', description: '子代理后端：spawn（全新上下文，默认）或 fork（继承已完成轮次）。' },
  permission: { type: 'string', description: '权限档：full（完全，默认）或 readonly（只能读文件，不能运行命令）。' },
  readOnlyAllow: {
    type: 'array',
    items: { type: 'string' },
    description: '只读权限下的工具白名单（省略则用全局白名单）。',
  },
  modelProvider: { type: 'string', description: '钉死的子模型 provider（与 model 同时给出；省略则继承主会话）。' },
  model: { type: 'string', description: '钉死的子模型 id（与 modelProvider 同时给出）。' },
  defaultEnabled: { type: 'boolean', description: '是否在新会话里默认勾选（默认 false）。' },
  enableNow: { type: 'boolean', description: '是否在本会话立即启用（默认 true；总开关未打开时只创建条目）。' },
}

const UPDATE_PARAMETERS: Record<string, unknown> = {
  id: { type: 'string', required: true, description: '要修改的条目标识。' },
  ...CREATE_PARAMETERS,
}

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args: Record<string, unknown>, value: unknown): readonly { type: 'text'; text: string }[] =>
    [{ type: 'text', text: String(value) }],
} as const

/** 由模型参数构造一条 `source: 'model'` 的条目；参数不成立时返回中文原因。 */
export function entryFromArgs(args: Record<string, unknown>, base?: ObAgentEntry): ObAgentEntry | string {
  const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : base?.id
  if (id === undefined) return '缺少 id'
  const rawModes = Array.isArray(args.modes)
    ? args.modes.filter((mode): mode is string => typeof mode === 'string')
    : undefined
  const modes: EntryMode[] = (rawModes ?? base?.modes ?? ['one-shot'])
    .filter((mode): mode is EntryMode => mode === 'one-shot' || mode === 'continuable')
  const provider: SubagentProviderName = args.provider === 'fork' || args.provider === 'spawn'
    ? args.provider
    : (base?.provider ?? 'spawn')
  const modelProvider = typeof args.modelProvider === 'string' && args.modelProvider.trim() !== ''
    ? args.modelProvider.trim()
    : undefined
  const modelId = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined
  const draft = normalizeEntry({
    id,
    kind: 'subagent',
    source: 'model',
    managed: base?.managed ?? true,
    defaultEnabled: typeof args.defaultEnabled === 'boolean' ? args.defaultEnabled : (base?.defaultEnabled ?? false),
    name: typeof args.name === 'string' ? args.name : (base?.name ?? ''),
    description: typeof args.description === 'string' ? args.description : (base?.description ?? ''),
    whenPrompt: typeof args.whenPrompt === 'string' ? args.whenPrompt : (base?.whenPrompt ?? ''),
    identityPrompt: typeof args.identityPrompt === 'string' ? args.identityPrompt : base?.identityPrompt,
    modes,
    provider,
    permission: args.permission === 'readonly' || args.permission === 'full'
      ? args.permission
      : (base?.permission ?? 'full'),
    ...(Array.isArray(args.readOnlyAllow)
      ? { readOnlyAllow: args.readOnlyAllow.filter((name): name is string => typeof name === 'string') }
      : base?.readOnlyAllow !== undefined ? { readOnlyAllow: base.readOnlyAllow } : {}),
    ...(modelProvider !== undefined && modelId !== undefined ? { model: { provider: modelProvider, model: modelId } } : {}),
  })
  if (draft === undefined) return '条目结构不合法：id 或名称缺失/形状错误'
  return draft
}

/** 统一的失败文案：把原因与文档位置一起交给模型。 */
function failureText(errors: readonly string[], docHint: string): string {
  return ['操作被拒绝：', ...errors.map(error => `- ${error}`), '', `字段与写法规范见 ${docHint}`].join('\n')
}

/** 构造三个自助管理工具的定义。 */
export function authoringTools(deps: AuthoringDeps): ToolDefinitionLike[] {
  /** 创建/修改成功后的落地说明：是否已在本会话启用，以及下一次可用时机。 */
  const describeOutcome = (
    entry: ObAgentEntry,
    section: ObAgentSection,
    args: Record<string, unknown>,
    sessionId: string | undefined,
    selectedNow: boolean,
  ): string => {
    const toolNames = entry.modes.map(mode => subagentToolName(entry.id, mode))
    const lines = [
      `已保存 Agent 条目 ${entry.id}（${entry.name}）。`,
      `它将提供的工具：${toolNames.map(name => `\`${name}\``).join('、')}。`,
    ]
    const selection: ObAgentSessionState | undefined = sessionId === undefined ? undefined : section.sessions[sessionId]
    const enabledNow = selection?.enabled ?? section.masterEnabledDefault
    if (args.enableNow === false) {
      lines.push('未在本会话启用（enableNow=false）：请让用户在聊天框的「子代理」面板勾选它。')
    } else if (!enabledNow) {
      lines.push('本会话的「子代理」总开关当前是关闭的：该条目已加入本会话勾选，但需要用户打开总开关后工具才可用。')
    } else if (selectedNow) {
      lines.push('已加入本会话勾选：新工具将在「下一轮请求」才出现在你的工具清单里，本轮不要调用它。')
    } else {
      lines.push('新工具将在「下一轮请求」才出现在你的工具清单里，本轮不要调用它。')
    }
    if (entry.permission === 'readonly') {
      lines.push(`只读权限生效时该子代理只能使用这些工具：${(entry.readOnlyAllow ?? section.readOnlyTools).join('、')}。`)
    }
    return lines.join('\n')
  }

  const create: ToolDefinitionLike = {
    name: 'agent_create',
    description:
      '新建一个可复用的 Agent 条目（子代理预设）并持久化。适用于会反复出现、值得固化成固定身份/权限/模型的委派任务；'
      + '一次性小任务不要建条目。创建成功后该子代理工具在「下一轮请求」才可用。',
    parameters: CREATE_PARAMETERS,
    isConcurrencySafe: () => false,
    output: OUTPUT,
    async execute(args, exec): Promise<unknown> {
      const section = deps.read()
      const doc = deps.docHint()
      if (!section.authoring.enabled) {
        return failureText(['模型自助管理已被用户关闭（设置 → 子代理 → 自助管理）'], doc)
      }
      if (section.entries.length >= section.authoring.maxEntries) {
        return failureText([`条目总数已达上限 ${section.authoring.maxEntries}；请先让用户删除不用的条目`], doc)
      }
      const draft = entryFromArgs(args)
      if (typeof draft === 'string') return failureText([draft], doc)
      const errors = validateEntry(draft, section, { takenIds: section.entries.map(entry => entry.id) })
      if (errors.length > 0) return failureText(errors, doc)
      const sessionId = deps.sessionIdOf((exec as AuthoringExec).agent)
      const patch = args.enableNow === false ? undefined : selectionPatch(section, sessionId, draft.id)
      await writeEntries(deps.scope, [...section.entries, draft], patch === undefined ? undefined : { sessions: patch.sessions })
      deps.audit(`模型创建了 Agent 条目 ${draft.id}（${draft.name}）`)
      return describeOutcome(draft, section, args, sessionId, patch !== undefined)
    },
  }

  const update: ToolDefinitionLike = {
    name: 'agent_update',
    description:
      '修改一个已有的 Agent 条目，只需给出要改的字段。默认只能修改模型自己创建的条目（来源为模型）；'
      + '修改内置或用户创建的条目会被拒绝。',
    parameters: UPDATE_PARAMETERS,
    isConcurrencySafe: () => false,
    output: OUTPUT,
    async execute(args, exec): Promise<unknown> {
      const section = deps.read()
      const doc = deps.docHint()
      if (!section.authoring.enabled) {
        return failureText(['模型自助管理已被用户关闭（设置 → 子代理 → 自助管理）'], doc)
      }
      const id = typeof args.id === 'string' ? args.id : ''
      const base = section.entries.find(entry => entry.id === id)
      if (base === undefined) {
        return failureText([`没有这个条目：${id}（先用 agent_list 查看现有条目标识）`], doc)
      }
      if (base.kind === 'native') {
        return failureText([`${id} 是 DSH 原生工具条目，不能按子代理字段修改`], doc)
      }
      if (section.authoring.scope === 'own' && base.source !== 'model') {
        const origin = base.source === 'builtin' ? '内置' : '用户创建'
        return failureText([`${id} 不是模型创建的条目（来源：${origin}），当前作用域只允许修改模型自建条目`], doc)
      }
      const draft = entryFromArgs(args, base)
      if (typeof draft === 'string') return failureText([draft], doc)
      const errors = validateEntry(draft, section, {
        takenIds: section.entries.filter(entry => entry.id !== id).map(entry => entry.id),
      })
      if (errors.length > 0) return failureText(errors, doc)
      await writeEntries(deps.scope, section.entries.map(entry => (entry.id === id ? draft : entry)))
      deps.audit(`模型修改了 Agent 条目 ${id}（${draft.name}）`)
      return describeOutcome(draft, section, args, deps.sessionIdOf((exec as AuthoringExec).agent), false)
    },
  }

  const list: ToolDefinitionLike = {
    name: 'agent_list',
    description:
      '列出当前全部 Agent 条目（含未勾选与模型自建项）：标识、名称、类型、来源、本会话是否启用、以及会暴露的工具名。'
      + '新建条目之前先用它查重。',
    parameters: {},
    isConcurrencySafe: () => true,
    output: OUTPUT,
    execute(_args, exec): Promise<unknown> {
      const section = deps.read()
      const sessionId = deps.sessionIdOf((exec as AuthoringExec).agent)
      const selection: ObAgentSessionState | undefined = sessionId === undefined ? undefined : section.sessions[sessionId]
      const lines = ['当前 Agent 条目：']
      for (const entry of section.entries) {
        const names = entry.kind === 'native'
          ? (entry.toolNames ?? []).join('、')
          : entry.modes.map(mode => subagentToolName(entry.id, mode)).join('、')
        const origin = entry.source === 'model' ? '模型自建' : entry.source === 'builtin' ? '内置' : '用户创建'
        const managed = entry.managed ? '' : '（未纳管）'
        const chosen = selection === undefined
          ? (entry.defaultEnabled ? '本会话按默认启用' : '本会话未启用')
          : (selection.selected.includes(entry.id) ? '本会话已启用' : '本会话未启用')
        lines.push(
          `- ${entry.id}｜${entry.name}｜${entry.kind === 'native' ? '原生工具' : '子代理'}｜${origin}${managed}`
          + `｜${chosen}｜工具：${names || '（无）'}`,
        )
      }
      lines.push(`总开关默认：${section.masterEnabledDefault ? '开' : '关'}；条目上限：${section.authoring.maxEntries} 条。`)
      if (!section.authoring.enabled) lines.push('注意：模型自助管理当前已被用户关闭，你不能创建或修改条目。')
      return Promise.resolve(lines.join('\n'))
    },
  }

  return [create, update, list]
}
