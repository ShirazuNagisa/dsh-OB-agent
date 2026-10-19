/**
 * 聊天输入框上方的「子代理」面板：总开关 + 条目勾选。
 *
 * 结构精确对齐 DSH 官方 dock（TodoDock / QueueDock）：36px 首行 + 可展开列表，
 * 面板以 12px 上圆角、无下边框的 0.5px 描边与下方输入卡片拼成一张连续表面。
 * 控件全部用 DSH 自己的 `dsh-client-ui-primitives`（Switch / Tag / 官方图标），
 * 因此外观与主题跟随宿主，不引入任何自造视觉。
 *
 * 条目分两组：本插件装配的角色在前；**DSH 自己实现的原生工具**收进一个默认折叠的分组
 * （`isDshProvidedEntry`），因此面板平时只占一行，而原生条目仍然受闸门管辖。
 *
 * 关闭总开关时首行显示「已拦截全部 Agent 工具」——主机侧此时会拦截全部 agent 类工具
 * （含 DSH 原生），所以这是状态说明而非装饰。写入不做乐观更新：以推回的设置快照为准，
 * 避免多窗口/多标签下显示与主机不一致。
 *
 * 「智能体团队模式」是全局让位开关（与设置页同一字段，也是本插件唯一会在 dock 里写全局设置
 * 的地方）：开启后本插件不接管代理、条目区只读，但面板仍可展开——展开里那一行开关就是退出
 * 团队模式的入口，因此它自己永远不被团队模式禁用。
 */
