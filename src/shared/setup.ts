// What the UI may know about model setup: the PC's hardware, the download catalog and the download queue.
// These are core's JSON answers (core/internal/hw, catalog, downloads), checked where they cross a process boundary.

export interface Gpu {
  name: string
  /** 'nvidia' | 'amd' | 'intel' | 'other', as core labels it. */
  vendor: string
  totalBytes: number
  freeBytes: number
}

export interface HardwareReport {
  gpu: Gpu | null
  ramBytes: number
  error?: string
}

export const fitLabels = ['fits', 'slower', 'tooBig'] as const

export interface CatalogEntry {
  id: string
  name: string
  summary: string
  tags: string[]
  licence: string
  /** Total download size: the sum of the entry's files. */
  sizeBytes: number
  needsGB: number
  rank: number
  fit: (typeof fitLabels)[number]
  installed: boolean
  /** Space missing to download it; 0 when it fits or is unknown. */
  diskShortBytes: number
}

export interface CatalogView {
  entries: CatalogEntry[]
  /** Free space where models are saved; null when unknown. */
  diskFreeBytes: number | null
  /** The catalog id to offer first; null when no chat model fits even slowly. */
  recommended: string | null
}

export const downloadStates = ['queued', 'downloading', 'verifying', 'paused', 'error', 'done'] as const

export interface DownloadItem {
  id: string
  state: (typeof downloadStates)[number]
  bytes: number
  total: number
  /** Bytes per second. */
  speed: number
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDownloadItem(value: unknown): value is DownloadItem {
  if (!isRecord(value)) return false
  const { id, state, bytes, total, speed, error } = value
  return (
    typeof id === 'string' &&
    downloadStates.includes(state as DownloadItem['state']) &&
    typeof bytes === 'number' &&
    typeof total === 'number' &&
    typeof speed === 'number' &&
    (error === undefined || typeof error === 'string')
  )
}

/** Checks a download queue that crossed a process boundary (core → main → UI). */
export function isDownloadList(value: unknown): value is DownloadItem[] {
  return Array.isArray(value) && value.every(isDownloadItem)
}

export function isHardwareReport(value: unknown): value is HardwareReport {
  if (!isRecord(value) || typeof value['ramBytes'] !== 'number') return false
  const gpu = value['gpu']
  if (gpu === null) return true
  return (
    isRecord(gpu) &&
    typeof gpu['name'] === 'string' &&
    typeof gpu['vendor'] === 'string' &&
    typeof gpu['totalBytes'] === 'number' &&
    typeof gpu['freeBytes'] === 'number'
  )
}

/** core's catalog entries carry their files; the UI only needs the total, so this turns one into a CatalogEntry. */
function toCatalogEntry(value: unknown): CatalogEntry | null {
  if (!isRecord(value)) return null
  const { id, name, summary, tags, licence, files, needsGB, rank, fit, installed, diskShortBytes } = value
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof summary !== 'string' ||
    !Array.isArray(tags) ||
    !tags.every((tag) => typeof tag === 'string') ||
    typeof licence !== 'string' ||
    !Array.isArray(files) ||
    typeof needsGB !== 'number' ||
    typeof rank !== 'number' ||
    !fitLabels.includes(fit as CatalogEntry['fit']) ||
    typeof installed !== 'boolean' ||
    typeof diskShortBytes !== 'number'
  )
    return null
  let sizeBytes = 0
  for (const file of files) {
    if (!isRecord(file) || typeof file['sizeBytes'] !== 'number') return null
    sizeBytes += file['sizeBytes']
  }
  return {
    id,
    name,
    summary,
    tags: tags as string[],
    licence,
    sizeBytes,
    needsGB,
    rank,
    fit: fit as CatalogEntry['fit'],
    installed,
    diskShortBytes
  }
}

/** Reads GET /api/catalog; null if it isn't the shape we expect. Also drops core's repo and file details. */
export function parseCatalogView(value: unknown): CatalogView | null {
  if (!isRecord(value) || !Array.isArray(value['entries'])) return null
  const entries = value['entries'].map(toCatalogEntry)
  const { diskFreeBytes, recommended } = value
  if (
    entries.some((entry) => entry === null) ||
    !(diskFreeBytes === null || typeof diskFreeBytes === 'number') ||
    !(recommended === null || typeof recommended === 'string')
  )
    return null
  return { entries: entries as CatalogEntry[], diskFreeBytes, recommended }
}
