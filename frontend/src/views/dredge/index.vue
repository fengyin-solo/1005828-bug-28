<template>
  <section class="page" data-module="dredge">
    <header class="page-head">
      <div>
        <h2>管网清淤管理</h2>
        <p class="page-desc">维护清淤记录，围绕清淤编号、清淤管段、淤积厚度、清淤方式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="loading" @click="openCreate">登记清淤记录</button>
        <button class="btn" type="button" :disabled="loading" @click="exportRows">导出管网清淤清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ dataReady ? item.value : '—' }}</strong>
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

    <!-- 读取中：明确告诉用户数据正在加载，不再是一片空白说不清是没数据还是没出来。 -->
    <div v-if="loading" class="state-panel state-loading">
      <span class="state-spinner" aria-hidden="true"></span>
      管网清淤数据加载中…
    </div>

    <!-- 读取失败：给出失败原因与重试，不把失败伪装成空列表。 -->
    <div v-else-if="loadError" class="state-panel state-error">
      <div class="state-main">
        <strong>管网清淤数据读取失败</strong>
        <span>{{ loadError }}</span>
      </div>
      <div class="state-actions">
        <button class="btn primary" type="button" @click="reload">重试</button>
        <button v-if="canRepair" class="btn" type="button" @click="repairAndReload">修复本地数据并重载</button>
      </div>
    </div>

    <template v-else>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td
              v-for="column in columns"
              :key="column"
              :class="{ 'cell-missing': isMissingCell(row, column) }"
            >
              <template v-if="isMissingCell(row, column)">
                <span class="missing-tag">{{ missingCellLabel(column) }}</span>
                <span class="missing-hint">缺{{ column }}，补录后才能提交</span>
              </template>
              <template v-else-if="isBlankCell(row, column)">
                <span class="blank-cell">—</span>
              </template>
              <template v-else>{{ row[column] }}</template>
            </td>
            <td>
              {{ row.status }}
              <span
                v-if="blockedRowIds.has(Number(row.id))"
                class="row-flag"
                :title="blockedRowIds.get(Number(row.id))"
              >资料不全</span>
            </td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <!-- 区分三种空：带检索条件查不到 / 模块本身一条数据都没有。 -->
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">
              <template v-if="hasActiveFilters">
                没有检索到符合条件的清淤记录（{{ activeFilterText }}），可调整或
                <button class="link" type="button" @click="resetFilters">清空检索条件</button>
                后重试
              </template>
              <template v-else>暂无管网清淤数据，可先登记清淤记录</template>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条管网清淤记录
        <button v-if="!loading && !loadError" class="link link-minor" type="button" @click="simulateReadFailure">
          模拟读取失败
        </button>
      </span>
      <span v-if="notice" class="notice-text" :class="{ 'error-text': noticeType === 'error', 'warn-text': noticeType === 'warning' }">
        {{ notice }}
      </span>
    </footer>

    <!-- 登记清淤记录：缺哪一格就在哪一格下面说明，提交不过不会有任何静默丢失。 -->
    <div v-if="creating" class="modal-mask" @click.self="closeCreate">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dredge-create-title">
        <h3 id="dredge-create-title">登记清淤记录</h3>
        <p class="modal-tip">淤积厚度需现场实测后录入；清淤编号重复报送不会重复入账。</p>
        <div class="form-grid">
          <label v-for="field in formFields" :key="field" class="form-field">
            <span>{{ field }}<i v-if="requiredFields.includes(field)" class="required-mark">*</i></span>
            <input
              v-model="form[field]"
              :placeholder="fieldPlaceholder(field)"
              :class="{ 'input-error': formErrors[field] }"
              @keyup.enter="submitCreate"
            />
            <small v-if="formErrors[field]" class="field-error">{{ formErrors[field] }}</small>
          </label>
        </div>
        <p v-if="createError" class="error-text form-banner">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="button" :disabled="submitting" @click="submitCreate">
            {{ submitting ? '提交中…' : '提交登记' }}
          </button>
          <button class="btn ghost" type="button" :disabled="submitting" @click="closeCreate">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createDredgeEntry,
  downloadEntries,
  failNextRead,
  isBlankValue,
  listEntriesAsync,
  missingDredgeFields,
  moduleMeta,
  repairStorage,
  runAction as applyAction,
  StorageReadError,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('dredge')
