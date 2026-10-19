# 当前 DSH 子代理模型与官方用法对齐审查

日期：2026-10-19（UTC+8）

审查对象：当前 web profile、dsh-ob-agent 0.1.9、DSH 0.2.1-rc.2 与其已安装 pi-ai 1.3.0。

性质：只读审查与建议，不是修复完成证明。

## 一、结论先行

**需要对齐，但不需要推倒重做，也不建议把所有模型一律改成一种协议或最高思考档。**

1. **当前三个固定子代理的选型和基本档位合法。** GLM-5.3-Flash/high、Command Code DeepSeek-V4.1-Flash/high、百炼 Qwen3.8-Max/xhigh 均有明确用途；GLM 和 Qwen 的主要厂商参数已由当前适配器处理，不能因为插件界面没列出这些参数，就认为请求没有携带。
2. **最应先修的是插件的角色更新契约。** 自助更新角色的描述时会静默删除固定模型；更新模型时会丢思考档位；更新工具的必填字段又与“只需提供要改的字段”矛盾。这些是已复现问题，而不是模型能力猜测。
3. **主模型的协议值得优先灰度对齐。** 当前 GPT-6.1 Sol 经中转走 Chat Completions；OpenAI 官方明确要求其工具调用使用 Responses。当前能够调用工具，证明中转实现了兼容行为，不证明与原生协议完全等价。建议新增独立 Responses 路由验证，不原地替换全部 GPT 路由。
4. **Command Code 应按网关契约验证，不能照搬 DeepSeek 直连配置。** 当前 high 会发送 reasoning_effort，但不发送 thinking 对象；已有思考字段可按签名回传。是否还需要 DeepSeek 风格开关或空 reasoning_content 兼容项，必须由网关实际请求/响应证据决定。
5. **官方子代理能力有可利用的增量。** 如 maxTokens、受授权的动态模型选择、list_subagent_models、独立 agentPreset，以及继承宿主 maxDepth。应按功能边界引入，不能同时给所有角色开放任意换模型或突破权限。
6. **权限、隐私、并发需要和模型参数一并治理。** 目前代码审查角色虽然写着“不修改代码”，实际 permission=full；这不是强只读。百炼 Token Plan 的交互使用边界和数据使用条款，也直接影响工作流/Ralph/自动化的用法。

### 优先级含义

- **P1：应优先修复/验证**——已确认行为不符合声明，或位于核心协议/安全边界。
- **P2：建议优化**——功能可用，但可观测性、成本、性能、可迁移性或维护性不足。
- **待验：不能凭文档推断已故障**——需要指定端点的最小往返或离线载荷测试。

本报告不把“官方推荐 max”解释为“high 无效”，不把“配置支持 image”解释为已经通过视觉质量验收，不把“请求没报错”解释为全部高级参数生效。

## 二、实际盘点：不是只有一个通用模型

### 2.1 插件角色与当前会话的区别

当前插件共保存 **9 个条目**，其中 **3 个是真正的子代理角色**，另外 6 个是原生控制/编排/管理能力。

| 角色 | 固定 LLM 路由 | 思考档位 | 后端与权限 | 当前判断 |
|---|---|---|---|---|
| 代码审查 | zai / glm-5.3-flash | high | spawn、可续话、full | 档位合法；权限比角色声明宽 |
| 通用子代理 | commandcode / deepseek/deepseek-v4.1-flash | high | spawn、可续话、full | 网关模型 ID 存在；思考协议细节需专门验收 |
| 前端开发 | qwen-token-plan-cn / qwen3.8-max | xhigh | spawn、可续话、full | 档位合法；保留思考、视觉与额度管理重要 |

