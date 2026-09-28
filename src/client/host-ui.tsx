/**
 * 宿主 UI 适配层：把「DSH 版本差异」收敛到这一个文件。
 *
 * 背景：DSH 0.1.7 把产品图标从「名字里带尺寸」改成「名字里带描边档」——
 * `IconPlusOutline16` 变成 `IconPlusOutlineRegular`（1px 描边），尺寸改由 `size` 表达。
 * 旧名字在新版里**不存在**，而打包时 `@deepseek-ai/*` 是外部依赖，缺失的导入在运行期
 * 只会是 `undefined`：React 遇到 `undefined` 元素类型会直接抛错，槽位条目随即被摘除，
 * 界面上表现为整块静默消失（聊天框的条不出现、设置页整片空白）。
 *
 * 三条硬约束（都是踩过的坑）：
 * 1. **只用具名导入**。宿主提供的模块对象不保证可以被属性枚举，`import * as ns` 拿到的
 *    名字空间副本可能是空的——按名字查表就会把完全正常的宿主误判成「缺件」。
 * 2. **判定「组件在不在」不能只看 `typeof === 'function'`**。宿主把 `Button` 包在 `forwardRef`、
 *    把 `DisclosureRow` 包在 `memo` 里，拿到的是带 `$$typeof` 的**对象**；只看函数就会把
 *    健康的宿主误判成缺件（踩过：自检据此提前返回，重启后界面整个消失）。
 * 3. **自检只告警、绝不拦截注册**。缺一个图标/控件的代价是那一处空着，而「因为自检就
 *    不注册」会让整个界面消失，是严重得多的失败模式。
 *
 * 现代命名走具名导入，同时也是编译期校验：上游再改名时 `npm run check` 的 typecheck
 * 会先失败，不会等到运行期界面消失。旧命名由 `legacy-icons.d.ts` 补声明，同样具名导入，
 * 在旧宿主上取到组件、在新宿主上取到 `undefined`，于是同一份产物两边都能跑。
 */
import { createElement, type ComponentType } from 'react'
import {
  Button,
  DisclosureRow,
  IconAgentPresetOutline16,
  IconAgentPresetOutlineRegular,
  IconChevronDownOutline14,
  IconChevronDownOutlineRegular,
  IconChevronUpOutline14,
  IconChevronUpOutlineRegular,
  IconCopyOutline16,
  IconCopyOutlineRegular,
  IconPlusOutline16,
  IconPlusOutlineRegular,
  IconSettingsOutline14,
  IconSettingsOutlineRegular,
  IconTrashOutline16,
  IconTrashOutlineRegular,
  Menu,
  Switch,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** 图标组件的使用面（与宿主 `IconProps` 一致）。 */
export interface HostIconProps {
  readonly size?: number | undefined
  readonly className?: string | undefined
}

/** 图标组件。 */
export type HostIcon = ComponentType<HostIconProps>

/**
 * 界面渲染必需的结构组件：用**具名导入的绑定**而不是按名字查表，
 * 保证自检与真实渲染走同一条取用路径。
 */
const REQUIRED_COMPONENTS: Readonly<Record<string, unknown>> = {
  Button,
  DisclosureRow,
  Menu,
  Switch,
  Tag,
  Tooltip,
}

/** 已经报过的名字，避免每次渲染都刷屏。 */
const reported = new Set<string>()

/**
 * 判断一个宿主导出能不能当 React 元素类型渲染。
 *
 * 不能只看 `typeof === 'function'`：宿主把 `Button` 包在 `forwardRef` 里、把 `DisclosureRow`
 * 包在 `memo` 里，取到的是带 `$$typeof` 的**对象**。只看函数会把健康的宿主误判成缺件，
 * 而误判的代价（历史上）是整个界面被跳过注册。
 * @param value - 待判定的导出。
 * @returns 能否作为元素类型使用。
 */
function isElementType(value: unknown): value is HostIcon {
  if (typeof value === 'function') return true
  return typeof value === 'object' && value !== null && '$$typeof' in value
}

/**
 * 解析一个图标组件。
 * @param modern - 现代命名（0.1.7 起 `Icon<名>OutlineRegular`）；旧宿主上为 `undefined`。
 * @param legacy - 旧命名（0.1.5 时代 `Icon<名>Outline<尺寸>`）；新宿主上为 `undefined`。
 * @param size - 该图标在本插件里的显示尺寸，等于旧名字里的数字。
 * @param label - 缺失告警里显示的名字。
 * @returns 固定尺寸的图标组件；两个命名都拿不到时返回空组件（只留空位，不拖垮界面）。
 */
function icon(modern: unknown, legacy: unknown, size: number, label: string): HostIcon {
  const resolved = isElementType(modern) ? modern : isElementType(legacy) ? legacy : undefined
  if (resolved === undefined) {
    if (!reported.has(label)) {
      reported.add(label)
      console.error(`[dsh-ob-agent] 宿主缺少图标 ${label}：该图标位置留空，其余界面不受影响`)
    }
    return () => null
  }
  const Icon = resolved
  // 尺寸显式传入：新版字形的默认尺寸与旧版不一定一致（例如设置图标默认 16、这里是 14）。
  return props => createElement(Icon, { size: props.size ?? size, className: props.className })
}

/** 面板折叠箭头（14px）。 */
export const IconChevronDown = icon(
  IconChevronDownOutlineRegular, IconChevronDownOutline14, 14, 'IconChevronDownOutline*',
)

/** 面板展开箭头（14px）。 */
export const IconChevronUp = icon(
  IconChevronUpOutlineRegular, IconChevronUpOutline14, 14, 'IconChevronUpOutline*',
)

/** 复制条目（16px）。 */
export const IconCopy = icon(IconCopyOutlineRegular, IconCopyOutline16, 16, 'IconCopyOutline*')

/** 新增条目（16px）。 */
export const IconPlus = icon(IconPlusOutlineRegular, IconPlusOutline16, 16, 'IconPlusOutline*')

/** 闸门设置（14px）。 */
export const IconSettings = icon(
  IconSettingsOutlineRegular, IconSettingsOutline14, 14, 'IconSettingsOutline*',
)

/** 删除条目（16px）。 */
export const IconTrash = icon(IconTrashOutlineRegular, IconTrashOutline16, 16, 'IconTrashOutline*')

/** 子代理条（16px）。 */
export const IconAgentPreset = icon(
  IconAgentPresetOutlineRegular, IconAgentPresetOutline16, 16, 'IconAgentPresetOutline*',
)

/**
 * 自检宿主结构组件是否可用（只告警用，调用方不得据此放弃注册）。
 * @returns 缺失的组件名；为空表示界面可以正常渲染。
 */
export function missingHostComponents(): readonly string[] {
  return Object.entries(REQUIRED_COMPONENTS)
    .filter(([, component]) => !isElementType(component))
    .map(([name]) => name)
}
