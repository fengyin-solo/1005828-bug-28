<template>
  <section class="page" data-module="drainpipe">
    <header class="page-head">
      <div>
        <h2>排水管网管理</h2>
        <p class="page-desc">维护排水管段，围绕管段编号、起点井号、终点井号、管径做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="loading" @click="openCreate">登记排水管段</button>
        <button class="btn" type="button" :disabled="loading" @click="exportRows">导出排水管网清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ dataReady ? item.value : '—' }}</strong>
      </article>
    </div>

    <!-- 清淤结论落到这里：管段的待清淤清单，与管网清淤页同源，数字两边对得上。 -->
    <section class="sub-panel">
      <h3 class="sub-title">待清淤清单（源自管网清淤记录）</h3>
      <p v-if="loading" class="state-inline">清淤结论加载中…</p>
      <p v-else-if="loadError" class="state-inline error-text">清淤结论暂时读取失败，可在下方重试</p>
      <table v-else-if="pendingList.length" class="data-table data-table-sm">
        <thead>
          <tr>
            <th>管段编号</th>
            <th>清淤编号</th>
            <th>清淤状态</th>
            <th>淤积厚度</th>
            <th>清淤班组</th>
            <th>清淤日期</th>
            <th>台账核对</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in pendingList" :key="item.pipeCode">
            <td>{{ item.pipeCode }}</td>
            <td>{{ item.dredgeNo }}</td>
            <td>{{ item.status }}</td>
            <td>
              <span v-if="!item.thickness" class="missing-tag">未实测</span>
              <template v-else>{{ item.thickness }}</template>
            </td>
            <td>
              <span v-if="!item.crew" class="missing-tag">未落实</span>
              <template v-else>{{ item.crew }}</template>
            </td>
            <td>{{ item.date || '—' }}</td>
            <td>
              <span v-if="item.knownPipe" class="ok-text">已匹配管段台账</span>
              <span v-else class="warn-text">台账中无此管段，历史记录保留</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="state-inline">当前没有待清淤管段：清淤完工并确认后，管段会自动回到「运行正常」</p>
    </section>

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

    <div v-if="loading" class="state-panel state-loading">
      <span class="state-spinner" aria-hidden="true"></span>
      排水管网数据加载中…
    </div>

    <div v-else-if="loadError" class="state-panel state-error">
      <div class="state-main">
        <strong>排水管网数据读取失败</strong>
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
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>{{ row.status }}</td>
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
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">
              <template v-if="hasActiveFilters">
                没有检索到符合条件的排水管段（{{ activeFilterText }}），可调整或
                <button class="link" type="button" @click="resetFilters">清空检索条件</button>
                后重试
              </template>
              <template v-else>暂无排水管网数据，可先登记排水管段</template>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <footer class="page-foot">
      <span>共 {{ total }} 条排水管段记录</span>
      <span v-if="notice" class="error-text">{{ notice }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntriesAsync,
  moduleMeta,
  pendingDredgeList,
  repairStorage,
  runAction as applyAction,
  StorageReadError,
} from '@/api/local-service'
import type { EntryRow, PendingDredgeItem } from '@/data/types'

const meta = moduleMeta('drainpipe')
const columns = ["管段编号", "起点井号", "终点井号", "管径", "埋深", "管材", "敷设日期", "管段状态"]
const actions = ["完成巡线", "安排清淤", "报废管段"]
const statuses = ["待巡线", "运行正常", "待清淤", "已废弃"]

const rows = ref<EntryRow[]>([])
const pendingList = ref<PendingDredgeItem[]>([])
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const canRepair = ref(false)
const notice = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
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

// 统计直接数表格同源的 rows：加载失败时不再显示 0 误导人；
// 待清淤数以台账里真实存在、且有未完工清淤结论的管段为准，历史脏数据在清单里单列但不计入。
const stats = computed(() => [
  {
    label: '运行正常管段',
    value: rows.value.filter((row) => String(row.status) === '运行正常').length,
  },
  {
    label: '待清淤管段',
    value: rows.value.filter((row) => String(row.status) === '待清淤').length,
  },
  {
    label: '待巡线管段',
    value: rows.value.filter((row) => String(row.status) === '待巡线').length,
  },
])

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
    notice.value = error instanceof Error ? error.message : '排水管网清单导出失败'
  }
}

function openCreate() {
  notice.value = '排水管段登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  notice.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    notice.value = result.message
    return
  }
  await reload()
}

async function reload() {
  loading.value = true
  loadError.value = ''
  canRepair.value = false
  try {
    const payload = await listEntriesAsync(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 待清淤清单与管段状态在读取时一并对齐，重试后两处数字一致。
    pendingList.value = pendingDredgeList()
  } catch (error) {
    rows.value = []
    pendingList.value = []
    total.value = 0
    loadError.value = error instanceof Error ? error.message : '排水管网列表读取失败，请稍后重试'
    canRepair.value = error instanceof StorageReadError && error.recoverable
  } finally {
    loading.value = false
  }
}

function repairAndReload() {
  repairStorage()
  reload()
}

onMounted(reload)
</script>
