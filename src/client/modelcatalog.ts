/**
 * 模型清单读取：设置页的模型下拉用它列出「DSH 设置里已添加的模型」。
 *
 * 走宿主已有的 `remote.session.modelCatalog()`（命名空间 `remote.session` 由
 * `@deepseek-ai/dsh-api-session-controller` 的客户端装配挂载），读取失败时降级为
 * 手动填写 provider / model，页面不整体不可用。
 */
import type { ClientContext } from '../context-types.ts'

/** 下拉需要的一个模型。 */
export interface CatalogModel {
  readonly id: string
  readonly name: string
  /** 适配器自有的思考等级档位 id。 */
  readonly efforts: readonly string[]
}

/** 下拉需要的一个 provider 分组。 */
export interface CatalogProvider {
  readonly id: string
  readonly name: string
  readonly models: readonly CatalogModel[]
}

/** 模型清单读取结果。 */
export interface ModelCatalogResult {
  readonly providers: readonly CatalogProvider[]
  /** 读取失败时的中文原因（此时 providers 为空，界面提示手动填写）。 */
  readonly error?: string
}

interface RawModel {
  readonly id?: unknown
  readonly name?: unknown
  readonly reasoning?: { readonly efforts?: readonly { readonly id?: unknown }[] } | undefined
}

interface RawGroup {
  readonly id?: unknown
  readonly name?: unknown
  readonly models?: readonly RawModel[]
}

interface RawCatalog {
  readonly groups?: readonly RawGroup[]
}

/** 把远端返回值归一化成下拉形状（对形状变化保持宽容）。 */
export function normalizeCatalog(value: unknown): CatalogProvider[] {
  const raw = (value ?? {}) as RawCatalog
  const groups = Array.isArray(raw.groups) ? raw.groups : []
  const providers: CatalogProvider[] = []
  for (const group of groups) {
    const id = typeof group.id === 'string' ? group.id : undefined
    if (id === undefined) continue
    const models: CatalogModel[] = []
    // Array.isArray 会把 readonly 数组收窄成 any[]，这里显式收回声明类型。
    const rawModels = (Array.isArray(group.models) ? group.models : []) as readonly RawModel[]
    for (const model of rawModels) {
      const modelId = typeof model.id === 'string' ? model.id : undefined
      if (modelId === undefined) continue
      const rawEfforts = (Array.isArray(model.reasoning?.efforts) ? model.reasoning?.efforts : []) as readonly { readonly id?: unknown }[]
      const efforts = rawEfforts
        .map(effort => (typeof effort.id === 'string' ? effort.id : undefined))
        .filter((effort): effort is string => effort !== undefined)
      models.push({
        id: modelId,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : modelId,
        efforts,
      })
    }
    providers.push({
      id,
      name: typeof group.name === 'string' && group.name !== '' ? group.name : id,
      models,
    })
  }
  return providers
}

/** 读取模型清单；失败返回中文原因而不是抛出。 */
export async function loadModelCatalog(ctx: ClientContext): Promise<ModelCatalogResult> {
  const remote = ctx.get('remote.session') as
    | { modelCatalog?: () => Promise<unknown> }
    | undefined
  if (remote?.modelCatalog === undefined) {
    return { providers: [], error: 'remote.session.modelCatalog 不可用' }
  }
  try {
    const result = await remote.modelCatalog() as { ok?: boolean; value?: unknown; error?: { message?: string } }
    if (result?.ok === false) {
      return { providers: [], error: result.error?.message ?? '宿主拒绝了模型清单请求' }
    }
    const payload = result?.ok === true ? result.value : result
    return { providers: normalizeCatalog(payload) }
  } catch (error) {
    return { providers: [], error: error instanceof Error ? error.message : String(error) }
  }
}
