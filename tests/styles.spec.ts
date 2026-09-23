/**
 * 客户端样式：纵向节奏、布局类作用域与样式串完整性的回归防护。
 *
 * 背景（真实缺陷）：`.dsh_obAgent_field` 曾写成 `flex: 1 1 220px`。flex 简写里的 flex-basis
 * 按**主轴**生效，而这个类既会出现在行容器（`.dsh_obAgent_fields`，此时 220px 是宽度，符合预期）
 * 也会出现在列容器（卡片 / 编辑器，此时 220px 变成**高度**）里 —— 结果每个多行文本框下方凭空
 * 多出约 220px 空白，行间距忽大忽小。
 *
 * 因此本文件守住三条不变量：
 * 1. 会在两个轴向上出现的布局类不得自带 flex 简写；长度型 flex-basis 只能出现在
 *    **行容器 `.dsh_obAgent_fields` 的直接子项**这一种作用域里（只看有没有 `>` 不够：
 *    `.dsh_obAgent_card > .dsh_obAgent_field` 同样会把 basis 变成高度）；
 * 2. 设置页纵向节奏只有 4 / 6 / 12 三档（gap 与容器纵向 padding）；
 * 3. 样式串必须完整（模板串内误写反引号会把它提前截断）。
 */
import { describe, expect, it } from 'vitest'
import { OB_AGENT_CSS } from '../src/client/styles.ts'

/** 去掉注释后的样式串：解析规则块时用，避免注释里的 `{` / `}` 干扰。 */
const CSS_SOURCE = OB_AGENT_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 纵向节奏档位。新增档位必须同步这里并说明理由，否则视为无意的间距漂移。 */
const RHYTHM = ['4px', '6px', '12px'] as const

/**
 * 会在行、列两个轴向上出现的布局类。新增这类布局类时必须补进本名单，
 * 否则「双轴向类不得自带 flex 简写」这条断言覆盖不到它（通用断言只认长度型 basis）。
 */
const SHARED_AXIS_CLASSES = ['.dsh_obAgent_field', '.dsh_obAgent_switchRow'] as const

/** 允许分配宽度的作用域：行容器 `.dsh_obAgent_fields` 的直接子项。 */
const ROW_SCOPE = /^\s*\.dsh_obAgent_fields\s*>\s*[^\s>]+\s*$/

/** 长度型 basis 之外的安全值（关键字与零值不会把列容器撑高）。 */
const SAFE_BASIS = /^(?:auto|content|min-content|max-content|fit-content|0(?:[a-z%]+)?)$/i

/** 一条 CSS 规则。 */
interface CssRule {
  readonly selector: string
  readonly body: string
}

/**
 * 把样式串解析成规则块。按花括号深度扫描（不是简单按 `}` 切分），并跳过引号内内容，
 * 因此声明值里出现 `}`（如 `content: "}"`）不会截断规则；`@media` 一类嵌套块会递归进去，
 * 内部规则照常参与断言。
 * @param css - 待解析的样式串（应已剥离注释）。
 * @returns 全部规则，按出现顺序。
 */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  let depth = 0
  let head = 0
  let quote = ''
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index] ?? ''
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char !== '}') continue
    depth -= 1
    if (depth < 0) {
      // 花括号不配对时保持可用：丢掉这一块，继续扫描。
      depth = 0
      head = index + 1
      continue
    }
    if (depth > 0) continue
    const open = css.indexOf('{', head)
    if (open < 0) break
    const selector = css.slice(head, open).trim()
    const body = css.slice(open + 1, index)
    if (selector.startsWith('@')) rules.push(...parseRules(body))
    else if (selector !== '') rules.push({ selector, body })
    head = index + 1
  }
  return rules
}

const RULES = parseRules(CSS_SOURCE)

/**
 * 取某个选择器的全部声明（多选择器规则里与它同组的那份也算）。
 * 选择器按逗号拆分后**整串比较**，所以 `.dsh_obAgent_field` 不会命中 `.dsh_obAgent_fieldLabel`，
 * 也不会命中 `.dsh_obAgent_fields > .dsh_obAgent_field`。
 * 注意：`:is(a, b)` 这类选择器内含逗号，本函数无法整串命中（当前样式表没有这种写法）。
 * @param selector - 完整选择器文本。
 * @returns 声明文本；未找到规则时为空串。
 */
function bodyOf(selector: string): string {
  return RULES
    .filter(rule => rule.selector.split(',').map(part => part.trim()).includes(selector))
    .map(rule => rule.body)
    .join(';')
}

/**
 * `flex` 简写的第三分量是不是「长度型 basis」。
 * 按分量解析而不是按单位白名单，`50%` / `20ch` / `30vw` / `220PX` 都能识别；
 * 只有两个分量（如 `flex: 1 1` 缺 basis 时按 `0%`）与关键字、零值不算。
 * @param value - `flex` 简写的值。
 * @returns 是否为长度型 basis。
 */
