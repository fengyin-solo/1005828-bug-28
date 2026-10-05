<template>
  <section class="page" data-module="dredge">
    <header class="page-head">
      <div>
        <h2>管网清淤管理</h2>
        <p class="page-desc">维护清淤记录，围绕清淤编号、清淤管段、淤积厚度、清淤方式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记清淤记录</button>
        <button class="btn" type="button" @click="exportRows">导出管网清淤清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p v-if="notice" class="notice" :class="notice.tone" role="alert">
      {{ notice.text }}
    </p>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="loadState === 'loading'">
          <td :colspan="tableColspan" class="empty-state">正在加载管网清淤数据…</td>
        </tr>
        <tr v-else-if="loadState === 'error'">
          <td :colspan="tableColspan" class="load-error">
            <span class="error-text">{{ errorMessage || '管网清淤列表读取失败' }}</span>
            <button class="btn retry" type="button" @click="reload">重试</button>
          </td>
        </tr>
        <template v-else>
          <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-incomplete': isMissingThickness(row) }">
            <td v-for="column in columns" :key="column">
              <span v-if="column === thicknessField && isMissingThickness(row)" class="missing-tag">
                未实测
              </span>
              <span v-else-if="column === teamField && isBlankCell(row[teamField])" class="missing-tag">
                未填报
              </span>
              <template v-else>{{ isBlankCell(row[column]) ? '—' : row[column] }}</template>
            </td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                :class="{ disabled: action === '提交清淤' && isMissingThickness(row) }"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="tableColspan" class="empty-state">{{ emptyHint }}</td>
          </tr>
        </template>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>{{ loadState === 'ready' ? `共 ${total} 条管网清淤记录` : '记录数暂不可用' }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="creating" class="modal-mask" @click.self="closeCreate">
      <div class="modal" role="dialog" aria-modal="true" aria-label="登记清淤记录">
        <h3>登记清淤记录</h3>
        <div class="form-grid">
          <label v-for="field in formFields" :key="field.key" class="form-field">
            <span>
              {{ field.key }}
              <i v-if="field.required" class="required-mark">*</i>
              <em v-if="field.hint" class="field-hint">{{ field.hint }}</em>
            </span>
            <input
              v-model="form[field.key]"
              :type="field.type ?? 'text'"
              :placeholder="field.placeholder"
            />
          </label>
        </div>
        <p v-if="formError" class="notice error" role="alert">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交登记</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  EMPTY_DREDGE_FORM,
  listDredgeEntries,
  registerDredgeEntry,
  runDredgeAction,
  type DredgeForm,
} from '@/api/dredge-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('dredge')
const columns = ['清淤编号', '清淤管段', '淤积厚度', '清淤方式', '清淤班组', '清淤日期', '清淤量', '清淤状态']
const thicknessField = '淤积厚度'
const teamField = '清淤班组'
const actions = ['提交清淤', '确认完工', '要求返工']
const statuses = ['待清淤', '清淤中', '已完工', '需返工']
const tableColspan = columns.length + 2

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 列表读取的三态：加载中 / 失败 / 就绪。空白不再被误当成「没数据」。
const loadState = ref<'loading' | 'error' | 'ready'>('loading')

const notice = ref<{ text: string; tone: 'success' | 'error' } | null>(null)

const creating = ref(false)
const form = reactive<DredgeForm>({ ...EMPTY_DREDGE_FORM })
const formError = ref('')

const formFields: {
  key: keyof DredgeForm
  required?: boolean
  hint?: string
  type?: string
  placeholder?: string
}[] = [
  { key: '清淤编号', required: true, placeholder: '如 DRED-0004，重复编号无法再次入账' },
  { key: '清淤管段', required: true, placeholder: '填写管段编号，登记后该结论进入管段待清淤清单' },
  { key: '淤积厚度', hint: '可暂不实测，补测前不能提交清淤', placeholder: '单位 mm，未实测请留空' },
  { key: '清淤方式', placeholder: '如 绞车清淤 / 高压冲洗' },
  { key: '清淤班组', hint: '提交清淤前必须明确', placeholder: '暂未安排可留空' },
  { key: '清淤日期', type: 'date' },
  { key: '清淤量', placeholder: '单位 m³' },
]

function isBlankCell(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

function isMissingThickness(row: EntryRow): boolean {
  return isBlankCell(row[thicknessField])
}

const activeFilterPairs = computed(() =>
  Object.entries(filters.value).filter(([, value]) => value.trim() !== ''),
)

const emptyHint = computed(() => {
  if (activeFilterPairs.value.length > 0) {
    const description = activeFilterPairs.value
      .map(([field, value]) => `${field}含「${value.trim()}」`)
      .join('、')
    return `没有检索到符合条件（${description}）的清淤记录，请调整检索条件后再试`
  }
  return '暂无管网清淤数据，可先登记清淤记录'
})

const statusSummary = computed(() => {
  if (loadState.value !== 'ready') {
    return statuses.map((status) => ({ status, count: '—' }))
  }
  return statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  }))
})

function isCurrentMonth(dateValue: unknown): boolean {
  const text = String(dateValue ?? '').slice(0, 7)
  return text === new Date().toISOString().slice(0, 7)
}

// 统计卡片与状态汇总都取同一份 rows：重试成功后两处数字必然对得上。
const stats = computed(() => {
  if (loadState.value !== 'ready') {
    return [
      { label: '待清淤管段', value: '—' },
      { label: '清淤中管段', value: '—' },
      { label: '本月完工数', value: '—' },
    ]
  }
  return [
    { label: '待清淤管段', value: rows.value.filter((row) => String(row.status) === '待清淤').length },
    { label: '清淤中管段', value: rows.value.filter((row) => String(row.status) === '清淤中').length },
    {
      label: '本月完工数',
      value: rows.value.filter(
        (row) => String(row.status) === '已完工' && isCurrentMonth(row['清淤日期']),
      ).length,
    },
  ]
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  Object.assign(form, EMPTY_DREDGE_FORM)
  form.清淤日期 = new Date().toISOString().slice(0, 10)
  formError.value = ''
  creating.value = true
}

function closeCreate() {
  creating.value = false
  formError.value = ''
}

function submitCreate() {
  const result = registerDredgeEntry(form)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  closeCreate()
  notice.value = { text: result.message, tone: 'success' }
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = runDredgeAction(Number(row.id), action)
  notice.value = { text: result.message, tone: result.ok ? 'success' : 'error' }
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  loadState.value = 'loading'
  errorMessage.value = ''
  try {
    const payload = listDredgeEntries(filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadState.value = 'ready'
  } catch (error) {
    rows.value = []
    total.value = 0
    loadState.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : '管网清淤列表读取失败'
  }
}

onMounted(reload)
</script>