配置证据：[当前角色配置](<C:/Users/17737/.dsh/profiles/web/cordis.patch.yml#L751-L817>)。

**当前这次会话只启用了通用子代理及续话/列表控制，不是三个角色都在工作。** 本轮两项独立源码调研均由通用子代理执行；其实际会话投影已记录 commandcode / deepseek/deepseek-v4.1-flash / high，说明这一路由确实应用到了运行中的子代理，而不只是磁盘配置。

其余六条是 agent_authoring、agents_control、agents_list、workflow、ralph、subagent_native；不是六个额外 LLM 实例。仅保留原生具名工具名 subagent_hy4，也不代表当前 preset 确实注册了它；当前标准组合本身提供的是 subagent 和 subagent_fork。

主会话默认路由是 openai-codex-custom / gpt-6.1-sol / high。名称中的 codex-custom 只是本地路由标识，**并不表示其协议是原生 Codex/Responses**。

### 2.2 所有可供子代理选择的已声明模型

当前配置合计声明 **7 个 provider 分组、24 个 provider/model 组合**：pi-ai 中 22 个，DeepSeek 原生目录中 2 个。它们是候选路由，不等于当前都被调用过。

| provider | 已声明模型 | 审查重点 |
|---|---|---|
| commandcode | DeepSeek V4.1 Flash、MiniMax M3、MiMo V2.6 Pro UltraSpeed、MiMo V2.6 Flash | 统一网关不等于统一模型参数；应逐模型 compat |
| openai-codex-custom | GPT-5.6 Luna/Sol/Terra、GPT-6 Astra/Sol/Luna、GPT-6.1 Sol | 当前全走 Chat；不同代际不能套同一工具协议/effort 表 |
| sudocode-deepseek | deepseek-v4-1-flash | 与 Command Code 的斜杠模型名不同；已显式使用 deepseek 思考格式 |
| zai | glm-5.3-flash | 当前目录支持思考、图片、工具流和 preserved thinking |
| opencode-go | minimax-m3、qwen3.8-flash、deepseek-v4.1-flash、hy4-preview | 套餐网关契约优先；旧出厂审查路由仍指向 hy4-preview |
| qwen-token-plan-cn | deepseek-v4.1-flash、glm-5.3、kimi-k2.7-code、qwen3.8-flash、qwen3.8-max | 同一端点下不同模型仍有不同思考规则 |
| deepseek-official | deepseek-v4.1-flash、deepseek-v4-pro | 本地目录覆盖了新宿主默认目录，Flash 仍声明纯文本 |

配置入口：[模型与 provider 段](<C:/Users/17737/.dsh/profiles/web/cordis.patch.yml#L286-L578>)。此处只列模型与非秘密元数据，不复制认证字段。

另外检查了本地 PR 审查及两个独立审查 preset：它们本身没有新增固定的子代理模型路由，不能将它们再算成额外模型。独立 preset 与本插件中的“代码审查角色”是不同层级的配置。

## 三、如何理解“与官方对齐”

需要同时核对三层，缺一层都容易误判：

1. **DSH 官方接口**：子代理 activation、agentOptions、模型预检、权限继承、结果通知。
2. **实际网关/套餐官方契约**：端点、模型 ID、鉴权、支持的协议、限流、套餐使用边界。
3. **模型厂商官方契约**：思考开关、合法档位、保留思考、输出长度、视觉输入。

例如：

- DeepSeek 直连推荐的模型 ID 不能直接替换 Command Code 的 deepseek/deepseek-v4.1-flash。
- 阿里云部署的 Kimi/GLM 应优先遵循阿里云该路由说明，不是把月之暗面/智谱直连的所有字段原样加进去。
- 当前 zai 实际目录端点是国际 Z.AI Coding API，不是中国站 bigmodel 的端点。中国站套餐凭据和国际站凭据不能仅靠相同模型名互换。
- 无需为了看起来“原生”而把已正常的 GLM/Qwen Chat Completions 强行切成 Anthropic 或 Responses。

DSH 侧已安装包中，[pi-ai 适配器说明](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-llm-pi-ai/README.zh.md#L97-L125>) 明确：目录提供默认值，自定义路由需要明确描述；models 是替换而不是追加；推理档位由精确模型校验。

## 四、三个固定子代理逐一对齐

### 4.1 GLM-5.3-Flash：现有主干正确，不要重复配置

**已确认的有效元数据：**

- zai 路由使用 https://api.z.ai/api/coding/paas/v4。
- 1,000,000 上下文，131,072 最大输出；支持 text/image。
- 合法档位为 low、high、max；目录将 off 等不支持项标为 null，DSH 会过滤，不应手工把 off 再加回去。
- 当前 high 是合法有效选择，不是拼写错误。
- 当前目录与 pi-ai 会发送 thinking.type=enabled、thinking.clear_thinking=false、reasoning_effort=high，并在有工具时启用 tool_stream。

官方：[GLM-5.3-Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash)、[Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode)。底层实现：[思考参数分支](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js#L623-L640>)、[工具流开关](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js#L602-L606>)。

**建议：**

1. 保留 high 作为日常审查默认；复杂安全、并发、数据完整性问题可以做 high/max 的对照评测，不能保证 max 必然更准确。
2. 不通过“关闭思考”提速；该模型官方不允许 disabled。轻任务若要提速，选 low。
3. 保留原样 reasoning_content；不能把思考改写成可见正文，也不要只补一个空字段就宣称完成了 preserved thinking。
4. 官方推荐 temperature=1、top_p=0.95，但当前 OB 插件不管理这两个字段；不建议为追求“严格审查”擅自统一改成 temperature=0。是否显式固定应在 provider 层按实际默认值和官方约束决定。
5. 图片能力已存在；审查视觉回归时仍应实际读取渲染截图。模型支持图像，不等于它自动看到了浏览器页面。
6. 若希望换中国站 Coding Plan，另建匹配的 provider 与凭据引用，再做验收；不要原地改 endpoint 后继续用不匹配凭据。

**真正需要改善的是审查权限与触发方式，见第六节，而非补一堆已有的 thinking 字段。**

### 4.2 Command Code / DeepSeek-V4.1-Flash：重点是网关语义

**已经确认：**

- 当前 baseURL 为 https://api.commandcode.ai/provider/v1，与网关官方一致。
- 公开 GET /provider/v1/models 确实列出了 deepseek/deepseek-v4.1-flash，context_length=1,000,000，并支持 /chat/completions、/responses。
- 当前 text/image 与网关模型介绍相符；没有因此证明视觉质量已验收。
- 当前 low/high/max 声明与 DeepSeek 官方该代模型的档位集合一致。
- 当前请求思考格式设为 openai，因此 high 发送 reasoning_effort=high，**不会额外发送 thinking 对象**。
- pi-ai 在收到 reasoning_content/reasoning 等字段后会保存签名，后续工具轮按相应字段回传。不是“没有 requiresReasoningContent 开关就完全不回传”。

官方：[Command Code Provider API](https://docs.commandcode.ai/provider-api)、[公开模型目录](https://api.commandcode.ai/provider/v1/models)、[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)。

**需要验证而不是立即改写的部分：**

1. reasoning_effort=high 是否按该网关预期产生思考；不能只看配置已保存。
2. 连续工具调用、下一用户轮、恢复会话后，reasoning_content 或网关等价字段是否完整保留。
3. 对没有思考字段的历史 assistant，网关是否强制要求空 reasoning_content。
4. 65,536 的本地输出设置是部署限制还是网关上限。不能把 DeepSeek 官方直连的 384K 最大输出直接灌给网关。

**具体做法：**

- 第一阶段：离线截获四类载荷：初始请求、工具结果续接、下一用户轮、会话恢复。确认 reasoning_effort、工具 call_id、思考字段和输出上限。
- 第二阶段：用无敏感内容的短任务做实际最小往返；记录是否存在 reasoning 块及提供方上报的推理用量。若提供方未报告 reasoningTokens，不能把“字段缺失”当“模型没思考”。
- 只有网关证据证明需要 thinking.type 时，才把 **该 DeepSeek 模型** 的 thinkingFormat 改为 deepseek；不要路由级修改，误伤 MiniMax 与 MiMo。
- requiresReasoningContentOnAssistantMessages=true 的作用只是对缺字段历史补空字符串，不会恢复丢失的思考。只有网关要求这种兼容形态才加，不能拿它替代真实回放修复。
- 可新建独立 Responses 候选路由做 A/B，但当前 Chat 路径并非已证实错误。原路由保留回退。

**隐私增强（可选）：**网关官方支持 headers 中 x-cmd-zdr: "1"。这样只走支持零保留的上游；无可用上游会返回 422，而不是静默降级。启用前要接受可用性和价格可能变化，不宣称它能阻止本地 DSH 日志留存。

### 4.3 百炼 Qwen3.8-Max：xhigh 合法，不要再叠 thinking_budget

有效端点是 https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1；当前目录明确支持图像和思考。

官方直接支持的主要档位为 low、medium、xhigh。当前 xhigh 合法，适配器使用 qwen 思考格式，发送 enable_thinking=true 和 reasoning_effort=xhigh。

官方文档还明确：

- reasoning_effort 与 thinking_budget 不得同时设置。
- preserve_thinking 对 Qwen3.8-Max 在官方服务端默认开启；历史 reasoning_content 应完整原样回传，不得拼入 content。当前 pi-ai 的 qwen 格式没有显式发送 preserve_thinking，这与服务端默认开启并不矛盾。不要为补这个字段改成 qwen-chat-template，那是另一种载荷形态。
- 档位与预算有映射，不应把 xhigh 理解为固定实际输出量，也不能把 262,144 最大思维链长度与 131,072 最大回答/输出字段混为一谈。
- 在当前 Chat 文档中，max_completion_tokens 用于思考加回答的总长度；max_tokens 的含义随模型而异，对 Qwen 多为回答部分。不能给所有阿里云模型套相同解释。

官方：[Chat API 参数](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)、[Qwen3.8-Max 模型信息](https://help.aliyun.com/en/model-studio/qwen3-8-max)。

**建议：**

1. 保留 xhigh 作为复杂前端任务的选择；简单样式微调可以做 medium/xhigh A/B，再决定是否拆成两个角色。不要未经评测就永久降档。
2. 不要为了控成本同时加 thinkingBudgets.thinking_budget 与 effort；若采用预算模式，应确保最终载荷只有一种控制路径，并确认宿主支持。
3. 沿用当前目录的精确 effort 列表，不手工补 high。官方兼容映射 high→xhigh 不等于 DSH 目录必须提供 high 这个选项。
4. 续接同一前端任务优先 send_message 原子代理；不要每次重新开 spawn，丢掉工程上下文和既有思考。
5. 委派必须携带本轮需求、技术栈、风格约束、接口、禁止修改范围与验收标准。spawn 不会看到父会话当前截图或长对话，必须明确传递附件/可访问证据。
6. 视觉验收用真实截图、响应式尺寸、浏览器交互结果；如果只有文字或构建结果，必须标明未做视觉/交互验收。
7. qwen3.8-max-0902 已有官方快照说明，但**不能据此认定当前 Token Plan 一定支持该 ID**。普通按量 API 可用不代表套餐可用；先检查该套餐模型列表再考虑固定快照。

## 五、主模型与其余候选模型

### 5.1 GPT-6.1 Sol：当前协议依赖中转兼容，应灰度 Responses

OpenAI 官方当前模型卡明确：

- 输入 text/image，上下文 1,050,000，最大输出 128,000。
- effort 支持 low、medium、high、xhigh、max；不支持 none/minimal。
- **工具调用使用 Responses；Chat Completions 支持无工具场景。**

当前自定义 provider 则为 openai-completions；模型表还提供 minimal→low 映射，并未显式配置 GPT-6.1 Sol 的输出值。这里应区分：

- minimal 映射成 wire low 不会直接发送非法 minimal，但界面语义不真实；建议直接显示 low，不再提供混淆档位。
- 本地声明 1,000,000 比官方 1,050,000 保守，不属于越界问题；不能仅为“对齐数字”盲目抬高网关容量。
- 自定义路由的 GPT-6.1 Sol 未显式设置 maxTokens，且不是已安装目录中同 provider/id 的模型，因此会落到 **32,768**；这个回退值可能实际成为请求输出上限，不仅是界面元数据。应在候选路由中明确网关支持值与部署预算，而不是误以为已经使用官方 128,000 上限。

**建议方案：**

1. 保留当前路由，新增如 sudocode-responses 的独立路由，api=openai-responses，先只放 GPT-6.1 Sol（必要时 Astra 单独验证）。
2. baseURL 与凭据引用继续按中转服务自己的文档配置；本轮没有找到足够的该中转公开协议细则，不能保证 /responses 已实现或完全透传。
3. 声明经过网关确认的 contextWindow/maxTokens/input/efforts。不要凭名称把服务改成 openai-codex-responses，那是另一个认证与协议通道。
4. 验收 function tool、连续工具、并行工具、多图工具结果、截断、取消、恢复与用量后，再切默认主模型。
5. 若中转不支持 Responses，要保留兼容层说明或换支持的服务，不能对用户宣传“已等同官方原生能力”。

参考：[OpenAI GPT-6.1 Sol](https://platform.openai.com/docs/models/gpt-6.1-sol)、[GPT 系列迁移指引](https://platform.openai.com/docs/guides/latest-model)。

对另外六个 GPT 候选，也分别核对了官方模型卡：

| 模型 | 官方 effort 集合 | 官方容量 | 当前部署与对齐方向 |
|---|---|---|---|
| GPT-5.6 Luna | none/low/medium/high/xhigh/max | 1,050,000 上下文，128,000 输出 | 本地 272,000 窗口是保守限制，不是官方最大窗口；minimal→low 是自有别名，当前没有提供 none |
| GPT-5.6 Sol | none/low/medium/high/xhigh/max | 同上 | 本地窗口 1,000,000；输出未显式写明，会落到自定义路由回退，应明确部署预算 |
| GPT-5.6 Terra | none/low/medium/high/xhigh/max | 同上 | 本地 272,000 窗口同样保守；如需扩大，先确认中转上限，不直接抬高 |
| GPT-6 Astra | low/medium/high/xhigh/max | 同上 | 与 GPT-6.1 Sol 一样，推理工具链优先 Responses；不能补 none/minimal 原生档 |
| GPT-6 Sol | none/low/medium/high/xhigh/max | 同上 | 官方 Chat 仅在 reasoning_effort=none 时支持 function calling；当前 high 等带工具要依赖中转转换或改用 Responses |
| GPT-6 Luna | none/low/medium/high/xhigh/max | 同上 | 同 GPT-6 Sol；当前声明中没有 none，因此不能靠现有选项切出官方 Chat 非思考工具模式 |

参考：[5.6 Luna](https://platform.openai.com/docs/models/gpt-5.6-luna.md)、[5.6 Sol](https://platform.openai.com/docs/models/gpt-5.6-sol.md)、[5.6 Terra](https://platform.openai.com/docs/models/gpt-5.6-terra.md)、[6 Astra](https://platform.openai.com/docs/models/gpt-6-astra.md)、[6 Sol](https://platform.openai.com/docs/models/gpt-6-sol.md)、[6 Luna](https://platform.openai.com/docs/models/gpt-6-luna.md)。

因此不是“所有 GPT 都一个 Chat 配置就行”。建议先灰度当前主力 6.1 Sol，其他模型按实际使用逐个迁移或保留兼容说明；本轮没有完成这些中转路由的真实往返验收。

### 5.2 其他候选模型应逐模型设置，不要共用推理假设

| 候选 | 当前需要注意 | 建议动作 |
|---|---|---|
| Command Code MiniMax M3 | 本地声明 low/medium/high，但 MiniMax 原厂当前把可调 reasoning_effort 明确用于 M3.1 Flash Preview；不能把 M3.1 规则当 M3 | 向网关核实是否提供自有 effort 转换；没有证据前不把此映射称为原厂能力 |
| Command Code MiMo V2.6 Flash/Pro UltraSpeed | 本地 reasoningEfforts=false，只表示 DSH 不提供推理档位，不证明模型无思考；原厂支持 thinking 开关并推荐保留 reasoning_content | 需要可控思考时按网关能力单独建兼容配置，不能简单把 false 改 true 就认为已经启用 |
| Token Plan Kimi K2.7 Code | 目录未声明 thinkingLevelMap 且 supportsReasoningEffort=false，可能展示通用 low/medium/high，但不会发同名 reasoning_effort；只有 qwen 格式的思考开关 | 不把这些选项宣传为真实深度等级；原厂始终思考，阿里云部署以其契约为准；测试续接，不随意发送禁思/温度 |
| Token Plan GLM-5.3 | 与 zai 的 GLM-5.3-Flash 不同型号/部署；当前目录仅 text，low/high/max | 保持精确型号能力，不因 Flash 支持图片就给该模型加 image；不复制国际 Coding API 全套字段 |
| opencode-go MiniMax M3 / Qwen3.8-Flash | 当前目录分别使用 anthropic-messages，而不是本地其他 provider 的 Chat 协议；均支持 text/image | 保留目录协议；不能路由级强制 Chat 并假定所有模型兼容。Qwen 目录还带 allowEmptySignature 兼容规则 |
| opencode-go DeepSeek V4.1 Flash / Hy4 Preview | 两者均在目录，但属于 openai-completions 分组；DeepSeek 为 low/high/max、text/image；Hy4 为 off→none 与 high、text | 遍历整个混合协议目录，不能只看第一个协议分组误报“模型不存在”；保持逐模型端点/档位 |
| DeepSeek 原生 Flash | 当前覆盖目录声明 text-only；新版宿主默认 deepseek-flash 提供 image 与历史更新能力 | 比较本地覆盖与宿主默认；确认直连可用 ID 后恢复正确 image/更新能力，不要替换网关别名 |
| hy4-preview | 仍是插件出厂审查路由，但当前用户审查角色已改 GLM；这是回退/新部署风险，不是当前审查正在用混元 | 出厂不再钉死一个特定第三方服务，改继承或部署级推荐 |

相关原厂说明：

- [MiniMax OpenAI SDK](https://platform.minimax.io/docs/api-reference/text-openai-api)
- [MiMo OpenAI API](https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api)
- [Kimi 思考模型](https://platform.moonshot.ai/docs/guide/use-kimi-k2-thinking-model)
- [腾讯 Hy4 调用指南](https://cloud.tencent.com/document/product/1823/132252)
- [DeepSeek 当前模型列表](https://api-docs.deepseek.com/api/list-models)

**OpenCode Go 会话头需要按当前版本重新判断：**[Go 官方文档](https://opencode.ai/docs/go) 仍提示 DSH 部分模型路径的 session 支持曾不完整。当前实装 pi-ai 的 [OpenCode provider](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@earendil-works/pi-ai/dist/providers/opencode-go.js#L9-L20>) 已为四种协议都包上 [会话头注入](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@earendil-works/pi-ai/dist/providers/opencode-headers.js#L1-L20>)，DSH 同时传 sessionId。故不能沿用历史结论，认定“卸载旧注入插件后现在一定 MissingSessionID”。标准有 sessionId 的当前目录路径已有处理；辅助无 sessionId 请求或绕开目录 provider 的自定义路径仍应验证。**不建议未经检查重新安装旧注入插件。**

这里的候选项不是建议立即全部启用。先保证三个常用角色和主模型的链路可验证，收益远高于增加一堆未经验收的候选。

## 六、插件功能与 DSH 官方接口的差距

### 6.1 P1：修复自助更新丢固定模型与档位

证据：[角色构造逻辑](<C:/Users/17737/Code/other/DSH/plugins/dsh-OB-agent/src/authoring.ts#L159-L195>)。

本轮无文件修改的纯函数复现：

```text
创建：modelProvider=demo_provider, model=demo_model
更新：只给 id 和 description
结果：model 从固定路由变为 undefined
```

其实际含义是继承父会话当前模型，不是保留旧模型，也不是恢复出厂。当前 authoring 作用域为 own，因此此问题直接影响模型自建角色；在 scope=all 时可扩大到用户/内置角色。当前三个用户固定角色不会因为本轮只读审查自动被清空。

**最小修法：**

- modelProvider/model 都省略：保留 base.model，包括 reasoningEffort。
- 两者只填一个：返回中文错误，不静默变继承。
- 两者同时提供：切换到新模型；若未提供 effort，清除旧路由专属 effort，由目标模型确定合法默认。
- 显式切回继承：提供独立且清晰的操作，例如 inheritModel=true，不能用“漏传字段”兼任清空。
- 增加可选 reasoningEffort，并使用精确模型目录校验。修改本身不访问模型生成端点。

与官方对齐点：DSH 在换路由且未指定 effort 时会清除继承的路由自有档位；同一路由的普通编辑则应保留。[官方子选项合并](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-subagent/lib/types/child-agent.js#L49-L90>)。

### 6.2 P1：更新工具 Schema 与执行契约一致

证据：[参数定义](<C:/Users/17737/Code/other/DSH/plugins/dsh-OB-agent/src/authoring.ts#L74-L113>)、[更新工具描述](<C:/Users/17737/Code/other/DSH/plugins/dsh-OB-agent/src/authoring.ts#L264-L298>)。

当前 agent_update 的 required 实际包含 id/name/whenPrompt/identityPrompt，与“只需提供要改字段”矛盾。本轮直接读取生成结果已确认。

**修法：**

- 更新仅 required id，其余省略即保持。
- 新建继续 required id/name/whenPrompt/identityPrompt。
- 服务端显式校验枚举、类型、互斥字段与模型成对字段，不只依赖模型遵守 Schema。
- provider、permission 改成明确 enum，避免无效值静默落回默认值。
- 不强制所有请求启用 strict。strict 模式需完整支持的 Schema 形态与 provider 能力；supportsStrictMode=true 只是允许，不等于每个工具都已强制 strict。

当前裸 tools.register 路径不等于 defineTool 的完整参数验证包装，因此不能声称这个 required 缺陷会让所有调用直接报错；主要是误导模型和削弱约束。

### 6.3 P1：maxDepth 应继承宿主或显式可配

证据：[固定 maxDepth=3](<C:/Users/17737/Code/other/DSH/plugins/dsh-OB-agent/src/implement.ts#L102-L114>)；[官方深度规则](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tool-subagent/README.zh.md#L45-L63>)。

当前插件写死 3，覆盖宿主默认值及用户设置。虽然本插件另有“子代理不得再次委派”守卫，这仍不应替代宿主深度控制。

**修法：**默认不传 maxDepth，继承宿主；高级设置才允许显式覆盖，并展示有效深度。不要为了恢复嵌套委派而移除已有守卫，除非用户另行要求。

### 6.4 P1/P2：固定角色和官方动态模型选择应有明确分工

官方支持 modelSelectionSettings、每会话授权的精确 provider/model、list_subagent_models 和调用时实时路由预检。[官方选择说明](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tool-subagent/README.zh.md#L74-L78>)。

当前插件只传静态 agentOptions，没有接入此 opt-in 选择面。**这不代表没有模型预检**：原生工具仍调用 llm.resolveCallConfig。差距是插件的固定角色策略与宿主允许动态选择的策略相互独立，不能把其中一个当另一个的全局访问控制。

**推荐：**

- 代码审查/前端角色继续固定模型，保持可复现。
- 若用户需要，给“通用子代理”增加受授权的动态选择，而不是所有角色可随意换模型。
- 每作用域只有一个实例拥有 list_subagent_models，不要在每个具名角色里重复注册。
- 将发现工具纳入 OB 总开关、闸门精确名单与子代理禁止再委派策略，避免出现新工具未纳管。
- 写入时检查 route/effort；调用前仍走官方实时预检，不能因为曾保存成功就跳过。
- 若需要严格的组织级模型白名单，应在 LLM/权限策略层统一执行，不能仅依靠模型选择界面。

### 6.5 P2：暴露“配置模型”和“实际模型”

证据：[清单渲染](<C:/Users/17737/Code/other/DSH/plugins/dsh-OB-agent/src/plan.ts#L167-L175>)；[自助列表](<C:/Users/17737/Code/other/DSH/plugins/dsh-OB-agent/src/authoring.ts#L302-L331>)。

目前文档承诺含模型，但清单实际上只输出模式、权限、上下文和触发词。建议每项增加：

```text
配置路由：commandcode / deepseek/deepseek-v4.1-flash
思考档位：high（显式）
上下文：spawn；权限：full；模式：continuable
最近实际路由：……（来自已记录请求/descriptor，不是名称猜测）
状态：工具已装配 / 路由待预检 / 预检失败
```

未指定模型显示“继承主会话，启动时解析”，不要固定显示某个推测模型。已有子代理沿用其创建记录，不把当前设置误当它的实际路由。

### 6.6 P2：增加 maxTokens，但区分能力、默认和本次预算

官方 agentOptions 支持 maxTokens；当前插件接口只传 provider/model/effort。[官方 agentOptions](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tool-subagent/README.zh.md#L45-L50>)。

应分别显示：

1. 模型/网关能力上限；
2. provider 显式默认输出设置；
3. 子代理本次请求预算；
4. finish_reason 与是否截断。

当前父选项中显式 maxTokens 可被子代理继承，跨模型时只清 effort 不清 maxTokens。建议子模型使用明确兼容的预算，避免继承过小导致无回答，或继承过大超限。

**不要把所有模型的最大能力直接设成每次请求预算。** 实际应在可用范围内根据任务配置，并对 length/空回答明确报告。也不要把“上限提高”宣传成质量必然改善。

### 6.7 P1：代码审查的 full 不等于强只读

当前审查身份写“不修改代码”，但配置 permission=full；这是行为约定，不是执行隔离。默认 readonly 白名单只有 read/read_image/glob/grep，不能执行 git diff 或 shell，因此不能简单切 readonly 后要求它继续跑原流程。

**近期不开发的安全用法：**

- 主代理按用户要求准备明确范围的 staged diff、变更清单和测试结果。
- 审查子代理采用 readonly，仅看这些证据及源码；如需要进一步命令，由父代理执行再补给它。
- 新生成的证据不能替代源码核查；引用需绑定 commit 或 diff 快照。

**长期实现：**

- 对齐官方 spawn 的 agentPreset，为审查角色选择独立预设，提供窄化 git status/diff/log 工具，不给任意命令和编辑工具。
- 如要自动运行不可信测试，使用真正的执行隔离，不把 worktree 或 persona 当沙箱。
- 不要把 pwsh/bash/remote_ssh_exec 加入只读白名单来“修复”缺工具；那会重新引入任意写能力。
- 前端角色可保持 full，但明确可写目录与接口范围；并行开发应分文件/模块或 worktree，禁止同一物理文件重叠写入。

当前“每次修改就审查”属于用户自定义策略，不是厂商官方硬要求。若以后希望降低成本，可征得用户同意后改为按可审查变更批次触发；本轮不擅自改变该策略。

### 6.8 P2：其他维护性改进

- **出厂不要钉死特定第三方模型。** [默认审查角色](<C:/Users/17737/Code/other/DSH/plugins/dsh-OB-agent/src/defaults.ts#L52-L83>) 仍写 opencode-go/hy4-preview。新部署或恢复出厂容易得到不存在/未授权路由；建议继承或部署级配置。迁移必须保留用户当前 GLM 等定制，不重置整张条目表。
- **策略目录使用宿主实际 home。** 当前 [目录解析](<C:/Users/17737/Code/other/DSH/plugins/dsh-OB-agent/src/subagent-compat.ts#L21-L26>) 自读环境变量；显式 home 与环境不同的部署需核对官方 home 服务。当前环境未发现已发生错目录，不能断言现有冷恢复已坏。
- **孤立策略文件做审计，不盲删。** 先落盘后 activation 是正确安全顺序；后续启动失败可能残留文件。以后可做只读盘点和有证据的清理，但不可按“当前没有活跃子代理”就删除，历史会话还可能需要冷恢复。
- **空 persona suffix 的意图应明确。** 当前身份装配会覆盖并置空部署 suffix；如果 suffix 承载部署要求，应验证是否需要保留。不能不加区分地把全部父 persona 复制回来，重新污染角色身份。
- **注册表晚就绪与失败原因可视化。** 工具装配成功与模型往返成功分开显示；不能仅凭工具可见就标“模型可用”。

## 七、已有正确做法应保留

1. 使用公开 startActivation，预留带命名空间的 childId；先持久化策略，再创建子代理。
2. 不再向新版工具发送退役的 persona/toolFilter，不模拟已移除的一次性模式。
3. 等待异步 apply 和 Fiber.await，失败释放，不把失败能力宣传给主模型。
4. 继续由官方管理模型预检、descriptor、父子关系、完成通知、续话与中止。
5. 白名单隐藏加执行层 guard；缺失/坏策略拒绝恢复，而非回退 full。
6. 子代理默认不得再次委派，只允许向直接父代理回发。
7. 保留 send_message 原工具对象上的相邻关系标记，不能随意重新构造一个“长得一样”的对象。
8. 角色以 spawn 为默认：当前三个角色跨模型且任务相对独立，这是合理配置。

官方 fork 支持已完成轮次快照，不含父方当前进行中的轮次。**跨模型 fork 在当前实现中可以配置，不等于能复用父模型 KV Cache。** 跨模型/跨协议时不能搬用另一模型的加密签名；DSH 已有回放降级路径，应保留原日志并只在请求副本转换。故不建议为了省传参把三个角色统一改 fork。

参考：[官方 spawn](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-subagent-spawn-in-process/README.zh.md>)、[官方 fork](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-subagent-fork-in-process/README.zh.md>)、[适配器回放说明](<C:/Users/17737/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-llm-pi-ai/README.zh.md#L183-L185>)。

## 八、并发、缓存、套餐与数据出域

### 8.1 并发不是“同一轮全开”

现有“独立任务同轮并行”是调度建议，不应压过 provider 配额。建议以 provider+凭据/账户维度做共享并发队列，避免多个角色共享同一套餐却各自无限开。

百炼 Token Plan Personal 官方列有不同套餐对应的并发 Agents 范围。**本轮没有查用户订阅档位**，因此不硬编码具体并发数，也不把普通按量 API 的 RPM/TPM 当套餐额度。

限流与额度耗尽分开处理：429 可退避；权限、无效模型、耗尽额度不可无限重试。宿主已有重试策略，插件不要再套一层重复重试。

### 8.2 Token Plan 交互范围与隐私必须说明

[百炼 Token Plan Personal 官方说明](https://help.aliyun.com/en/model-studio/token-plan-personal-overview) 写明：面向编码/Agent 工具中的交互式使用，不应用于自动化脚本、自建业务后端或非交互批量调用；并披露输入和生成内容用于服务改进及模型优化。

因此：

- 用户交互触发的前端子代理不应一概判为违规。
- 无人值守定时任务、大规模后台批处理、把 DSH 暴露成业务 API 等不能默认沿用个人套餐。
- Ralph/workflow 是否符合条款，取决于具体触发与执行方式，不是工具叫什么名字；不确定应向服务商确认或使用适当的按量/企业服务。
- 敏感代码、客户数据、凭据不因“只是子代理”而不出域；创建到云模型就是一次真实外发。
- 本地提示词、日志、策略文件和云保留是不同层面；应各自治理，不声称开一个 ZDR 头就全部清除了。

### 8.3 缓存应看数据，不看开关名

- cacheRetention=long 不保证网关支持 24h retention 或实际命中。
- 稳定角色身份、工具顺序、持续续接通常比频繁改全局系统提示更利于缓存。
- 手工网关目录可能不支持历史中的系统/工具增量更新，当前适配器会重建当前提示与工具列表；不能把原生 provider 的缓存能力自动归给自定义网关。
- 记录 cached input、uncached input、output、reasoning（若上游报告）与实际账单；不要将目录中的占位价格当当前套餐真实费用。
- 为“追求缓存”保留完整无关历史可能反而增加成本。spawn 与 fork 应按上下文需要选择。

### 8.4 图片、工具与宿主扩展边界

- 当前 pi-ai 适配器默认每图约 4,194,304 像素、编码目标 1 MiB、整次请求累计 base64 图片预算 20 MiB。请求可能缩放或重编码；不要把模型看到的图默认当作原图逐像素证据。小字界面优先有针对性的 ROI，再做真实截图验收。
- 图片预算超限由宿主 image-offload 处理；不应由 OB 角色提示词承诺“所有历史图片始终保留”。纯文本模型也不应因工具能返回图片就自动宣称具备视觉能力。
- DSH 的通用请求接口没有直接提供 tool_choice、parallel_tool_calls、response_format 或逐工具 strict 字段。需要这些原生开关时，应在适配器/宿主能力层做支持与测试，不能仅给 OB 设置页加一个无效输入框。
- 模型返回多个工具调用与工具是否能并发执行是两回事；主/子代理的文件写入还必须串行，工具安全性声明不能被模型的并行建议覆盖。
- 自定义 provider 目前公开的协议入口主要是 openai-completions、openai-responses、anthropic-messages；Google 等原生协议宜复用已安装目录 provider，而不是把未支持的 api 名写到自定义路由后期待自动工作。
- provider 已有重试和约 300 秒流空闲看门狗。长思考任务要区分持续输出、真正卡死与流断连，不使用固定 sleep/轮询，也不为一次失败重复创建多个相同子代理。

## 九、建议落地顺序

### 第一批：插件小修，收益明确

1. 修复 agent_update 保留模型/effort，半填报错，显式恢复继承。
2. 分开 create/update Schema，并补执行侧校验。
3. 能力清单与管理列表显示配置模型、effort、是否继承；实例显示实际创建/最近使用路由。
4. 移除 maxDepth=3 默认覆盖，改继承宿主。
5. 文档同步，保留用户角色、会话选择和既有策略。

**验收：**局部纯函数与文案测试；不需要付费模型调用，不重置用户配置。

### 第二批：核心模型链路验证

1. GLM high 的连续工具、回放、只读首请求策略。
2. Qwen xhigh 的 enable_thinking、reasoning_content 原样续接、输出字段。
3. Command Code high 与工具回放，明确是否需额外 compat；单独验证 Responses 候选。
4. GPT-6.1 Sol 新建 Responses 路由灰度，验证后切默认；旧路由保留回退。

**验收：**离线载荷测试先行；真实测试只发无敏感、短输入。涉及费用或改变默认路由时先按用户要求确认范围。

### 第三批：安全与可持续使用

1. 独立审查 agentPreset + 窄 git 工具，或先由父代理提供 diff 给 readonly 审查。
2. 通用角色可选接入官方受授权动态模型选择。
3. 子代理 maxTokens 与 provider/账户并发队列。
4. ZDR、套餐交互范围说明、策略备份/审计。
5. 新模型目录更新采用差异核对，不盲升依赖，不修改安装目录来长期维护补丁。

## 十、建议验收清单

| 编号 | 测试 | 通过标准 |
|---|---|---|
| T01 | 自助更新 description | 固定 provider/model/effort 原样保留 |
| T02 | 只给 provider 或 model | 明确拒绝，不写配置 |
| T03 | 显式恢复继承 | 只在明确请求时生效 |
| T04 | 换模型不传 effort | 不把旧模型专属档位带过去 |
| T05 | update Schema | required 仅 id，省略字段保持 |
| T06 | 非法 enum/未知 effort | 保存或调用前结构化中文拒绝 |
| T07 | 宿主 maxDepth=0 | 插件角色也不能启动委派 |
| T08 | 只读首请求与恢复 | 首个请求前限制到位，写工具/任意 shell 均拒绝 |
| T09 | 总开关关闭/角色取消勾选 | 残留工具执行仍拒绝；已有实例的续话行为明确 |
| T10 | GLM/Qwen 初始载荷 | 精确合法 effort，开关正确，无重复预算控制 |
| T11 | 连续工具调用与下一用户轮 | call_id 配平；真实思考原样回传，不拼正文 |
| T12 | 冷恢复 | descriptor 模型保持，策略缺失明确拒绝，不降 full |
| T13 | 长回答/截断 | length 明示，不能标完整成功 |
| T14 | 图片工具结果 | 能看到实际图像；尺寸/压缩/丢图可解释 |
| T15 | Responses 灰度 | 工具、取消、恢复、用量、错误路径全通过 |
| T16 | 并发与限流 | provider 队列生效，429 有界退避，额度耗尽不盲重试 |
| T17 | 隐私开关 | ZDR 无上游返回拒绝，不静默去掉要求 |

## 十一、本轮验证结果与边界

### 已做

- 阅读当前插件三份功能文档、模型契约、关键源文件与相关测试，核对真实宿主实现及已安装模型目录。
- 核对当前 profile 的模型/角色声明；检查本会话实际能力清单；从真实通用子代理会话投影确认固定路由生效。
- 查询并提取 DSH 已安装官方包文档，以及 Z.AI、DeepSeek、阿里云、OpenAI、Command Code 等官方资料。
- 无认证读取 Command Code 公开模型目录，未发推理探针。
- 复核并运行子代理的 stub-fetch 离线探针，确认 GLM high 和 Qwen xhigh 初始思考载荷。该临时探针不是完整 DSH 端到端测试：其 system/tools 未经过 Models.normalizeContext，回放样例也未成功捕获请求，不能据此判定宿主丢工具或丢思考；其 Command Code 示例用了简化的 32,768 输出，与当前该模型显式 65,536 不同，只用于证明参数格式。
- 独立遍历 opencode-go 的全部四个协议分组，纠正“只看首个分组导致 DeepSeek/Hy4 缺失”的错误判断。
- 两个纯函数/Schema 复现：普通更新丢 model；update required 过宽。
- 局部测试 **138/138 通过**：authoring、implement、normalize、plan 共 115；策略与真实宿主接口组共 23，其中真实宿主接口 6。
- typecheck 通过；修改报告前 git status 干净、git diff --check 通过。
- 源码构建产物与 profile 安装副本 SHA256 相同；当前 GUI 3080 进程启动时间晚于该构建产物。不能沿用上轮“尚未重启所以必然旧版”的结论。

### 没有做／不能据此宣称

- 没有修改源码、活动 profile、密钥、默认路由或已保存角色；本轮只新增本报告。
- 没有重新构建、安装、重启 DSH 或另起服务器。
- 没有额外执行真实付费的模型验收探针；正常主/子代理调研本身仍按所选服务运行，不能宣称全程零费用。
- 没有完成 GLM/Qwen 的真实任务端到端、Responses 中转完整往返、全候选模型基准或浏览器面板交互验收。
- 138 个已有测试通过不覆盖两个新发现缺陷；现有断言甚至接受“半填模型就省略”的行为，需修正测试期望。
- 本次不是所有 DSH 插件的全功能审计。其他插件只在影响模型、权限、上下文和证据传递时纳入讨论。

## 十二、最终推荐

**保留当前三角色分工与 spawn/可续话架构。先修角色自助更新和可观测性，再做 GPT Responses 灰度与 Command Code 协议验收，最后补强审查权限、并发和套餐隐私策略。**

最不建议的做法是：把所有模型统一改 deepseek 格式、把所有档位改 max、把任意 shell 加进只读白名单、原地替换所有路由、恢复出厂覆盖用户配置，以及仅凭“没报错”就宣布与官方完全对齐。
