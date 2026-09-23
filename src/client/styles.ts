/**
 * 客户端样式：一次性注入 `<style data-plugin-css>`，类名统一前缀 `dsh_obAgent_`。
 *
 * 设计原则（与 DSH 界面深度融合）：
 * 1. 颜色、字体、圆角、阴影、动效一律取 DSH 设计令牌（`--dsw-alias-*` / `--dsw-font-*` /
 *    `--ds-*`），不出现任何自造色值，从而自动跟随浅色/深色主题与字号设置。
 * 2. 交互控件（开关、按钮、标签、下拉、输入框）直接用 DSH 自己的
 *    `@deepseek-ai/dsh-client-ui-primitives`，本文件只负责**布局**。
 * 3. 输入框上方的面板精确复刻 DSH 官方 dock（TodoDock / QueueDock）的几何：
 *    宽度用 `--dsh-composer-*` 布局变量算、上圆角 12px、无下边框的 0.5px 描边，
 *    并以负下边距与下方输入卡片无缝拼接。
 * 4. **纵向**节奏只有三档：4px（同一文字块内的标题↔说明）、6px（字段内 标签↔控件↔说明）、
 *    12px（字段之间 / 卡片之间 / 区块之间）。行容器里的横向间距（8px / 10px）与 dock 面板
 *    复刻官方几何用的间距不属于纵向节奏，是显式例外。
 * 5. 布局类可能同时出现在行容器与列容器里，因此**禁止在布局类上直接写 `flex` 简写**：
 *    flex-basis 是按主轴生效的，同一个值在行容器里是宽度、在列容器里会变成高度。
 *    需要「一行多列」时用 `.dsh_obAgent_fields > xxx` 限定作用域（见该处注释）。
 */

const PLUGIN_STYLE_ID = 'dsh-ob-agent-styles'

