/**
 * 纯函数层：会话选择 → 已启用条目 → 闸门拒绝集与系统提示段文本。
 *
 * 这个模块不接触任何服务，因此可以被单元测试完整覆盖；协调器只负责把结果落到
 * 工具登记表与提示注册表上。
 */
import {
  subagentToolName,
  type EntryMode,
  type ObAgentEntry,
  type ObAgentSection,
  type ObAgentSessionState,
} from './contract.ts'
import {
  ROSTER_HEADER,
  ROSTER_INSTANCES,
  ROSTER_NATIVE,
  ROSTER_NONE_MASTER_OFF,
  ROSTER_NONE_UNMANAGED,
  ROSTER_NONE_UNSELECTED,
  SECTION_AUTHORING,
  SECTION_CONTINUABLE,
  SECTION_EMPTY,
  SECTION_HEADER,
  SECTION_NEW_TOOL,
  SECTION_PARALLEL,
} from './defaults.ts'

/** 一条已启用条目及其本次派生的工具名。 */
export interface ActiveEntry {
  readonly entry: ObAgentEntry
  /** 本次应当提供的工具名（子代理按模式派生，原生条目用声明名）。 */
  readonly toolNames: readonly string[]
  /** 子代理条目本次启用的模式（原生条目为空）。 */
  readonly modes: readonly EntryMode[]
}

/** 一条条目在两种模式下可能派生的全部工具名（含未启用模式）。 */
export function allToolNamesOf(entry: ObAgentEntry): string[] {
  if (entry.kind === 'native') return [...(entry.toolNames ?? [])]
  return entry.modes.map(mode => subagentToolName(entry.id, mode))
}

function activeOf(entry: ObAgentEntry): ActiveEntry {
  return { entry, toolNames: allToolNamesOf(entry), modes: entry.kind === 'native' ? [] : entry.modes }
}

/** 某会话的有效选择：没有记录时回落到出厂默认（总开关 + 默认启用条目）。 */
export function effectiveSelection(section: ObAgentSection, sessionId: string): ObAgentSessionState {
  const managed = section.entries.filter(entry => entry.managed)
  const stored = section.sessions[sessionId]
  if (stored !== undefined) {
    const ids = new Set(managed.map(entry => entry.id))
    return { enabled: stored.enabled, selected: stored.selected.filter(id => ids.has(id)) }
  }
  return {
    enabled: section.masterEnabledDefault,
    selected: managed.filter(entry => entry.defaultEnabled).map(entry => entry.id),
  }
}

/**
 * 计算某会话本次应当装配的条目。
 *
 * - `gate.enabled === false`（逃生舱）：不做任何管理，返回空表。
 * - 总开关关闭：返回空表（闸门随后拦截全部 agent 类工具）。
 * - 勾选了含「可继续对话」的子代理且开启自动放行：把续话/中止条目一并启用
 *   （否则可继续对话的子代理无法续话）。
 */
export function resolveActive(section: ObAgentSection, sessionId: string): ActiveEntry[] {
  if (!section.gate.enabled) return []
  const selection = effectiveSelection(section, sessionId)
  if (!selection.enabled) return []
  const byId = new Map(section.entries.filter(entry => entry.managed).map(entry => [entry.id, entry]))
  const active: ActiveEntry[] = []
  for (const id of selection.selected) {
    const entry = byId.get(id)
    if (entry === undefined) continue
    active.push(activeOf(entry))
  }
  if (section.autoEnableControlWithContinuable && active.some(item => item.modes.includes('continuable'))) {
    const control = section.entries.find(entry => entry.managed && entry.impl === 'control')
    if (control !== undefined && !active.some(item => item.entry.id === control.id)) {
      active.push(activeOf(control))
    }
  }
  return active
}

/** 闸门匹配器：按配置的前缀/精确名拦截，豁免名单与未纳管条目的工具名优先。 */
export interface GateMatcher {
  /** 该工具名是否落在拦截范围内。 */
  denies(name: string): boolean
  /** 生效的前缀正则（诊断用）。 */
  readonly patterns: readonly string[]
}

/** 由设置段构造闸门匹配器；非法正则被忽略（不影响其它规则）。 */
export function createGateMatcher(section: ObAgentSection): GateMatcher {
  const allowed = new Set(section.gate.allow)
  for (const entry of section.entries) {
    if (entry.managed) continue
    for (const name of allToolNamesOf(entry)) allowed.add(name)
  }
  const exact = new Set(section.gate.tools)
  const compiled: { source: string; regex: RegExp }[] = []
  for (const pattern of section.gate.prefixes) {
    try {
      compiled.push({ source: pattern, regex: new RegExp(pattern) })
    } catch {
      // 非法正则：忽略该条规则，其它规则继续生效。
    }
  }
  return {
    patterns: compiled.map(item => item.source),
    denies(name: string): boolean {
      if (allowed.has(name)) return false
      if (exact.has(name)) return true
      return compiled.some(item => item.regex.test(name))
    },
  }
}

function modeLabel(modes: readonly EntryMode[]): string {
  if (modes.length === 0) return '原生工具'
  if (modes.length === 1) return modes[0] === 'continuable' ? '可继续对话' : '一次性'
  return '一次性或可继续对话'
}

