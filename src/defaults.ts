/**
 * 出厂默认值：设置段默认值、闸门基线名单、8 条内置 Agent 条目，以及模型面文案模板。
 *
 * 这里只放数据（中文文案属于数据，不是代码标识符）。清单本身可被设置在 `gate` 段里
 * 覆盖，因此新增/移除 DSH 原生工具不需要改代码。
 */
import {
  DEFAULT_PROMPT_VARIABLES,
  DEFAULT_READ_ONLY_TOOLS,
  type ObAgentEntry,
  type ObAgentSection,
} from './contract.ts'

/** 闸门基线：DSH 全部 agent 类工具（委派 / 续话 / 编排 / 自助管理）。 */
export const DEFAULT_GATE = {
  enabled: true,
  prefixes: ['^subagent'] as const,
  tools: [
    'send_message',
    'interrupt_agent',
    'list_agents',
    'workflow',
    'ralph',
    'agent_create',
    'agent_update',
    'agent_list',
  ] as const,
  allow: [] as const,
  reprovide: ['send_message', 'interrupt_agent', 'list_agents'] as const,
}

/** 模型自助管理：默认开启但受限（只能改自建条目，且有总量上限）。 */
export const DEFAULT_AUTHORING = {
  enabled: true,
  scope: 'own' as const,
  maxEntries: 24,
}

/** 面向模型的文档默认只注入路径（省 token、缓存友好）。 */
export const DEFAULT_MODEL_GUIDE = { inject: 'path' as const }

/**
 * 出厂默认版本号。历史设置段（落盘时的版本低于此值）由 `normalize.ts` 的迁移改写：
 * 用新的内置条目替换旧的同名内置条目、删掉已下线内置条目、重定向改名的标识，
 * 并把会话选择里失效的 id 清掉。缺省（未写过）视为 0。
 */
export const DEFAULTS_REVISION = 4

/** 历史内置标识重定向（迁移用）：改名不能让旧会话里已有的勾选凭空消失。 */
export const RENAMED_BUILTINS: Readonly<Record<string, string>> = { code_audit: 'code_review' }

/**
 * 内置「代码审查」条目：唯一内置审查角色，沿用原审计模型
 * （钉死 `opencode-go/hy4-preview`）。保留文件改动即触发初次审查，同时限制复审成本。
 */
const CODE_REVIEW: ObAgentEntry = {
  id: 'code_review',
  kind: 'subagent',
  source: 'builtin',
  managed: true,
  defaultEnabled: false,
  name: '代码审查',
  description: '文件改动后触发独立审查，优先报告有证据的重要问题',
  whenPrompt:
    '用户明确要求审查时立即调用；否则主模型每次实际修改文件后都立即调用代码审查（包括代码、配置和文档），不要推迟到任务结束。'
    + '一次工具调用同时修改多个文件时只审查一次；后续独立的文件修改仍需再次触发，不要推迟到整个任务结束。纯问答和只读探索不调用；首次审查后因其建议产生的低风险文字小修按下述例外处理。'
    + '审查结果是建议而不是命令：先核实证据、影响和修复收益，误报、低风险或修改成本高于收益的建议可以不采纳并说明理由。'
    + '如果后续修改只是落实本次审查已经提出的建议，默认不再次调用；特别是提示文案、注释、格式、测试断言或其它无行为变化的小修，禁止复审。'
    + '只有后续修复引入新的、现有测试无法覆盖的安全/数据/兼容性高风险行为，才允许针对新风险额外聚焦审查一次；新的独立文件改动仍按上述规则触发，同一问题最多复审一次，禁止形成循环。',
  identityPrompt: [
    '你是独立代码审查员。只审查委派范围内的本次文件改动，输出简短、可核对的结论；不修改代码。',
    '你看不到父会话对话；以委派说明和可见 diff 为主，先看变更文件及必要上下文，不做无关的全仓扫描。',
    '优先识别有现实影响且高置信的正确性、安全、数据完整性、兼容性与失败路径问题；不为凑数报告风格、措辞、提示文案或无证据的猜测。',
    '只报告值得修复的问题；每条给出文件:行号或最短证据、触发条件、影响、最小修复方向和严重级别。没有值得修复的问题就直接说没有。',
    '明确区分已确认问题与待验证疑点；疑点必须给出低成本验证方式，不要把疑点写成必须修改的结论。',
    '控制成本：优先使用已有检查结果，不重复运行昂贵测试；只有验证具体高风险问题确有必要时才执行最小命令。',
    '不要要求为了同一问题反复审查；修复建议必须权衡收益与改动成本，信息不足时如实说明，不臆造问题。',
  ].join('\n'),
  modes: ['one-shot'],
  provider: 'spawn',
  model: { provider: 'opencode-go', model: 'hy4-preview' },
  permission: 'full',
}