/** 全量样式串（导出供回归测试断言，勿在运行时改写）。 */
export const OB_AGENT_CSS = `
/* ── 输入框上方：dock 外框（几何与官方 dock 一致，勿改） ───────────────── */
.dsh_obAgent_dock {
  box-sizing: border-box;
  width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
  max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
  margin: 0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);
  padding: 0 var(--dsh-composer-dock-inset);
  flex: none;
}

/* 面板：与下方输入卡片拼成一张连续表面（上圆角 + 无下边框） */
.dsh_obAgent_panel {
  position: relative;
  width: 100%;
  padding: 2px 0;
  overflow: hidden;
  background: var(--dsw-specific-tip);
  border-radius: 12px 12px 0 0;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.dsh_obAgent_panel::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-bottom: none;
  border-radius: inherit;
}

/* 面板首行：图标 + 标题 + 摘要 + 总开关（36px，与官方 dock 首行等高） */
.dsh_obAgent_head {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  padding: 4px 5px 4px 12px;
}
.dsh_obAgent_headMain {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  min-width: 0;
  height: 28px;
  padding: 0;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  background: 0 0;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
.dsh_obAgent_headMain:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh_obAgent_headMain:focus-visible { outline: 2px solid var(--dsw-alias-label-tertiary); outline-offset: -2px; }
.dsh_obAgent_headMain:disabled { cursor: default; }
.dsh_obAgent_lead { display: grid; flex: none; place-items: center; color: var(--dsw-alias-label-tertiary); }
.dsh_obAgent_headLabel {
  flex: none;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 24px;
}
.dsh_obAgent_summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh_obAgent_chevron {
  display: grid;
  flex: none;
  width: 14px;
  height: 14px;
  place-items: center;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 0.12s;
}
.dsh_obAgent_chevronOpen { transform: rotate(180deg); }
.dsh_obAgent_switch { flex: none; margin-right: 6px; }

/* 条目列表：与官方 dock 列表同样的高度上限与滚动条令牌 */
.dsh_obAgent_list {
  max-height: 180px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.dsh_obAgent_row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 4px 8px 4px 12px;
  border-radius: 8px;
}
.dsh_obAgent_row + .dsh_obAgent_row { box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1); }
.dsh_obAgent_rowMain {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}
.dsh_obAgent_rowMainDisabled { cursor: default; }
.dsh_obAgent_check {
  flex: none;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: inherit;
}
.dsh_obAgent_rowName {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh_obAgent_rowId {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
}
.dsh_obAgent_rowTags { display: flex; flex: none; align-items: center; gap: 4px; }

/* DSH 原生工具分组头：与条目行同为 36px 高，默认折叠，因此面板只多一行 */
.dsh_obAgent_groupHead {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 4px 12px;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-align: left;
  background: 0 0;
  border: 0;
  border-radius: 8px;
  box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1);
  cursor: pointer;
}
.dsh_obAgent_groupHead:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh_obAgent_groupHead:focus-visible { outline: 2px solid var(--dsw-alias-label-tertiary); outline-offset: -2px; }
.dsh_obAgent_groupCount { margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 16px; }

/* ── 通用文字 ─────────────────────────────────────────────────────────── */
.dsh_obAgent_hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh_obAgent_error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
.dsh_obAgent_code { color: var(--dsw-alias-label-caption); font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; }

/* ── 设置页：与「模型」设置页同一套栅格 ──────────────────────────────── */
.dsh_obAgent_section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.dsh_obAgent_title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.dsh_obAgent_intro {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px;
  line-height: 22px;
}
.dsh_obAgent_savedNotice {
  margin: 0;
  color: var(--dsw-alias-state-success-primary);
  font-size: 12px;
  line-height: 18px;
}
.dsh_obAgent_errorList {
  margin: 0;
  padding-left: 18px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.dsh_obAgent_rows {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dsh_obAgent_card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
}
.dsh_obAgent_cardHead { display: flex; align-items: center; gap: 10px; }
.dsh_obAgent_cardIdentity { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dsh_obAgent_cardName {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}
.dsh_obAgent_cardId {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsh_obAgent_cardActions { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
.dsh_obAgent_groupTitle { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.dsh_obAgent_groupDesc { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh_obAgent_fields { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; }
/* 字段外壳：卡片（列容器）与「一行多列」（行容器）里都会用到，所以这里**不写 flex 简写**：
   flex-basis 按主轴生效，写成 flex: 1 1 220px 时它在行容器里是宽度（期望），
   在列容器里就变成高度 —— 每个多行文本框下方会凭空多出 220px 空白，行间距随之忽大忽小。
   宽度只在下面这条限定作用域的规则里分配。SwitchRow 一并纳入「一行多列」：两个开关行
   等分该行、各自的开关贴到列尾，列宽与行距跟其它多列字段保持一致。 */
.dsh_obAgent_field { display: flex; flex-direction: column; gap: 6px; }
.dsh_obAgent_fields > .dsh_obAgent_field,
.dsh_obAgent_fields > .dsh_obAgent_switchRow { flex: 1 1 220px; min-width: 180px; }
.dsh_obAgent_fieldLabel {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}
.dsh_obAgent_fieldDesc { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh_obAgent_switchRow { display: flex; align-items: flex-start; gap: 12px; }
.dsh_obAgent_switchText { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.dsh_obAgent_checkRow { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; }
.dsh_obAgent_checkRow input[type='checkbox'] {
  flex: none;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.dsh_obAgent_editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 12px;
}
.dsh_obAgent_footer {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0 4px;
  background: var(--dsw-alias-bg-layer-2);
}

/* Button 没有 danger 变体、图标形态也没有独立尺寸，这里用重复类名抬高优先级，
   保证无论宿主样式表与本样式的先后顺序如何都能覆盖 Button 自身的 padding / 悬停底色。 */
.dsh_obAgent_iconBtn.dsh_obAgent_iconBtn { width: 28px; padding: 0; }
.dsh_obAgent_danger.dsh_obAgent_danger { color: var(--dsw-alias-state-error-primary); }
.dsh_obAgent_danger.dsh_obAgent_danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }

/* ── 原生控件：对齐 settings-models 的 input / select ─────────────────── */
.dsh_obAgent_input,
.dsh_obAgent_select,
.dsh_obAgent_textarea {
  box-sizing: border-box;
  width: 100%;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  outline: none;
}
.dsh_obAgent_input,
.dsh_obAgent_select { height: 32px; padding: 0 10px; }
.dsh_obAgent_textarea {
  min-height: 72px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 20px;
  resize: vertical;
}
.dsh_obAgent_input:focus,
.dsh_obAgent_select:focus,
.dsh_obAgent_textarea:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh_obAgent_input::placeholder,
.dsh_obAgent_textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh_obAgent_input:disabled,
.dsh_obAgent_select:disabled,
.dsh_obAgent_textarea:disabled { cursor: default; opacity: 0.6; }
.dsh_obAgent_select { cursor: pointer; }
.dsh_obAgent_selectBox {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 12px 12px;
  padding-right: 32px;
}
`

/** 注入样式（幂等；无 document 环境时静默跳过）。 */
export function adoptStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(PLUGIN_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = PLUGIN_STYLE_ID
  style.setAttribute('data-plugin-css', 'dsh-ob-agent')
  style.textContent = OB_AGENT_CSS
  document.head.appendChild(style)
}
