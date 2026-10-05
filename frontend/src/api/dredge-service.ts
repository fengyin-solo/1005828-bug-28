import { filterRows } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type { ActionResult, EntryRow, PageResult } from '@/data/types'

// 管网清淤的专属业务规则：清淤编号去重、缺失字段拦截、结论回写管段。
// 历史记录保持入账当时的取值，状态联动只对经由本服务发生的新流转生效。

const DREDGE_KEY = 'dredge'
const PIPE_KEY = 'drainpipe'
const THICKNESS_FIELD = '淤积厚度'
const TEAM_FIELD = '清淤班组'
const CODE_FIELD = '清淤编号'
const SECTION_FIELD = '清淤管段'
const DREDGE_STATE_FIELD = '清淤状态'
const PIPE_STATE_FIELD = '管段状态'

const DREDGE_STATUSES = ['待清淤', '清淤中', '已完工', '需返工']
const PIPE_WAIT_DREDGE = '待清淤'
const PIPE_RUNNING = '运行正常'
const PIPE_DISCARDED = '已废弃'

export type DredgeForm = {
  清淤编号: string
  清淤管段: string
  淤积厚度: string
  清淤方式: string
  清淤班组: string
  清淤日期: string
  清淤量: string
}

export const EMPTY_DREDGE_FORM: DredgeForm = {
  清淤编号: '',
  清淤管段: '',
  淤积厚度: '',
  清淤方式: '',
  清淤班组: '',
  清淤日期: '',
  清淤量: '',
}

// 仅供测试/故障演练使用：打开后读取清淤列表会抛错，用来验证「读取失败 + 重试」链路。
let readShouldFail = false
export function __setDredgeReadShouldFail(flag: boolean): void {
  readShouldFail = flag
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

function trim(form: DredgeForm): DredgeForm {
  return Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, String(value ?? '').trim()]),
  ) as DredgeForm
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 管段业务字段（管段状态）只在原本就存着合法状态时才跟着结论走，
// 历史样例里写的是说明文字，保持当时的取值不动，兼容既有记录。
function syncPipeStateField(pipe: EntryRow, status: string): EntryRow {
  const current = pipe[PIPE_STATE_FIELD]
  const validState = typeof current === 'string' && MODULE_BY_KEY.get(PIPE_KEY)?.statuses.includes(current)
  return validState ? { ...pipe, [PIPE_STATE_FIELD]: status } : pipe
}

type PipeLinkResult =
  | { kind: 'linked' | 'already' | 'discarded' | 'missing'; message: string }

// 清淤结论落到管段的待清淤清单：登记/存在清淤结论时把管段挂上「待清淤」。
// 已报废管段不再被联动复活，找不到管段时只提示，不影响清淤记录入账。
function markPipeWaitingDredge(section: string): PipeLinkResult {
  const pipes = listRows(PIPE_KEY)
  const index = pipes.findIndex((pipe) => String(pipe['管段编号']) === section)
  if (index < 0) {
    return { kind: 'missing', message: `未找到管段「${section}」，清淤记录已入账，但未联动管段清单` }
  }
  const pipe = pipes[index]
  if (String(pipe.status) === PIPE_DISCARDED) {
    return { kind: 'discarded', message: `管段「${section}」已报废，清淤记录已入账，管段清单不作变更` }
  }
  if (String(pipe.status) === PIPE_WAIT_DREDGE) {
    return { kind: 'already', message: `管段「${section}」已在待清淤清单中` }
  }
  const nextPipes = [...pipes]
  nextPipes[index] = syncPipeStateField({ ...pipe, status: PIPE_WAIT_DREDGE, pending: true }, PIPE_WAIT_DREDGE)
  saveRows(PIPE_KEY, nextPipes)
  return { kind: 'linked', message: `管段「${section}」已加入待清淤清单` }
}

// 清淤完工：对应管段从待清淤清单摘除，回到运行正常。
// 只处理当前确实挂着「待清淤」的管段，其它状态（含历史遗留）一律不动。
function markPipeRunning(section: string): PipeLinkResult {
  const pipes = listRows(PIPE_KEY)
  const index = pipes.findIndex((pipe) => String(pipe['管段编号']) === section)
  if (index < 0) {
    return { kind: 'missing', message: `未找到管段「${section}」，清淤已完工，但未联动管段状态` }
  }
  const pipe = pipes[index]
  if (String(pipe.status) === PIPE_DISCARDED) {
    return { kind: 'discarded', message: `管段「${section}」已报废，完工结论不改变其状态` }
  }
  if (String(pipe.status) !== PIPE_WAIT_DREDGE) {
    return { kind: 'already', message: `管段「${section}」当前不在待清淤清单，状态保持「${String(pipe.status)}」` }
  }
  const nextPipes = [...pipes]
  nextPipes[index] = syncPipeStateField(
    { ...pipe, status: PIPE_RUNNING, pending: false, abnormal: false },
    PIPE_RUNNING,
  )
  saveRows(PIPE_KEY, nextPipes)
  return { kind: 'linked', message: `管段「${section}」已恢复运行正常` }
}