/** 内置「通用子代理」条目：对齐 DSH 原生 `subagent`（spawn + 可继续对话）。 */
const GENERAL: ObAgentEntry = {
  id: 'general',
  kind: 'subagent',
  source: 'builtin',
  managed: true,
  defaultEnabled: true,
  name: '通用子代理',
  description: '独立上下文的通用委派，可继续对话',
  whenPrompt:
    '当一项子任务需要大量独立探索、会污染主会话上下文，或可以并行推进时使用；'
    + '需要多轮追问时用这个可继续对话的子代理，而不是一次性子代理。',
  identityPrompt: '你是被主会话委派的通用子代理。专注于被交付的这一件事，做完即返回结论。',
  modes: ['continuable'],
  provider: 'spawn',
  permission: 'full',
}

/** 内置「子代理续话与中止」：`send_message` + `interrupt_agent`。 */
const AGENTS_CONTROL: ObAgentEntry = {
  id: 'agents_control',
  kind: 'native',
  source: 'builtin',
  managed: true,
  defaultEnabled: true,
  name: '子代理续话与中止',
  description: '继续对话已有子代理、中止失控的子代理',
  whenPrompt:
    '在可继续对话的子代理已返回持久 id 之后，需要追加提问或改向时调用 send_message；子代理跑偏或长时间无产出时调用 interrupt_agent 中止它。',
  modes: [],
  provider: 'spawn',
  permission: 'full',
  impl: 'control',
  toolNames: ['send_message', 'interrupt_agent'],
}

/** 内置「子代理清单」：`list_agents`。 */
const AGENTS_LIST: ObAgentEntry = {
  id: 'agents_list',
  kind: 'native',
  source: 'builtin',
  managed: true,
  defaultEnabled: true,
  name: '子代理清单',
  description: '列出当前会话的全部子代理及其状态',
  whenPrompt: '在需要确认某个子代理是否还在运行、有哪些子代理可用时调用。',
  modes: [],
  provider: 'spawn',
  permission: 'full',
  impl: 'list-agents',
  toolNames: ['list_agents'],
}

/** 内置「工作流编排」：`workflow`。 */
const WORKFLOW: ObAgentEntry = {
  id: 'workflow',
  kind: 'native',
  source: 'builtin',
  managed: true,
  defaultEnabled: false,
  name: '工作流编排',
  description: '用脚本编排多个子代理（分阶段、扇出）',
  whenPrompt:
    '当任务需要先扇出大量独立子任务、再按阶段汇总（例如批量审查、全仓扫描、多角度调研）时使用 workflow；'
    + '只有一两个独立子任务时直接用子代理，不要上工作流。',
  modes: [],
  provider: 'spawn',
  permission: 'full',
  impl: 'workflow',
  toolNames: ['workflow'],
}

/** 内置「深度迭代」：`ralph`。 */
const RALPH: ObAgentEntry = {
  id: 'ralph',
  kind: 'native',
  source: 'builtin',
  managed: true,
  defaultEnabled: false,
  name: '深度迭代（Ralph）',
  description: '无人值守的多轮自迭代推进',
  whenPrompt:
    '只有用户明确要求「Ralph / 新鲜代理迭代 / 无人值守多轮推进」时才调用，且必须给出可判定的完成标准；不要用它代替普通的多步工作。',
  modes: [],
  provider: 'spawn',
  permission: 'full',
  impl: 'ralph',
  toolNames: ['ralph'],
}

/** 内置「DSH 原生具名子代理」：放行 preset 里已装配的具名委派工具（如 `subagent_hy4`）。 */
const SUBAGENT_NATIVE: ObAgentEntry = {
  id: 'subagent_native',
  kind: 'native',
  source: 'builtin',
  managed: true,
  defaultEnabled: false,
  name: 'DSH 原生具名子代理',
  description: '放行会话预设里已装配的具名委派工具（不重挂）',
  whenPrompt: '当会话预设已经提供了具名子代理工具，且它的默认配置正好满足需要时调用。',
  modes: [],
  provider: 'spawn',
  permission: 'full',
  impl: 'subagent-preset',
  toolNames: ['subagent_hy4'],
}

