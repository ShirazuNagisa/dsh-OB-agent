/**
 * 出厂数据自洽性测试：内置条目必须通过自身校验，且闸门名单与条目表一一对应
 * ——这是「DSH 全部 agent 类工具都由本插件管理」这条需求的回归防线。
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_ENTRIES, DEFAULT_SECTION } from '../src/defaults.ts'
import { ENTRY_ID_PATTERN, isDshProvidedEntry, subagentToolName } from '../src/contract.ts'
import { readSection, validateSection } from '../src/normalize.ts'
import { createGateMatcher } from '../src/plan.ts'

describe('内置条目表', () => {
  it('共 8 条（3 条插件角色 + 5 条 DSH 原生工具），标识合法且唯一', () => {
    expect(BUILTIN_ENTRIES).toHaveLength(8)
    const ids = BUILTIN_ENTRIES.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(ENTRY_ID_PATTERN.test(id)).toBe(true)
  })

  it('整体通过校验（提示词变量、白名单、长度都自洽）', () => {
    expect(validateSection(readSection(DEFAULT_SECTION))).toEqual([])
  })

  it('子代理角色只有「代码审查」与「通用子代理」，前者沿用 hy4 审计模型', () => {
    const roles = BUILTIN_ENTRIES.filter(entry => entry.kind === 'subagent')
    expect(roles.map(entry => entry.id)).toEqual(['code_review', 'general'])
    const review = roles[0]
    expect(review?.name).toBe('代码审查')
    expect(review?.defaultEnabled).toBe(false)
    expect(review?.permission).toBe('full')
    expect(review?.modes).toEqual(['one-shot'])
    expect(review?.whenPrompt).toContain('每次实际修改文件后都立即调用代码审查（包括代码、配置和文档）')
    expect(review?.whenPrompt).toContain('一次工具调用同时修改多个文件时只审查一次')
    expect(review?.whenPrompt).toContain('后续独立的文件修改仍需再次触发')
    expect(review?.whenPrompt).toContain('本次审查已经提出的建议')
    expect(review?.whenPrompt).toContain('提示文案')
    expect(review?.whenPrompt).toContain('高风险行为')
    expect(review?.whenPrompt).toContain('用户明确要求审查')
    expect(review?.identityPrompt).toContain('有现实影响')
    expect(review?.identityPrompt).toContain('不为凑数')
    expect(review?.model).toEqual({ provider: 'opencode-go', model: 'hy4-preview' })
    expect(subagentToolName('code_review', 'one-shot')).toBe('subagent_code_review')
    expect(subagentToolName('general', 'continuable')).toBe('subagent_general_session')
  })

  it('闸门名单里的每个精确名都有条目覆盖（不存在「只管不配」的工具）', () => {
    const covered = new Set(BUILTIN_ENTRIES.flatMap(entry => entry.toolNames ?? []))
    for (const name of DEFAULT_SECTION.gate.tools) {
      expect(covered.has(name), `${name} 没有对应条目`).toBe(true)
    }
  })

  it('重挂名单里的名字都被某个原生条目覆盖', () => {
    const covered = new Set(BUILTIN_ENTRIES.flatMap(entry => entry.toolNames ?? []))
    for (const name of DEFAULT_SECTION.gate.reprovide) {
      expect(covered.has(name), `${name} 没有对应条目`).toBe(true)
    }
  })

  it('全部条目派生的工具名都落在闸门匹配范围内（可被统一拦截）', () => {
    const matcher = createGateMatcher(readSection(DEFAULT_SECTION))
    for (const entry of BUILTIN_ENTRIES) {
      const names = entry.kind === 'native'
        ? entry.toolNames ?? []
        : entry.modes.map(mode => subagentToolName(entry.id, mode))
      for (const name of names) {
        expect(matcher.denies(name), `${name} 未被闸门匹配`).toBe(true)
      }
    }
  })

  it('默认勾选集合只含可继续对话的通用子代理与控制类原生工具', () => {
    const enabled = BUILTIN_ENTRIES.filter(entry => entry.defaultEnabled).map(entry => entry.id).sort()
    expect(enabled).toEqual(['agent_authoring', 'agents_control', 'agents_list', 'general'])
  })

  it('已下线的内置条目（代码审计 Hy4 / 分叉子代理）不再出现在出厂表里', () => {
    expect(BUILTIN_ENTRIES.some(entry => entry.id === 'code_audit')).toBe(false)
    expect(BUILTIN_ENTRIES.some(entry => entry.id === 'fork')).toBe(false)
  })

  it('DSH 原生条目构成折叠分组，插件自建能力不落进去', () => {
    expect(BUILTIN_ENTRIES.filter(isDshProvidedEntry).map(entry => entry.id))
      .toEqual(['agents_control', 'agents_list', 'workflow', 'ralph', 'subagent_native'])
    expect(BUILTIN_ENTRIES.filter(entry => !isDshProvidedEntry(entry)).map(entry => entry.id))
      .toEqual(['code_review', 'general', 'agent_authoring'])
  })

  it('只读白名单与提示词变量默认值非空且形状正确', () => {
    expect(DEFAULT_SECTION.readOnlyTools.length).toBeGreaterThan(0)
    expect(DEFAULT_SECTION.promptVariables).toEqual(['cwd', 'model'])
  })
})