export function listDredgeEntries(filters: Record<string, string> = {}): PageResult {
  if (readShouldFail) {
    throw new Error('管网清淤列表读取失败，数据暂不可用')
  }
  const matched = filterRows(listRows(DREDGE_KEY), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export type DredgeSaveResult = ActionResult & { linked?: PipeLinkResult }

// 同一条清淤记录（按清淤编号识别）重复报送只入账一份。
export function registerDredgeEntry(rawForm: DredgeForm): DredgeSaveResult {
  const form = trim(rawForm)
  if (isBlank(form[CODE_FIELD])) {
    return { ok: false, message: '请填写清淤编号后再提交' }
  }
  if (isBlank(form[SECTION_FIELD])) {
    return { ok: false, message: '请填写清淤管段后再提交' }
  }
  const rows = listRows(DREDGE_KEY)
  const duplicated = rows.some((row) => String(row[CODE_FIELD] ?? '').trim() === form[CODE_FIELD])
  if (duplicated) {
    return { ok: false, message: `清淤编号 ${form[CODE_FIELD]} 已报送过，同一条记录只入账一份，请勿重复报送` }
  }
  const today = new Date().toISOString().slice(0, 10)
  const record: EntryRow = {
    id: nextId(rows),
    status: '待清淤',
    pending: true,
    abnormal: false,
    [CODE_FIELD]: form[CODE_FIELD],
    [SECTION_FIELD]: form[SECTION_FIELD],
    // 暂未实测的厚度留空，列表会明确标注「未实测」，并在提交清淤时拦截。
    [THICKNESS_FIELD]: form[THICKNESS_FIELD],
    清淤方式: form.清淤方式,
    [TEAM_FIELD]: form.清淤班组,
    清淤日期: form.清淤日期 || today,
    清淤量: form.清淤量,
    // 新记录的业务状态字段与流转状态保持一致；历史记录的该字段不受影响。
    [DREDGE_STATE_FIELD]: '待清淤',
  }
  saveRows(DREDGE_KEY, [...rows, record])
  const linked = markPipeWaitingDredge(form[SECTION_FIELD])
  return { ok: true, message: `清淤记录 ${form[CODE_FIELD]} 已登记，${linked.message}`, linked }
}

// 提交清淤前的必填校验：逐格指出缺的是哪一项，并挡住提交（不保存任何流转）。
export function missingSubmitFields(row: EntryRow): string[] {
  const missing: string[] = []
  if (isBlank(row[THICKNESS_FIELD])) {
    missing.push('淤积厚度（该管段尚未实测，补测后才能提交清淤）')
  }
  if (isBlank(row[TEAM_FIELD])) {
    missing.push('清淤班组')
  }
  return missing
}

export function runDredgeAction(id: number, action: string): DredgeSaveResult {
  const targets: Record<string, string> = {
    提交清淤: '清淤中',
    确认完工: '已完工',
    要求返工: '需返工',
  }
  const target = targets[action]
  if (!target) {
    return { ok: false, message: `清淤记录没有登记「${action}」这个动作` }
  }
  const rows = listRows(DREDGE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的清淤记录` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `清淤记录已经是「${target}」，不用重复操作` }
  }

  if (action === '提交清淤') {
    const missing = missingSubmitFields(row)
    if (missing.length > 0) {
      return { ok: false, message: `无法提交清淤：请先补齐 ${missing.join('、')}` }
    }
  }

  // 业务字段「清淤状态」只在原本存着合法状态时同步，历史样例值原样保留。
  const stateValue = row[DREDGE_STATE_FIELD]
  const stateIsValid = typeof stateValue === 'string' && DREDGE_STATUSES.includes(stateValue)
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== '已完工',
    abnormal: action === '要求返工',
    ...(stateIsValid ? { [DREDGE_STATE_FIELD]: target } : {}),
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows(DREDGE_KEY, nextRows)

  const section = String(row[SECTION_FIELD] ?? '')
  if (action === '确认完工' && section) {
    const linked = markPipeRunning(section)
    return { ok: true, message: `清淤记录已${action}，当前状态「${target}」；${linked.message}`, linked }
  }
  // 提交清淤、要求返工只改变清淤记录本身；返工不把管段摘离待清淤清单。
  return { ok: true, message: `清淤记录已${action}，当前状态「${target}」` }
}
