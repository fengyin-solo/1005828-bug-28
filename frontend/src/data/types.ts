/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 操作本身成功、但联动环节有没办成的事（例如管段台账对不上），用 warning 提醒而不是假装成功。 */
  warning?: string
}

/** 登记类操作的返回：除了成功与否，还给出每个字段的具体问题，页面能直接把话放到对应格子下。 */
export type CreateEntryResult = {
  ok: boolean
  message: string
  fieldErrors?: Record<string, string>
  rowId?: number
  warning?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 清淤结论落到管段后，一条待清淤管段在清单里的样子。 */
export type PendingDredgeItem = {
  pipeCode: string
  dredgeNo: string
  status: string
  crew: string
  date: string
  thickness: string
  /** 管段台账里能不能找到这个管段；找不到只提示，不拦历史数据。 */
  knownPipe: boolean
}