import { useEffect, useRef, useState } from 'react'
import { Switch, Tag, Tooltip, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { isDshProvidedEntry, type ObAgentEntry, type ObAgentSessionState } from '../contract.ts'
import type { ObservableLike } from '../context-types.ts'
import { IconAgentPreset, IconChevronDown, IconChevronUp } from './host-ui.tsx'
import type { ObAgentKey } from './locales.ts'
import { dockLocked, dockSummaryKey, isDockExpandable, type ObAgentSnapshot } from './store.ts'

/** 注入面：宿主观察源（绑定为 `useObAgent`）+ 会话标识 + 写入动词。 */
export interface ObAgentDockInjected {
  readonly hooks: { readonly obAgent: ObservableLike<ObAgentSnapshot> }
  readonly sessionId: string
  readonly setSession: (next: ObAgentSessionState) => Promise<string | undefined>
  /**
   * 写入全局的「智能体团队模式」开关（与设置页同一个字段）。
   *
   * 可选：宿主尚未注入时开关按只读呈现（不给用户一个点了没反应的控件）。
   */
  readonly setTeamMode?: ((next: boolean) => Promise<string | undefined>) | undefined
}

/** 组件完整 props：框架标准件 + 注入面 + 文案。 */
export interface ObAgentDockProps extends ObAgentDockInjected {
  readonly useObAgent: <S>(selector: (snapshot: ObAgentSnapshot) => S) => S
  readonly t: (key: ObAgentKey, params?: Record<string, string>) => string
}

/** 运行模式标签的文案与色调。 */
function modeTag(entry: ObAgentEntry, t: ObAgentDockProps['t']): { text: string; tone: TagTone } {
  return { text: t('mode.continuable'), tone: 'info' }
}

/**
 * 开合箭头：收起时向上、展开时向下。
 *
 * 按本面板的展开方向提示下一步动作，并与旧版方向反转。显式选择字形，避免旋转样式叠加。
 * @param open - 当前是否展开。
 * @returns 对应方向的箭头元素。
 */
export function chevronIcon(open: boolean): JSX.Element {
  return open ? <IconChevronDown /> : <IconChevronUp />
}

/**
 * 输入框上方的子代理面板。
 * @param props - 框架注入的 props。
 */
export function ObAgentDock(props: ObAgentDockProps): JSX.Element | null {
  const { useObAgent, setSession, setTeamMode, t } = props
  const snapshot = useObAgent(value => value)
  const [pending, setPending] = useState(false)
  const [teamPending, setTeamPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [teamError, setTeamError] = useState<string | undefined>(undefined)
  const [expanded, setExpanded] = useState(false)
  const [nativeOpen, setNativeOpen] = useState(false)
  const ready = snapshot.status === 'ready'
  const enabled = ready && snapshot.session.enabled
  const wasEnabled = useRef<boolean | undefined>(undefined)

  // 手动打开总开关时自动展开条目列表。首次就绪只记录基线、不展开：
  // 会话本来就默认开启时面板保持收起，不白占输入区。
  useEffect(() => {
    if (!ready) return
    if (wasEnabled.current === undefined) {
      wasEnabled.current = enabled
      return
    }
    if (enabled && !wasEnabled.current) setExpanded(true)
    wasEnabled.current = enabled
  }, [ready, enabled])

  if (snapshot.status === 'unavailable') return null

  const { section, session } = snapshot
  const teamMode = snapshot.teamMode
  // 只读与「可否展开」的判定都在 store 的纯函数里（离线测试覆盖），这里只调用。
  const locked = dockLocked({ writable: snapshot.writable, pending, teamMode })
  const entries = section.entries.filter(entry => entry.managed)
  const roles = entries.filter(entry => !isDshProvidedEntry(entry))
  const natives = entries.filter(entry => isDshProvidedEntry(entry))
  const nativeChecked = natives.filter(entry => session.selected.includes(entry.id)).length
  // 团队模式下（哪怕会话总开关是关的）也必须能展开：展开里的那一行就是退出团队模式的入口。
  const expandable = isDockExpandable({ enabled: session.enabled, teamMode })
  const open = expandable && expanded

  const commit = async (next: ObAgentSessionState): Promise<void> => {
    setPending(true)
    setError(undefined)
    const failure = await setSession(next)
    setPending(false)
    if (failure !== undefined) setError(failure)
  }

  /**
   * 切换「智能体团队模式」：写的是设置页那同一个全局字段。
   *
   * 与条目写入分开记状态：切团队模式时整块条目区都会变，用户要能立刻分辨是哪一次写入失败。
   * @param next - 目标状态。
   */
  const commitTeamMode = async (next: boolean): Promise<void> => {
    if (setTeamMode === undefined) return
    setTeamPending(true)
    setTeamError(undefined)
    const failure = await setTeamMode(next)
    setTeamPending(false)
    if (failure !== undefined) setTeamError(failure)
  }

  // 摘要的优先级只在 store.dockSummaryKey 里定义一次（离线测试覆盖它），这里只做渲染。
  const summaryKey = dockSummaryKey({
    pending,
    writable: snapshot.writable,
    teamMode,
    enabled: session.enabled,
    count: session.selected.length,
  })
  const summary = summaryKey === 'dock.count'
    ? t('dock.count', { n: String(session.selected.length) })
    : t(summaryKey)

  const renderRow = (entry: ObAgentEntry): JSX.Element => {
    const checked = session.selected.includes(entry.id)
    const mode = modeTag(entry, t)
    return (
      <li className="dsh_obAgent_row" key={entry.id}>
        <label className={`dsh_obAgent_rowMain${locked ? ' dsh_obAgent_rowMainDisabled' : ''}`}>
          <input
            type="checkbox"
            className="dsh_obAgent_check"
            checked={checked}
            disabled={locked}
            onChange={() => {
              const selected = checked
                ? session.selected.filter(id => id !== entry.id)
                : [...session.selected, entry.id]
              void commit({ enabled: session.enabled, selected })
            }}
          />
          <Tooltip label={entry.whenPrompt} side="top" maxWidth={360}>
            <span className="dsh_obAgent_rowName">{entry.name}</span>
          </Tooltip>
          <span className="dsh_obAgent_rowId">{entry.id}</span>
        </label>
        <span className="dsh_obAgent_rowTags">
          {entry.kind === 'native' ? <Tag tone="neutral">{t('dock.native')}</Tag> : null}
          {entry.kind === 'subagent' ? <Tag tone={mode.tone}>{mode.text}</Tag> : null}
          {entry.permission === 'readonly' && entry.kind === 'subagent'
            ? <Tag tone="neutral">{t('permission.readonly')}</Tag>
            : null}
          {entry.source === 'model' ? <Tag tone="info">{t('dock.modelMade')}</Tag> : null}
        </span>
      </li>
    )
  }

  /**
   * 展开面板里的「智能体团队模式」行。
   *
   * 它必须**始终可操作**（团队模式开启时也要能关掉），因此不受条目区的 `locked` 影响，
   * 只跟「写入中 / 设置只读 / 宿主没注入写入动词」有关。
   * @returns 团队模式开关行。
   */
  const renderTeamRow = (): JSX.Element => {
    const hint = teamMode ? t('dock.teamToggleLean') : t('dock.teamKicker')
    return (
      <div className="dsh_obAgent_teamRow">
        <span className="dsh_obAgent_teamText">
          <span className="dsh_obAgent_teamTitle">{t('dock.teamMode')}</span>
          <span className="dsh_obAgent_teamHint">{hint}</span>
        </span>
        <Switch
          className="dsh_obAgent_teamSwitch"
          checked={teamMode}
          disabled={teamPending || !snapshot.writable || setTeamMode === undefined}
          label={t('dock.teamMode')}
          title={hint}
          onChange={(next) => { void commitTeamMode(next) }}
        />
      </div>
    )
  }

  return (
    <div className="dsh_obAgent_dock" role="group" aria-label={t('dock.title')}>
      <div className="dsh_obAgent_panel">
        <div className="dsh_obAgent_head">
          <button
            type="button"
            className="dsh_obAgent_headMain"
            disabled={!expandable}
            aria-expanded={open}
            title={teamMode ? t('dock.teamLockedHint') : t('dock.hint')}
            onClick={() => { setExpanded(value => !value) }}
          >
            <span className="dsh_obAgent_lead"><IconAgentPreset /></span>
            <span className="dsh_obAgent_headLabel">{t('dock.title')}</span>
            <span className="dsh_obAgent_summary">{summary}</span>
            {expandable ? (
              <span className="dsh_obAgent_chevron">{chevronIcon(open)}</span>
            ) : null}
          </button>
          <Switch
            className="dsh_obAgent_switch"
            checked={teamMode ? false : session.enabled}
            disabled={locked}
            label={t('dock.switch')}
            title={teamMode ? t('dock.teamLockedHint') : t('dock.hint')}
            onChange={(next) => {
              // 关闭时保留勾选，方便再次打开即恢复。
              void commit({ enabled: next, selected: session.selected })
            }}
          />
        </div>

        {open ? (
          <>
            {renderTeamRow()}
            {roles.length === 0 ? null : <ul className="dsh_obAgent_list">{roles.map(renderRow)}</ul>}
            {natives.length === 0 ? null : (
              <>
                <button
                  type="button"
                  className="dsh_obAgent_groupHead"
                  disabled={teamMode}
                  aria-expanded={nativeOpen}
                  onClick={() => { setNativeOpen(value => !value) }}
                >
                  <span className="dsh_obAgent_chevron">{chevronIcon(nativeOpen)}</span>
                  <span className="dsh_obAgent_groupTitle">{t('dock.nativeGroup')}</span>
                  <span className="dsh_obAgent_groupCount">
                    {t('dock.nativeGroupCount', { n: String(nativeChecked) })}
                  </span>
                </button>
                {nativeOpen ? <ul className="dsh_obAgent_list">{natives.map(renderRow)}</ul> : null}
              </>
            )}
          </>
        ) : null}

        {teamError === undefined ? null : (
          <div className="dsh_obAgent_row">
            <span className="dsh_obAgent_error" role="status">{teamError}</span>
          </div>
        )}

        {error === undefined ? null : (
          <div className="dsh_obAgent_row">
            <span className="dsh_obAgent_error" role="status">{error}</span>
          </div>
        )}
      </div>
    </div>
  )
}
