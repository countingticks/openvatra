// The window's view of core's catalog: GET /api/catalog carries each entry's files, the UI only needs the total size.

const fitLabels = ['fits', 'slower', 'tooBig'] as const

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
