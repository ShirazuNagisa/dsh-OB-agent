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
 */
import { useEffect, useRef, useState } from 'react'
import {
  IconAgentPresetOutline16,
  IconChevronDownOutline14,
  Switch,
  Tag,
  Tooltip,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { isDshProvidedEntry, type ObAgentEntry, type ObAgentSessionState } from '../contract.ts'
import type { ObservableLike } from '../context-types.ts'
import type { ObAgentKey } from './locales.ts'
import type { ObAgentSnapshot } from './store.ts'

/** 注入面：宿主观察源（绑定为 `useObAgent`）+ 会话标识 + 写入动词。 */
export interface ObAgentDockInjected {
  readonly hooks: { readonly obAgent: ObservableLike<ObAgentSnapshot> }
  readonly sessionId: string
  readonly setSession: (next: ObAgentSessionState) => Promise<string | undefined>
}

/** 组件完整 props：框架标准件 + 注入面 + 文案。 */
export interface ObAgentDockProps extends ObAgentDockInjected {
  readonly useObAgent: <S>(selector: (snapshot: ObAgentSnapshot) => S) => S
  readonly t: (key: ObAgentKey, params?: Record<string, string>) => string
}

/** 运行模式标签的文案与色调。 */
function modeTag(entry: ObAgentEntry, t: ObAgentDockProps['t']): { text: string; tone: TagTone } {
  if (entry.modes.length > 1) return { text: t('mode.mixed'), tone: 'neutral' }
  return entry.modes[0] === 'continuable'
    ? { text: t('mode.continuable'), tone: 'info' }
    : { text: t('mode.one-shot'), tone: 'quiet' }
}

/**
 * 输入框上方的子代理面板。
 * @param props - 框架注入的 props。
 */
export function ObAgentDock(props: ObAgentDockProps): JSX.Element | null {
  const { useObAgent, setSession, t } = props
  const snapshot = useObAgent(value => value)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
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
  const locked = pending || !snapshot.writable
  const entries = section.entries.filter(entry => entry.managed)
  const roles = entries.filter(entry => !isDshProvidedEntry(entry))
  const natives = entries.filter(entry => isDshProvidedEntry(entry))
  const nativeChecked = natives.filter(entry => session.selected.includes(entry.id)).length
  const open = session.enabled && expanded

  const commit = async (next: ObAgentSessionState): Promise<void> => {
    setPending(true)
    setError(undefined)
    const failure = await setSession(next)
    setPending(false)
    if (failure !== undefined) setError(failure)
  }

  const summary = pending
    ? t('dock.pending')
    : !snapshot.writable
      ? t('dock.readonly')
      : !session.enabled
        ? t('dock.blocked')
        : session.selected.length === 0
          ? t('dock.none')
          : t('dock.count', { n: String(session.selected.length) })

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

  return (
    <div className="dsh_obAgent_dock" role="group" aria-label={t('dock.title')}>
      <div className="dsh_obAgent_panel">
        <div className="dsh_obAgent_head">
          <button
            type="button"
            className="dsh_obAgent_headMain"
            disabled={!session.enabled}
            aria-expanded={open}
            title={t('dock.hint')}
            onClick={() => { setExpanded(value => !value) }}
          >
            <span className="dsh_obAgent_lead"><IconAgentPresetOutline16 /></span>
            <span className="dsh_obAgent_headLabel">{t('dock.title')}</span>
            <span className="dsh_obAgent_summary">{summary}</span>
            {session.enabled ? (
              <span className={`dsh_obAgent_chevron${open ? ' dsh_obAgent_chevronOpen' : ''}`}>
                <IconChevronDownOutline14 />
              </span>
            ) : null}
          </button>
          <Switch
            className="dsh_obAgent_switch"
            checked={session.enabled}
            disabled={locked}
            label={t('dock.switch')}
            title={t('dock.hint')}
            onChange={(next) => {
              // 关闭时保留勾选，方便再次打开即恢复。
              void commit({ enabled: next, selected: session.selected })
            }}
          />
        </div>

        {open ? (
          <>
            {roles.length === 0 ? null : <ul className="dsh_obAgent_list">{roles.map(renderRow)}</ul>}
            {natives.length === 0 ? null : (
              <>
                <button
                  type="button"
                  className="dsh_obAgent_groupHead"
                  aria-expanded={nativeOpen}
                  onClick={() => { setNativeOpen(value => !value) }}
                >
                  <span className={`dsh_obAgent_chevron${nativeOpen ? ' dsh_obAgent_chevronOpen' : ''}`}>
                    <IconChevronDownOutline14 />
                  </span>
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

        {error === undefined ? null : (
          <div className="dsh_obAgent_row">
            <span className="dsh_obAgent_error" role="status">{error}</span>
          </div>
        )}
      </div>
    </div>
  )
}
