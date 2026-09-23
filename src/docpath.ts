/**
 * 面向模型的文档（`docs/model-guide.md`）定位与注入。
 *
 * 插件目录既可能在 DSH profile 的 node_modules 下（安装副本），也可能在源码仓库里
 * （开发态），因此按 `import.meta.url` 上溯查找，不写死任何绝对路径。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ObAgentModelGuide } from './contract.ts'

/** 相对 `lib/` 的候选位置（安装副本与源码树都命中第一个）。 */
const CANDIDATES = ['../docs/model-guide.md', '../model-guide.md', '../../docs/model-guide.md']

/** 文档缺失时的兜底说明（模型仍知道去哪里找）。 */
const FALLBACK = '插件文档 docs/model-guide.md'

let cachedPath: string | undefined
let cachedText: string | undefined

/** 解析文档绝对路径；找不到返回 undefined。 */
export function resolveModelGuidePath(): string | undefined {
  if (cachedPath !== undefined) return cachedPath === '' ? undefined : cachedPath
  let here: string
  try {
    here = dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }
  for (const relative of CANDIDATES) {
    const candidate = join(here, relative)
    if (existsSync(candidate)) {
      cachedPath = candidate
      return candidate
    }
  }
  cachedPath = ''
  return undefined
}

/** 读取文档正文（缓存）；失败返回 undefined。 */
export function readModelGuideText(): string | undefined {
  if (cachedText !== undefined) return cachedText === '' ? undefined : cachedText
  const path = resolveModelGuidePath()
  if (path === undefined) {
    cachedText = ''
    return undefined
  }
  try {
    cachedText = readFileSync(path, 'utf8')
    return cachedText
  } catch {
    cachedText = ''
    return undefined
  }
}

/**
 * 按 `modelGuide.inject` 配置给出提示段里的「文档提示」。
 *
 * - `path`（默认）：只给绝对路径，省 token 且缓存友好；
 * - `inline`：把文档正文附在提示段末尾（内容较大，谨慎开启）；
 * - `off`：不指向文档，只说明字段规范在插件文档里。
 */
export function docHint(guide: ObAgentModelGuide): string {
  if (guide.inject === 'off') return FALLBACK
  if (guide.inject === 'inline') {
    const text = readModelGuideText()
    return text === undefined ? FALLBACK : `\n\n${text.trim()}`
  }
  return resolveModelGuidePath() ?? FALLBACK
}