/** 内置「Agent 自助管理」：本插件实现的三个模型工具。 */
const AGENT_AUTHORING: ObAgentEntry = {
  id: 'agent_authoring',
  kind: 'native',
  source: 'builtin',
  managed: true,
  defaultEnabled: true,
  name: 'Agent 自助管理',
  description: '让模型自己创建 / 修改 / 列出 Agent 条目',
  whenPrompt:
    '当某类子代理任务会反复出现、值得固化成可复用的角色（固定身份、固定权限、固定模型）时，'
    + '先 agent_list 查重，再 agent_create 新建；已有条目需要调整时用 agent_update。一次性小任务不要建条目。',
  modes: [],
  provider: 'spawn',
  permission: 'full',
  impl: 'authoring',
  toolNames: ['agent_create', 'agent_update', 'agent_list'],
}

/**
 * 出厂条目表：3 条插件角色 + 5 条 DSH 原生工具。
 *
 * 顺序即 dock 内的显示顺序（插件角色在前、DSH 原生工具在后并被默认折叠）。
 * DSH 原生条目一律保留：它们受闸门管辖（总开关关闭时同样被拦），只是不在界面上展开。
 */
export const BUILTIN_ENTRIES: readonly ObAgentEntry[] = [
  CODE_REVIEW,
  GENERAL,
  AGENT_AUTHORING,
  AGENTS_CONTROL,
  AGENTS_LIST,
  WORKFLOW,
  RALPH,
  SUBAGENT_NATIVE,
]

/** 出厂设置段（缺省字段与 `replace({})` 的回落目标）。 */
export const DEFAULT_SECTION: ObAgentSection = Object.freeze({
  defaultsRevision: DEFAULTS_REVISION,
  masterEnabledDefault: false,
  readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
  promptVariables: DEFAULT_PROMPT_VARIABLES,
  autoEnableControlWithContinuable: true,
  childReplyToParent: true,
  gate: DEFAULT_GATE,
  authoring: DEFAULT_AUTHORING,
  modelGuide: DEFAULT_MODEL_GUIDE,
  entries: BUILTIN_ENTRIES,
  sessions: {},
})

// ── 模型面文案模板（仅数据；由 plan.ts 组装） ──────────────────────────────

/** 提示段标题行。 */
export const SECTION_HEADER = '本会话已启用以下 Agent 能力，工具名与调用时机如下：'

/** 未启用任何条目时的说明行。 */
export const SECTION_EMPTY = '本会话尚未启用任何 Agent 工具。'

/** 并行调用约定。 */
export const SECTION_PARALLEL = '并行：相互独立的 Agent 任务应在同一条助手回复里同时发起调用。'

/** 可继续对话子代理的续话约定。 */
export const SECTION_CONTINUABLE =
  '可继续对话的子代理会返回持久 id，之后可用 send_message 继续对话；一次性子代理直接返回结果。'

/** 新工具可见性时序说明（模型自建条目后必须知道）。 */
export const SECTION_NEW_TOOL = '新建的 Agent 工具在下一轮请求才会出现在你的工具清单里。'

/** 自助管理的引导行；`{doc}` 由渲染期替换为文档绝对路径或说明。 */
export const SECTION_AUTHORING =
  'Agent 自助管理（`agent_create`、`agent_update`、`agent_list`）：当某类子代理任务会反复出现、值得固化成可复用角色时，'
  + '先 agent_list 查重，再 agent_create 新建；已有条目需要调整时用 agent_update。字段与写法规范见 {doc}。'

/** 只读白名单为空导致某条目不可用时的告警文案。 */
export const UNAVAILABLE_READONLY =
  '只读白名单与当前可见工具没有交集，条目已停用（不会降级为完全权限）'

/** 子代理装配回发工具失败时的原因模板（`{tool}` 替换为工具名）。 */
export const UNAVAILABLE_CHILD_REPLY = '子代理回发工具 {tool} 不可用'

// ── 拦截文案与子代理提示段（仅数据；由 reconcile.ts 与 plan.ts 组装） ────────

