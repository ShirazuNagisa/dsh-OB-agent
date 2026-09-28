/**
 * DSH 0.1.5 时代的产品图标命名（`Icon<名>Outline<尺寸>`）声明。
 *
 * 0.1.7 起这些导出已被移除，取而代之的是 `Icon<名>OutlineRegular / Medium`（描边档位），
 * 尺寸改由 `size` 属性表达。这里补声明只是为了让「旧名兜底」也走**具名导入**：
 * 客户端产物是 CJS + 外部依赖，宿主的模块对象上没有这个键时，取到的就是 `undefined`，
 * 不会变成加载错误，因此同一份产物在新旧宿主上都能跑。
 *
 * 为什么不按名字查表兜底：宿主提供的模块对象不保证可以被属性枚举（其名字空间副本可能是
 * 空的），按名字查会拿到 `undefined`，把「宿主完全正常」误判成「宿主缺件」——那会让整个
 * 界面被拦掉，比缺一个图标严重得多。具名导入走的是模块系统自己的解析路径，没有这个风险。
 */
// 这个空导出让本文件成为「模块」：只有模块里的 `declare module` 才是**增强**（与原声明合并）。
// 少了它，下面的声明会被当成覆盖整包的环境模块声明，把宿主类型全部顶掉。
export {}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** 旧版图标组件形状（只有 `size` 与 `className`）。 */
  interface LegacyIconProps {
    size?: number | undefined
    className?: string | undefined
  }

  export const IconChevronDownOutline14: (props: LegacyIconProps) => unknown
  export const IconChevronUpOutline14: (props: LegacyIconProps) => unknown
  export const IconCopyOutline16: (props: LegacyIconProps) => unknown
  export const IconPlusOutline16: (props: LegacyIconProps) => unknown
  export const IconSettingsOutline14: (props: LegacyIconProps) => unknown
  export const IconTrashOutline16: (props: LegacyIconProps) => unknown
  export const IconAgentPresetOutline16: (props: LegacyIconProps) => unknown
}