/** 一条已启用条目的单行描述（子代理条目含模式、权限、上下文与模型）。 */
export function describeActiveEntry(item: ActiveEntry): string {
  const names = item.toolNames.map(name => `\`${name}\``).join('、')
  if (item.entry.kind === 'native') {
    return `- ${item.entry.name}（${names}）：${item.entry.whenPrompt}`
  }
  const permission = item.entry.permission === 'readonly' ? '只读' : '完全权限'
  const context = item.entry.provider === 'fork' ? '继承本会话已完成轮次' : '全新上下文'
  return `- ${item.entry.name}（${names}，${modeLabel(item.modes)}，${permission}，${context}）：${item.entry.whenPrompt}`
}

/**
 * 渲染「本会话可用的子代理工具」清单。
 *
 * 存在的理由：原生 `list_agents` 只列**可继续对话的实例**（一次性子代理被上游过滤），
 * 新会话更是一个实例都没有，于是「当前会话有几个子代理」会被答成 0 —— 明明已经勾选了
 * 子代理条目。这份清单回答的是「有哪些子代理可用」，与实例清单互补。
 * @param section - 当前设置段。
 * @param sessionId - 会话 id（读取该会话的勾选）。
 * @returns 可直接拼进工具结果的多行文本。
 */
export function renderSubagentRoster(section: ObAgentSection, sessionId: string): string {
  const active = section.gate.enabled ? resolveActive(section, sessionId) : []
  const subagents = active.filter(item => item.entry.kind === 'subagent')
  const natives = active.filter(item => item.entry.kind === 'native')
  // 计数按**工具**而非条目：一条双模式条目会派生两个工具名，按条目数会让数字与下面列出的名字对不上。
  const toolCount = subagents.reduce((sum, item) => sum + item.toolNames.length, 0)
  const lines: string[] = [`${ROSTER_HEADER}${toolCount} 个`]
  if (subagents.length === 0) {
    // 三态：未纳管 / 本会话总开关关闭 / 已开启但未勾选。后两者都得到空清单，文案必须区分，
    // 否则模型会把「总开关关着」读成「已开启但没有条目」。
    if (!section.gate.enabled) lines.push(ROSTER_NONE_UNMANAGED)
    else if (!effectiveSelection(section, sessionId).enabled) lines.push(ROSTER_NONE_MASTER_OFF)
    else lines.push(ROSTER_NONE_UNSELECTED)
  } else {
    for (const item of subagents) lines.push(describeActiveEntry(item))
  }
  if (natives.length > 0) {
    const names = natives.flatMap(item => item.toolNames.map(name => `\`${name}\``))
    lines.push(`${ROSTER_NATIVE}${names.join('、')}`)
  }
  lines.push(ROSTER_INSTANCES)
  return lines.join('\n')
}

/**
 * 把**不是**合法允许引用的 `{{` 全部转义掉。
 *
 * `renderPrompt` 的插值器遇到「`{{` 开头但不是合法 `{{名字}}`」会**抛错并打断整个请求**
 * （见 `dsh-system-prompt` 的 `interpolate`：`GROUP_AT` 取到花括号内原文后还要过
 * `VARIABLE_NAME = /^[a-z][a-z0-9_]*$/`）。因此这里按同一套语义逐位扫描：
 * - `{{{cwd}}}`、`{{cwd-extra}}`、`{{ cwd }}`（含空格）、`{{Cwd}}`（大写）、只出现 `{{`
 *   这些都**必须转义**；
 * - 只有**严格等于** `{{小写名字}}` 且该名字被允许的引用才原样保留。
 * 写入口（normalize 的校验）已经拒绝畸形引用与未知变量，这里是渲染期的第二道保险。
 * @param text - 待渲染的提示词文本。
 * @param allowed - 允许的变量名集合。
 * @returns 转义后的文本。
 */
export function sanitizeVariables(text: string, allowed: readonly string[]): string {
  const permitted = new Set(allowed)
  const reference = /^\{\{([a-z][a-z0-9_]*)\}\}/
  let result = ''
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('{{', index)
    if (open === -1) {
      result += text.slice(index)
      break
    }
    result += text.slice(index, open)
    const match = reference.exec(text.slice(open))
    const name = match?.[1]
    if (match !== null && name !== undefined && permitted.has(name)) {
      result += match[0]
      index = open + match[0].length
      continue
    }
    // 不是「合法且允许」的引用：转义这一对花括号，视觉上几乎不变。
    result += '{ {'
    index = open + 2
  }
  return result
}

/** 渲染本会话的「Agent 工具信息」系统提示段；未管理或未启用时返回空串（空段会被丢弃）。 */
export function renderSectionText(section: ObAgentSection, sessionId: string, docHint: string): string {
  if (!section.gate.enabled) return ''
  const active = resolveActive(section, sessionId)
  const lines: string[] = [SECTION_HEADER]
  if (active.length === 0) {
    lines.push(SECTION_EMPTY)
  } else {
    for (const item of active) lines.push(describeActiveEntry(item))
    lines.push(SECTION_PARALLEL)
    if (active.some(item => item.modes.includes('continuable'))) lines.push(SECTION_CONTINUABLE)
    if (active.some(item => item.entry.impl === 'authoring')) {
      lines.push(SECTION_AUTHORING.replace('{doc}', docHint))
      lines.push(SECTION_NEW_TOOL)
    }
  }
  return sanitizeVariables(lines.join('\n'), section.promptVariables)
}
