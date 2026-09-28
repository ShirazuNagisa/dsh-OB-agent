# dsh-ob-agent

DSH（DeepSeek Harness）插件：把部署里**全部 agent 类工具**（子代理委派、续话与中止、
工作流、Ralph、以及模型自助管理）收口到一处统一管理。

- **一个总开关**：关闭时模型完全不能使用子代理 —— 不是「不提供」，而是主动拦截 DSH
  原生的委派/编排工具（`tools.restrict` 隐藏 + `tools.guard` 执行层拒绝）。
- **一张条目表**：每条 = 一个可勾选的 Agent 能力，带两个提示词（① 何时调用给主模型、
  ② 身份提示词给子代理）、运行模式（一次性 / 可继续对话，可多选）、模型、权限（只读 / 完全）。
- **每会话勾选**：聊天框输入框上方的「子代理」条按会话记录选择，勾选即写入系统提示。
- **出厂 8 条**：3 条插件角色（`code_review` 钉死 hy4 审计模型、`general` 通用委派、
  `agent_authoring` 模型自助管理）+ 5 条 DSH 原生工具；原生那 5 条**一条都没删**、仍受
  闸门管辖，但在面板里默认折叠成一行，界面平时只占一行。
- **模型自助**：模型可用 `agent_create` / `agent_update` / `agent_list` 创建与复用 Agent
  条目（默认只能改自己创建的条目，带审计日志）。
- **子代理可回发**：可继续对话的子代理内部默认放行 `send_message`（只放行这一个，目标是
  它的直接父代理），中途能汇报进度或追问；一次性子代理与其余 Agent 工具照旧不放行。

## 文档

| 文档 | 读者 |
| --- | --- |
| `docs/USAGE.md` | 使用者：安装、界面、语义、验收清单、排障、限制 |
| `docs/model-guide.md` | 模型：工具契约、字段规范、何时自建 Agent、常见错误 |

## 结构

```
src/
  index.ts         host 插件体：设置注册、agent 生命周期、触发重算
  contract.ts      共享契约（类型与常量，host/client 共用）
  defaults.ts      出厂数据：8 条内置条目（3 条插件角色 + 5 条 DSH 原生工具）、闸门名单、模型面文案模板
  normalize.ts     纯归一化、校验与出厂默认迁移（host 与浏览器共用，零运行期依赖）
  plan.ts          纯函数：选择 → 已启用条目 → 闸门匹配 → 系统提示段文本
  implement.ts     纯函数：条目 → 实装动作（档 A 放行 / 档 B 重挂 / 档 C 不可用）
  reconcile.ts     每 agent 协调器：隐藏层 + 执行层 + 重挂层，幂等差异应用
  authoring.ts     模型自助管理工具（agent_create / agent_update / agent_list）
  settings.ts      host 侧 live Config schema（schemastery 模式，仅 host 引用）
  docpath.ts       面向模型的文档定位与注入方式
  context-types.ts 所消费服务的结构面（第三方插件不共享 DSH 的 cordis 实例）
  vendor.d.ts      运行期由 profile 解析的 DSH 包的最小声明
  client/          浏览器半：dock（总开关+勾选）、设置页、设置桥、文案、样式
  client/host-ui.tsx        宿主 UI 适配层：图标新旧命名（只走具名导入）+ 结构组件自检
  client/legacy-icons.d.ts  0.1.5 时代的图标命名声明（模块增强，供旧宿主兜底）
tests/             197 项单元测试（纯函数层、设置桥、出厂默认迁移、宿主 UI 适配、子代理装配路径）
```

## 开发

```bash
npm install          # 或 pnpm install --config.auto-install-peers=false
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # esbuild 三份产物 + tsc 声明
npm run check        # 以上三件一起
```

- 运行期依赖（`@deepseek-ai/dsh-*`、`@deepseek-ai/schemastery`、`react`）由 DSH profile
  提供，构建时全部外部化；它们只发布在 DSH 自身的解析链上，因此**不作为开发依赖安装**
  （见 `src/vendor.d.ts` 顶部说明）。
- **例外**：`@deepseek-ai/dsh-client-ui-primitives` 是可从 registry 安装的纯 UI 包，作为
  开发依赖安装**只用于类型与图标名校验**（运行期仍由 shell 提供）。它必须与当前 DSH
  版本保持一致：`src/client/host-ui.tsx` 用**具名导入**取宿主组件，名字被改掉时
  `npm run typecheck` 直接失败，不会等到运行期界面静默消失。取用宿主 UI 一律走具名导入，
  不要 `import * as ns` 后按名字查表 —— 宿主模块对象不保证可枚举，名字空间副本可能是空的。
- `.npmrc` 关闭 peer 自动安装，避免本地安装去 registry 拉取未发布的 DSH 内部包。
- 构建只写仓库的 `lib/`，而运行中的 DSH 读的是 profile 里的副本
  （`~/.dsh/profiles/web/node_modules/dsh-ob-agent`）：改完代码要 `pnpm install` 重新链接，
  或直接把 `lib/` 同步过去，否则界面行为一点都不会变（见 `docs/USAGE.md` 2.1）。

## 设计要点

1. **会话选择不进会话日志**：存在插件 live Config 的 `sessions` 映射（键 = 会话 id），
   因此界面与主机读同一份配置，不需要自定义 Remote / 投影 / HTTP 路由。
2. **闸门三层**：隐藏层只作用于继承面（`restrict` 拒绝 scope-local 名字），自有层重挂的
   工具靠执行层守卫兜住 —— 两层缺一不可。算拒绝名单前必须用 `tools.schemas(agent)` /
   `tools.get(name, agent)` 枚举继承面：上游的 scope 参数是「**查看者 agent 本身**」
   （`ScopeKey` 以 agent 对象为键），传 `agent.ctx` 会枚举为空、名单算空，隐藏层就静默
   失效成「看得见、一调用才被拒」。
3. **幂等差异应用**：每次重算先算目标指纹集合，只增删差异项，因此插件自身触发的
   `tools/change` 不会形成重装循环。
4. **失效安全**：提示词里的未知变量在写入口被拒绝，渲染期再转义一次（`renderPrompt` 遇到
   未注册变量会打断整个请求）；只读白名单交集为空时条目停用而不是降级为完全权限。
5. **子代理只回发、不再委派**：子代理只装闸门的前两层，不装配任何委派或编排工具；
   唯一例外是「回发给直接父代理」的 `send_message`（设置项 `childReplyToParent`，
   默认开启）—— 它在本层**只重挂这一个工具**，且只对可继续对话的子代理生效；判不出
   续话模式时按放行处理（判定失败不该变成「子代理失去唯一回发通道」，越权仍由上游的
   相邻关系校验兜住）。
6. **出厂默认可演进**：设置段带 `defaultsRevision`；版本落后时启动即迁移（替换内置条目、
   下线旧条目、重定向改名标识、清理失效的会话勾选），用户与模型自建的条目不受影响。

## 许可

MIT。
