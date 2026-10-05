import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'drainage-pump:entries'
// 一次性故障开关：置上后下一次读取必然失败，用来自测「读取失败 + 重试」这条路，触发一次后自动清掉。
export const FAIL_NEXT_READ_KEY = 'drainage-pump:fail-next-read'

/** 读取失败：recoverable 表示本地缓存还能修复（比如数据被写坏），页面可以提供「修复并重试」。 */
export class StorageReadError extends Error {
  recoverable: boolean
  constructor(message: string, recoverable = false) {
    super(message)
    this.name = 'StorageReadError'
    this.recoverable = recoverable
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 下一次读取强制失败（仅触发一次）。给页面上的故障演示和重试联调用。 */
export function failNextRead(): void {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    window.sessionStorage.setItem(FAIL_NEXT_READ_KEY, '1')
  }
}

/** 丢弃缓存并强制下一次访问重新从 localStorage 读取（供测试与异常恢复使用）。 */
export function invalidateCache(): void {
  cache = null
}

/** 丢弃写坏的本地缓存，重新播种示例数据；修复后页面再走一次读取即可恢复。 */
export function repairStorage(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clone(SEED_ROWS)))
  }
  if (typeof window !== 'undefined' && window.sessionStorage) {
    window.sessionStorage.removeItem(FAIL_NEXT_READ_KEY)
  }
  cache = null
}

function seedStorage(): Record<string, EntryRow[]> {
  const seeded = clone(SEED_ROWS)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
  }
  return seeded
}

/**
 * 已落库的历史记录一律保持当时取值，只按 id 补进后续新增的示例记录，
 * 这样既有清淤记录不会被新数据覆盖，老浏览器里也能看到新补的样例。
 */
function mergeSeed(stored: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  let added = false
  const merged: Record<string, EntryRow[]> = clone(stored)
  for (const [key, seedRows] of Object.entries(SEED_ROWS)) {
    const existing = new Map((merged[key] ?? []).map((row) => [Number(row.id), true]))
    const additions = seedRows.filter((row) => !existing.has(Number(row.id)))
    if (additions.length) {
      merged[key] = [...(merged[key] ?? []), ...clone(additions)]
      added = true
    }
  }
  // 顺手落库：否则别的模块 saveRows 时可能把只在内存里的新样例丢掉。
  if (added && typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  }
  return merged
}

function readStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(SEED_ROWS)
  }
  if (window.sessionStorage && window.sessionStorage.getItem(FAIL_NEXT_READ_KEY) === '1') {
    // 只失败一次：清掉开关并丢弃内存缓存，随后的重试就会重新读真实数据。
    window.sessionStorage.removeItem(FAIL_NEXT_READ_KEY)
    cache = null
    throw new StorageReadError('管网清淤数据读取失败（模拟故障：本地存储暂时不可用）')
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return seedStorage()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 缓存被写坏时不静默吞掉：明确告诉用户读取失败，由页面决定重试还是修复。
    throw new StorageReadError('管网清淤数据读取失败：本地数据已损坏，可修复后重新载入', true)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StorageReadError('管网清淤数据读取失败：本地数据结构不正确，可修复后重新载入', true)
  }
  return mergeSeed(parsed as Record<string, EntryRow[]>)
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  // 挂着「下一次读取失败」开关时不能直接用缓存，否则故障永远触发不了、重试也无从谈起。
  const failArmed =
    typeof window !== 'undefined'
    && !!window.sessionStorage
    && window.sessionStorage.getItem(FAIL_NEXT_READ_KEY) === '1'
  if (cache === null || failArmed) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
