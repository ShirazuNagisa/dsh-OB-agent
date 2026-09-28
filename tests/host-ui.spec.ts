/**
 * 宿主 UI 适配层测试。
 *
 * 为什么要测：打包时 `@deepseek-ai/*` 全部外部化，宿主换版本后缺失的导入在运行期只会是
 * `undefined`——React 遇到 `undefined` 元素类型会直接抛错，槽位条目随即被摘除，界面上
 * 表现为整块静默消失（DSH 0.1.7 把 `IconXxxOutline16` 改名为 `IconXxxOutlineRegular`
 * 之后就是这个症状）。
 *
 * 这里不加载真实的 `@deepseek-ai/dsh-client-ui-primitives`（它是 ESM 包，依赖 DSH 解析链上的
 * 内部包与 CSS），而是用假模块构造几种宿主形态。「现代命名在当前依赖里真实存在」由具名
 * 导入本身保证：名字再被改掉时 `npm run check` 的 typecheck 先失败。
 *
 * 注意本文件的边界：假模块是可枚举的普通对象，因此它**拦不住**「有人重新改用
 * `import * as ns` 按名字查表」这类回归——那条约束靠 `src/client/host-ui.tsx` 顶部的说明与
 * 代码评审守住。这里能守住的是解析优先级、降级行为，以及「memo / forwardRef 形态不算缺件」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forwardRef, memo } from 'react'

const MODULE = '@deepseek-ai/dsh-client-ui-primitives'

/** 结构组件名（默认齐全，缺件场景显式写成 undefined）。 */
const COMPONENT_NAMES = ['Button', 'DisclosureRow', 'Menu', 'Switch', 'Tag', 'Tooltip'] as const

/** 现代命名（0.1.7 起）：`Icon<名>OutlineRegular`。 */
const MODERN_NAMES = [
  'IconChevronDownOutlineRegular',
  'IconChevronUpOutlineRegular',
  'IconCopyOutlineRegular',
  'IconPlusOutlineRegular',
  'IconSettingsOutlineRegular',
  'IconTrashOutlineRegular',
  'IconAgentPresetOutlineRegular',
] as const

/** 旧命名（0.1.5 时代）：尺寸写在名字里。 */
const LEGACY_NAMES = [
  'IconChevronDownOutline14',
  'IconChevronUpOutline14',
  'IconCopyOutline16',
  'IconPlusOutline16',
  'IconSettingsOutline14',
  'IconTrashOutline16',
  'IconAgentPresetOutline16',
] as const

/** 造一个假宿主模块：列出的名字是函数，其余名字取到 undefined。 */
function host(options: {
  components?: readonly string[]
  modern?: readonly string[]
  legacy?: readonly string[]
}): Record<string, unknown> {
  const toFunctions = (names: readonly string[] | undefined): Record<string, unknown> =>
    Object.fromEntries((names ?? []).map(name => [name, () => null]))
  const toUndefined = (names: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(names.map(name => [name, undefined]))
  return {
    ...toUndefined(COMPONENT_NAMES),
    ...toFunctions(options.components),
    ...toUndefined(MODERN_NAMES),
    ...toFunctions(options.modern),
    ...toUndefined(LEGACY_NAMES),
    ...toFunctions(options.legacy),
  }
}

/** 在指定的假宿主下加载适配层。 */
async function loadWith(exports: Record<string, unknown>): Promise<typeof import('../src/client/host-ui.tsx')> {
  vi.resetModules()
  vi.doMock(MODULE, () => exports)
  return await import('../src/client/host-ui.tsx')
}

/** 断言图标真被解析出来（占位组件调用后返回 null），且解析到的是**可渲染**的元素类型。 */
function expectRealIcon(name: string, icon: unknown): void {
  const element = (icon as (props: object) => { type?: unknown } | null)({})
  expect(element, `${name} 未解析到宿主图标（只拿到空占位）`).not.toBeNull()
  // 不能只认函数：宿主的 Button / DisclosureRow 是 forwardRef / memo 出来的对象。
  const type = element?.type
  const renderable = typeof type === 'function'
    || (typeof type === 'object' && type !== null && '$$typeof' in type)
  expect(renderable, `${name} 解析到的不是可渲染的宿主组件`).toBe(true)
}

/** 断言图标退化为空占位（只留空位，不抛错）。 */
function expectPlaceholderIcon(name: string, icon: unknown): void {
  expect((icon as (props: object) => unknown)({}), `${name} 应当退化为空占位`).toBeNull()
}

describe('宿主 UI 适配层', () => {
  it('现代命名（0.1.7 起的宿主）下全部图标可解析、结构组件齐全', async () => {
    const ui = await loadWith(host({ components: COMPONENT_NAMES, modern: MODERN_NAMES }))
    expect(ui.missingHostComponents()).toEqual([])
    expectRealIcon('IconChevronDown', ui.IconChevronDown)
    expectRealIcon('IconChevronUp', ui.IconChevronUp)
    expectRealIcon('IconCopy', ui.IconCopy)
    expectRealIcon('IconPlus', ui.IconPlus)
    expectRealIcon('IconSettings', ui.IconSettings)
    expectRealIcon('IconTrash', ui.IconTrash)
    expectRealIcon('IconAgentPreset', ui.IconAgentPreset)
  })

  it('只有旧命名（0.1.5 时代的宿主）时走旧名兜底', async () => {
    const ui = await loadWith(host({ components: COMPONENT_NAMES, legacy: LEGACY_NAMES }))
    expect(ui.missingHostComponents()).toEqual([])
    expectRealIcon('IconChevronDown', ui.IconChevronDown)
    expectRealIcon('IconSettings', ui.IconSettings)
    expectRealIcon('IconAgentPreset', ui.IconAgentPreset)
  })

  it('两套命名都缺时图标退化为空占位而不是 undefined', async () => {
    const ui = await loadWith(host({ components: COMPONENT_NAMES }))
    expectPlaceholderIcon('IconPlus', ui.IconPlus)
    expectPlaceholderIcon('IconTrash', ui.IconTrash)
  })

  it('结构组件缺失时自检能报出来（调用方只告警、不放弃注册）', async () => {
    const ui = await loadWith(host({
      components: COMPONENT_NAMES.filter(name => name !== 'Switch' && name !== 'Tooltip'),
      modern: MODERN_NAMES,
    }))
    const missing = ui.missingHostComponents()
    expect(missing).toContain('Switch')
    expect(missing).toContain('Tooltip')
    expect(missing).not.toContain('Button')
  })

  it('memo / forwardRef 包装的组件不算缺件（只看 typeof 会误报）', async () => {
    // 宿主真实形态：Button 是 forwardRef、DisclosureRow 是 memo，取到的是带 $$typeof 的对象。
    // 误报的代价是「自检说缺件」——历史上它导致过整块界面被跳过注册。
    const ui = await loadWith({
      ...host({ components: COMPONENT_NAMES, modern: MODERN_NAMES }),
      Button: memo(() => null),
      DisclosureRow: forwardRef(() => null),
    })
    expect(ui.missingHostComponents()).toEqual([])
    expect(ui.IconPlus).toBeTypeOf('function')
  })

  it('memo 包装的图标仍能解析并渲染', async () => {
    const wrapped = Object.fromEntries(
      MODERN_NAMES.map(name => [name, name === 'IconPlusOutlineRegular' ? memo(() => null) : () => null]),
    )
    const ui = await loadWith({ ...host({ components: COMPONENT_NAMES }), ...wrapped })
    expectRealIcon('IconPlus', ui.IconPlus)
  })
})

afterEach(() => {
  vi.doUnmock(MODULE)
  vi.resetModules()
})