const columns = ["清淤编号", "清淤管段", "淤积厚度", "清淤方式", "清淤班组", "清淤日期", "清淤量", "清淤状态"]
const actions = ["提交清淤", "确认完工", "要求返工"]
const statuses = ["待清淤", "清淤中", "已完工", "需返工"]
const formFields = ["清淤编号", "清淤管段", "淤积厚度", "清淤方式", "清淤班组", "清淤日期", "清淤量"]
const requiredFields = ["清淤编号", "清淤管段", "淤积厚度", "清淤方式", "清淤班组", "清淤日期"]
// 没有实测淤积厚度 / 未落实清淤班组时，需要在列表里点明的两格。
const submitRequiredFields = ["淤积厚度", "清淤班组"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const canRepair = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const notice = ref('')
const noticeType = ref<'info' | 'error' | 'warning'>('info')
let noticeTimer: number | undefined

const creating = ref(false)
const submitting = ref(false)
const createError = ref('')
const form = reactive<Record<string, string>>(
  Object.fromEntries(formFields.map((field) => [field, ''])),
)
const formErrors = reactive<Record<string, string>>({})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const hasActiveFilters = computed(() =>
  Object.values(filters.value).some((value) => value.trim() !== ''),
)

// 数据没读出来时统计一律显示 —，不用 0 冒充「真的没有」。
const dataReady = computed(() => !loading.value && !loadError.value)

const activeFilterText = computed(() =>
  Object.entries(filters.value)
    .filter(([, value]) => value.trim() !== '')
    .map(([field, value]) => `${field}含“${value.trim()}”`)
    .join('，'),
)

// 每条记录缺哪几格、为什么不能提交，列表与动作校验共用同一份结论。
const missingByRow = computed(() => {
  const map = new Map<number, string[]>()
  for (const row of rows.value) {
    const missing = missingDredgeFields(row, submitRequiredFields)
    if (missing.length > 0) {
      map.set(Number(row.id), missing)
    }
  }
  return map
})

const blockedRowIds = computed(
  () =>
    new Map(
      [...missingByRow.value.entries()].map(([id, missing]) => [
        id,
        `缺少${missing.join('、')}，需补录后才能提交清淤`,
      ]),
    ),
)

const stats = computed(() => [
  {
    label: '待清淤管段',
    value: rows.value.filter((row) => String(row.status) === '待清淤').length,
  },
  {
    label: '清淤中管段',
    value: rows.value.filter((row) => String(row.status) === '清淤中').length,
  },
  {
    label: '本月完工数',
    value: rows.value.filter((row) => isFinishedThisMonth(row)).length,
  },
])

function isFinishedThisMonth(row: EntryRow): boolean {
  if (String(row.status) !== '已完工') {
    return false
  }
  const date = String(row['清淤日期'] ?? '')
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return date.startsWith(month)
}

function isBlankCell(row: EntryRow, column: string): boolean {
  return isBlankValue(row[column])
}

function isMissingCell(row: EntryRow, column: string): boolean {
  return submitRequiredFields.includes(column) && isBlankValue(row[column])
}

function missingCellLabel(column: string): string {
  return column === '淤积厚度' ? '未实测' : '未填写'
}

function setNotice(message: string, type: 'info' | 'error' | 'warning' = 'info') {
  notice.value = message
  noticeType.value = type
  window.clearTimeout(noticeTimer)
  if (type === 'info') {
    noticeTimer = window.setTimeout(() => {
      notice.value = ''
    }, 6000)
  }
}

async function reload() {
  loading.value = true
  loadError.value = ''
  canRepair.value = false
  try {
    // 异步读法：失败会抛出，页面进入失败态；成功后统计、状态汇总与表格都来自同一份数据。
    const payload = await listEntriesAsync(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    rows.value = []
    total.value = 0
    loadError.value = error instanceof Error ? error.message : '管网清淤列表读取失败，请稍后重试'
    canRepair.value = error instanceof StorageReadError && error.recoverable
  } finally {
    loading.value = false
  }
}

function repairAndReload() {
  repairStorage()
  reload()
}

function simulateReadFailure() {
  failNextRead()
  setNotice('已制造一次读取故障，正在重新加载以演示失败提示与重试', 'warning')
  reload()
}

function resetFilters() {
  for (const key of Object.keys(filters.value)) {
    filters.value[key] = ''
  }
  reload()
}

function exportRows() {
  try {
    downloadEntries(meta.key)
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '清淤清单导出失败', 'error')
  }
}

function fieldPlaceholder(field: string): string {
  if (field === '淤积厚度') {
    return '实测厚度，如 12cm'
  }
  if (field === '清淤日期') {
    return 'YYYY-MM-DD'
  }
  return `请填写${field}`
}

function openCreate() {
  creating.value = true
  createError.value = ''
  for (const field of formFields) {
    form[field] = ''
    formErrors[field] = ''
  }
}

function closeCreate() {
  if (submitting.value) {
    return
  }
  creating.value = false
}

async function submitCreate() {
  createError.value = ''
  for (const field of Object.keys(formErrors)) {
    formErrors[field] = ''
  }
  submitting.value = true
  // 与后端同一节奏：登记是一次异步提交，期间锁住按钮，避免重复点击造成重复报送。
  await new Promise((resolve) => {
    window.setTimeout(resolve, 200)
  })
  const result = createDredgeEntry({ ...form })
  submitting.value = false
  if (!result.ok) {
    createError.value = result.message
    if (result.fieldErrors) {
      for (const [field, message] of Object.entries(result.fieldErrors)) {
        formErrors[field] = message
      }
    }
    return
  }
  creating.value = false
  setNotice(result.warning ?? result.message, result.warning ? 'warning' : 'info')
  await reload()
}

async function runAction(action: string, row: EntryRow) {
  const missing = missingDredgeFields(row, submitRequiredFields)
  // 淤积厚度缺失时在提交这一步挡住：页面先把话说明白，服务端还会再校验一次。
  if (action === '提交清淤' && missing.length > 0) {
    setNotice(
      `清淤记录「${row['清淤编号'] || row.id}」无法提交：缺少${missing.join('、')}，请补录后再提交，本次未保存`,
      'error',
    )
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    setNotice(result.message, 'error')
    return
  }
  setNotice(result.warning ?? result.message, result.warning ? 'warning' : 'info')
  await reload()
}

onMounted(reload)
</script>
