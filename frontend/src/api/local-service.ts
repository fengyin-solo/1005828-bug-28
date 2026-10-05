import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  failNextRead,
  invalidateCache,
  listRows,
  repairStorage,
  resetRows,
  saveRows,
  StorageReadError,
} from '@/data/local-store'
import type {
  ActionResult,
  CreateEntryResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  PendingDredgeItem,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 列表的异步读法：读取失败（本地存储坏了/故障注入）会在这里抛出，
 * 页面据此显示失败提示与重试按钮；成功时整批数据一次返回，页内各块都用同一份快照。
 */
export async function listEntriesAsync(
  key: string,
  filters: Record<string, string> = {},
): Promise<PageResult> {
  await new Promise((resolve) => {
    window.setTimeout(resolve, 260)
  })
  // 清淤页、管网页读取前先对齐一次：重试后两处数字天然一致。
  if (key === DREDGE_KEY || key === DRAINPIPE_KEY) {
    reconcileDrainpipeWithDredge()
  }
  return listEntries(key, filters)
}

// ---------------------------------------------------------------------------
// 管网清淤：缺数据校验、重复报送去重、结论联动排水管段
// ---------------------------------------------------------------------------

const DREDGE_KEY = 'dredge'
const DRAINPIPE_KEY = 'drainpipe'
const DREDGE_FIELDS = ['清淤编号', '清淤管段', '淤积厚度', '清淤方式', '清淤班组', '清淤日期', '清淤量']
// 登记入账时必填的格子：少了哪一格，页面就把话放到哪一格下面。
const DREDGE_REQUIRED_FIELDS = ['清淤编号', '清淤管段', '淤积厚度', '清淤方式', '清淤班组', '清淤日期']
// 提交清淤时必须已有实测数据的格子：淤积厚度没实测、班组没落实，都不允许提交。
const DREDGE_SUBMIT_FIELDS = ['淤积厚度', '清淤班组']
const THICKNESS_PATTERN = /^\d+(\.\d+)?\s*(cm|厘米|mm|毫米|m|米)?$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isBlankValue(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

/** 指出一条清淤记录缺了哪些关键格子，返回中文名列表。 */
export function missingDredgeFields(row: EntryRow, fields = DREDGE_SUBMIT_FIELDS): string[] {
  return fields.filter((field) => isBlankValue(row[field]))
}

/**
 * 把清淤结论落到排水管段：未完工（待清淤/清淤中/需返工）对应管段置「待清淤」，
 * 完工置「运行正常」。历史上管段编号对不上台账的，只给提醒、不改数据。
 * 返回非空字符串表示有一条需要让用户知道的提醒。
 */
function applyDredgeConclusion(pipeCode: string, dredgeStatus: string): string {
  const code = pipeCode.trim()
  if (!code) {
    return ''
  }
  const pipes = listRows(DRAINPIPE_KEY)
  const index = pipes.findIndex((row) => String(row['管段编号'] ?? '').trim() === code)
  if (index < 0) {
    return `清淤管段「${code}」在排水管段台账中找不到，管段状态未联动，请核对管段编号`
  }
  const pipe = pipes[index]
  if (String(pipe.status) === '已废弃') {
    return `管段「${code}」已报废，管段状态不再随清淤记录变化`
  }
  const target = dredgeStatus === '已完工' ? '运行正常' : '待清淤'
  if (String(pipe.status) === target) {
    return ''
  }
  const updated: EntryRow = { ...pipe, status: target, 管段状态: target }
  const next = [...pipes]
  next[index] = updated
  saveRows(DRAINPIPE_KEY, next)
  return ''
}

/**
 * 管段的待清淤清单：一条管段可能有多条清淤记录，取最新一条未完工记录代表当前结论；
 * 已完工的历史记录不进清单，保持当时的取值不动。
 */
export function pendingDredgeList(): PendingDredgeItem[] {
  const dredges = listRows(DREDGE_KEY)
  const knownCodes = new Set(
    listRows(DRAINPIPE_KEY).map((row) => String(row['管段编号'] ?? '').trim()),
  )
  const latestByPipe = new Map<string, EntryRow>()
  for (const row of dredges) {
    const code = String(row['清淤管段'] ?? '').trim()
    if (!code || String(row.status) === '已完工') {
      continue
    }
    const previous = latestByPipe.get(code)
    if (!previous || Number(row.id) > Number(previous.id)) {
      latestByPipe.set(code, row)
    }
  }
  return [...latestByPipe.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => {
      const code = String(row['清淤管段'] ?? '').trim()
      return {
        pipeCode: code,
        dredgeNo: isBlankValue(row['清淤编号']) ? '—' : String(row['清淤编号']),
        status: String(row.status),
        crew: isBlankValue(row['清淤班组']) ? '' : String(row['清淤班组']).trim(),
        date: isBlankValue(row['清淤日期']) ? '' : String(row['清淤日期']).trim(),
        thickness: isBlankValue(row['淤积厚度']) ? '' : String(row['淤积厚度']).trim(),
        knownPipe: knownCodes.has(code),
      }
    })
}

/**
 * 以清淤记录的最新结论为准，把排水管段台账对齐：最新记录未完工的管段置「待清淤」，
 * 最新记录已完工的置「运行正常」。台账里没有的编号、已报废管段一律不动。
 * 幂等：读取与重试前都跑一遍，清淤页与管网页两处显示始终对得上；
 * 历史清淤记录自身的取值保持不变，兼容既有记录。
 */
export function reconcileDrainpipeWithDredge(): void {
  const latestByPipe = new Map<string, EntryRow>()
  for (const row of listRows(DREDGE_KEY)) {
    const code = String(row['清淤管段'] ?? '').trim()
    if (!code) {
      continue
    }
    const previous = latestByPipe.get(code)
    if (!previous || Number(row.id) > Number(previous.id)) {
      latestByPipe.set(code, row)
    }
  }
  const pipes = listRows(DRAINPIPE_KEY)
  let changed = false
  const next = pipes.map((pipe) => {
    const code = String(pipe['管段编号'] ?? '').trim()
    const latest = latestByPipe.get(code)
    if (!latest || String(pipe.status) === '已废弃') {
      return pipe
    }
    const target = String(latest.status) === '已完工' ? '运行正常' : '待清淤'
    if (String(pipe.status) === target) {
      return pipe
    }
    changed = true
    return { ...pipe, status: target, 管段状态: target }
  })
  if (changed) {
    saveRows(DRAINPIPE_KEY, next)
  }
}

/**
 * 登记清淤记录。同一条记录（看清淤编号）重复报送只入账一份：
 * 内容完全一致按重复报送幂等成功，编号相同但内容不一致则拒绝并指明编号格。
 */
export function createDredgeEntry(input: Record<string, string>): CreateEntryResult {
  const values: Record<string, string> = {}
  for (const field of DREDGE_FIELDS) {
    values[field] = (input[field] ?? '').trim()
  }

  const fieldErrors: Record<string, string> = {}
  for (const field of DREDGE_REQUIRED_FIELDS) {
    if (!values[field]) {
      fieldErrors[field] = `请填写${field}`
    }
  }
  if (values['淤积厚度'] && !THICKNESS_PATTERN.test(values['淤积厚度'])) {
    fieldErrors['淤积厚度'] = '淤积厚度请填数字，可带单位，例如 12cm'
  }
  if (values['清淤日期'] && !DATE_PATTERN.test(values['清淤日期'])) {
    fieldErrors['清淤日期'] = '清淤日期格式应为 YYYY-MM-DD'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, message: '清淤记录没有入账：请先补全下方标红的必填项', fieldErrors }
  }

  const rows = listRows(DREDGE_KEY)
  const duplicate = rows.find(
    (row) => String(row['清淤编号'] ?? '').trim() === values['清淤编号'],
  )
  if (duplicate) {
    const identical = DREDGE_FIELDS.every(
      (field) => String(duplicate[field] ?? '').trim() === values[field],
    )
    if (identical) {
      return {
        ok: true,
        message: `清淤编号「${values['清淤编号']}」此前已报送过，未重复入账`,
        rowId: Number(duplicate.id),
      }
    }
    return {
      ok: false,
      message: `清淤编号「${values['清淤编号']}」已存在且内容不一致，同一编号只入账一份，请核对原记录或改用新编号`,
      fieldErrors: { 清淤编号: '该清淤编号已被占用' },
    }
  }

  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const created: EntryRow = { id, status: '待清淤', pending: true, abnormal: false, ...values }
  saveRows(DREDGE_KEY, [...rows, created])
  const warning = applyDredgeConclusion(values['清淤管段'], '待清淤')
  return {
    ok: true,
    message: `清淤记录「${values['清淤编号']}」已登记入账，对应管段已进入待清淤清单`,
    rowId: id,
    warning: warning || undefined,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 清淤专用闸口：淤积厚度没有实测、清淤班组没填，提交时一律挡住并点明缺哪一格。
  if (key === DREDGE_KEY && action === '提交清淤') {
    const missing = missingDredgeFields(rows[index])
    if (missing.length > 0) {
      const code = String(rows[index]['清淤编号'] ?? id)
      return {
        ok: false,
        message: `清淤记录「${code}」无法提交：缺少${missing.join('、')}，请补录后再提交，本次未保存`,
      }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 清淤结论联动排水管段状态；台账对不上等提醒以 warning 返回，不冒充成功也不静默吞掉。
  let warning: string | undefined
  if (key === DREDGE_KEY) {
    warning = applyDredgeConclusion(String(updated['清淤管段'] ?? ''), target) || undefined
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」`, warning }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 读取失败的演示与修复：页面故障面板按 recoverable 决定是否提供「修复并重载」。
export { failNextRead, invalidateCache, repairStorage, StorageReadError }

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
