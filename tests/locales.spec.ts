/**
 * 文案字典自洽性测试。
 *
 * 为什么要测：`ObAgentKey` 由中文词典推导，英文词典并没有被类型约束到同一键集——
 * 往 zh 加键而忘记同步 en 时编译**不会**报错，界面会直接缺字。这里把「两份键位完全
 * 一致、且没有空文案」固化成回归防线。
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('文案字典', () => {
  const zhKeys = Object.keys(zh)
  const enKeys = Object.keys(en)

  it('中英键位完全一致', () => {
    expect([...enKeys].sort()).toEqual([...zhKeys].sort())
  })

  it('没有空文案', () => {
    for (const key of zhKeys) expect(zh[key as keyof typeof zh].trim()).not.toBe('')
    for (const key of enKeys) expect(en[key as keyof typeof en].trim()).not.toBe('')
  })

  it('占位符两边一致（避免某语言漏掉参数）', () => {
    const slots = (text: string): string[] => (text.match(/\{[a-zA-Z]+/g) ?? []).sort()
    for (const key of zhKeys) {
      const typed = key as keyof typeof zh
      expect(slots(en[typed]), `键 ${key} 的占位符不一致`).toEqual(slots(zh[typed]))
    }
  })
})