function hasLengthBasis(value: string): boolean {
  const tokens = value.trim().split(/\s+/)
  if (tokens.length < 3) return false
  return !SAFE_BASIS.test(tokens[2] ?? '')
}

/**
 * 规则里是否存在长度型 flex-basis（单独声明，或 `flex` 简写的第三分量）。
 * @param body - 规则声明块。
 * @returns 是否存在。
 */
function hasLengthFlexBasis(body: string): boolean {
  if (/(?:^|[\s;])flex-basis\s*:/i.test(body)) return true
  const shorthand = /(?:^|[\s;])flex\s*:\s*([^;]+)/i.exec(body)?.[1]
  return shorthand !== undefined && hasLengthBasis(shorthand)
}

describe('客户端样式：纵向节奏', () => {
  it('双轴向布局类不得自带 flex 简写（否则 flex-basis 会在列容器里变成高度）', () => {
    for (const selector of SHARED_AXIS_CLASSES) {
      const body = bodyOf(selector)
      expect(body, `${selector} 未找到规则`).not.toBe('')
      expect(body, `${selector} 不应出现 flex 简写`).not.toMatch(/(?:^|[\s;])flex\s*:/)
      expect(body, `${selector} 不应出现 flex-basis`).not.toContain('flex-basis')
    }
  })

  it('长度型 flex-basis 只能分配给行容器 .dsh_obAgent_fields 的直接子项', () => {
    const offenders = RULES
      .filter(rule => hasLengthFlexBasis(rule.body))
      .filter(rule => rule.selector.split(',').some(part => !ROW_SCOPE.test(part)))
      .map(rule => rule.selector)
    expect(offenders, '这些规则的长度型 flex-basis 会随容器轴向变成高度，必须限定在行容器的直接子项上').toEqual([])
  })

  it('一行多列的宽度只在限定作用域里分配', () => {
    expect(bodyOf('.dsh_obAgent_fields > .dsh_obAgent_field')).toContain('flex: 1 1 220px')
    expect(bodyOf('.dsh_obAgent_fields > .dsh_obAgent_switchRow')).toContain('flex: 1 1 220px')
  })

  it('设置页间距只有 4 / 6 / 12 三档', () => {
    // 名单里含一个行容器（`.dsh_obAgent_switchRow`，其 gap 是横向的），它同样受这三档约束。
    const spacing = [
      '.dsh_obAgent_section',
      '.dsh_obAgent_rows',
      '.dsh_obAgent_card',
      '.dsh_obAgent_fields',
      '.dsh_obAgent_field',
      '.dsh_obAgent_switchRow',
      '.dsh_obAgent_switchText',
      '.dsh_obAgent_editor',
    ]
    for (const selector of spacing) {
      const gap = /(?:^|[\s;])gap:\s*([^;]+);/.exec(bodyOf(selector))?.[1]?.trim()
      expect(gap, `${selector} 缺少 gap`).toBeDefined()
      expect([...RHYTHM], `${selector} 的 gap 不在节奏内`).toContain(gap)
    }
  })

  it('容器的纵向内边距也在节奏内（横向分量是显式例外）', () => {
    for (const selector of ['.dsh_obAgent_card', '.dsh_obAgent_editor', '.dsh_obAgent_footer']) {
      const padding = /(?:^|[\s;])padding:\s*([^;]+);/.exec(bodyOf(selector))?.[1]?.trim()
      expect(padding, `${selector} 缺少 padding`).toBeDefined()
      const parts = (padding ?? '').split(/\s+/)
      const vertical = parts.length >= 3 ? [parts[0], parts[2]] : [parts[0]]
      for (const value of vertical) {
        expect([...RHYTHM, '0', '0px'], `${selector} 的纵向 padding ${String(value)} 不在节奏内`).toContain(value)
      }
    }
  })

  it('展开区与卡片用同一套内边距', () => {
    expect(bodyOf('.dsh_obAgent_card')).toContain('padding: 12px 14px')
    expect(bodyOf('.dsh_obAgent_editor')).toContain('padding: 12px 14px')
  })

  it('解析器不受声明值里的花括号与嵌套 at-rule 影响', () => {
    const synthetic = '.a { content: "}"; gap: 6px; }\n@media (max-width: 600px) { .a { gap: 12px; } }'
    const parsed = parseRules(synthetic)
    expect(parsed.map(rule => rule.selector)).toEqual(['.a', '.a'])
    expect(parsed[0]?.body).toContain('gap: 6px')
    expect(parsed[1]?.body).toContain('gap: 12px')
  })

  it('样式串完整（模板串没有被反引号提前截断）', () => {
    expect(OB_AGENT_CSS).toContain('.dsh_obAgent_selectBox')
    expect(OB_AGENT_CSS.trimEnd().endsWith('}')).toBe(true)
  })
})