/** 主会话里的拦截说明（`{name}` 替换为工具名）。 */
export const DENY_MESSAGE_MAIN =
  '「{name}」在本会话被 dsh-ob-agent 拦截：子代理总开关未开启，或该能力未被勾选。'
  + '请在聊天框的「子代理」面板打开总开关并勾选对应条目后重试。'

/**
 * 子代理内部的拦截说明（`{name}` 替换为工具名）。
 *
 * 必须与主会话文案区分：子代理本来就只开放「回发给直接父代理」这一个 Agent 工具，
 * 让模型去勾选子代理条目是无效建议。
 */
export const DENY_MESSAGE_CHILD =
  '「{name}」在子代理内部不可用：dsh-ob-agent 只对可继续对话的子代理开放 send_message（回发给直接父代理），'
  + '不开放委派、续话与编排工具。需要子代理具备该能力时，请由主会话完成对应操作。'

/**
 * 子代理回发说明（`{parent}` 替换为直接父代理的会话 id）。
 *
 * 措辞刻意与上游的「可继续对话子代理」指引兼容：上游在子代理工具面能解析到带相邻标记的
 * `send_message` 时，也会在初始任务里追加一段「结束时把结果发给父代理」的指引。这里只补充
 * 通道与用法事实，不规定「结论必须写在哪里」，否则两份指引会互相打架。
 */
export const SECTION_CHILD_REPLY =
  '你是可继续对话的子代理，可以用 send_message 向直接父代理回发消息：agent_id 填 `{parent}`，'
  + '内容要自包含（父代理看不到你的对话、工具输出与推理）。需要父代理据此调整下一步、'
  + '或你有中途结论要补充时随时回发；回发消息不会结束你的回合。'

// ── `list_agents` 结果改写（仅数据；由 reconcile.ts 组装） ──────────────────

/**
 * 上游 `list_agents` 空实例清单的原文。
 *
 * 上游把它渲染成这一行（见 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 的
 * renderer）。这里按字面量匹配以便替换成不会引起误读的文案；上游若改动该字面量，
 * 替换会静默失效（结果里保留原文），不影响工具可用性。
 */
export const NATIVE_LIST_EMPTY = '(no subagents)'

/** 空实例清单的替代文案：避免「没有实例」被读成「没有子代理可用」。 */
export const LIST_AGENTS_EMPTY =
  '（当前没有正在运行或可继续对话的子代理实例。一次性子代理返回结果后即结束，'
  + '不会保留在实例清单里；「没有实例」不等于没有可用的子代理。）'

/** 追加到 `list_agents` 描述末尾的说明，纠正「只按实例清单回答」的默认理解。 */
export const LIST_AGENTS_NOTE =
  '本插件还会在结果开头给出本会话已启用的子代理工具清单（工具名、模式、权限、上下文、模型）：'
  + '回答「当前会话有几个子代理」时必须同时考虑这份能力清单，不要只依据实例清单。'

/** 能力清单的首行（后接数量）。 */
export const ROSTER_HEADER = '本会话已启用的子代理工具：'

/**
 * 能力清单为空：闸门未纳管。
 *
 * 注意这与「总开关关闭」是两回事：`gate.enabled === false` 是逃生舱，插件停止管理，
 * 全部 agent 工具都按 DSH 原样可用——文案必须说「未纳管、全部可用」，不能说「没有可用的」。
 */
export const ROSTER_NONE_UNMANAGED =
  '（本插件未纳管 Agent 工具：DSH 原生的子代理工具全部可直接使用，不受本面板约束）'

/** 能力清单为空：已纳管但本会话的总开关关着。 */
export const ROSTER_NONE_MASTER_OFF =
  '（本会话的「子代理」总开关是关闭状态，因此没有任何子代理可用；需要时请在聊天框面板打开总开关并勾选条目）'

/** 能力清单为空：纳管且总开关开着，但一条都没勾选。 */
export const ROSTER_NONE_UNSELECTED = '（总开关已开启，但没有勾选任何子代理条目）'

/** 原生 Agent 工具清单的首行。 */
export const ROSTER_NATIVE = '本会话另已放行的原生 Agent 工具：'

/** 实例清单的引导行，紧接在上游输出之前。 */
export const ROSTER_INSTANCES = '以下是子代理实例清单（只有「可继续对话」的实例会保留）：'
