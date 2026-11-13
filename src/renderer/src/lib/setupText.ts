// Plain-language words for the welcome card and (later) the Models dialog. No technical terms: see the copy rules
// in SPEC-setup.md.
import type { DownloadItem, HardwareReport } from '@renderer/core/types'
import type { CatalogEntry } from '@renderer/core/catalogView'

const gigabytes = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

/** "NVIDIA GeForce RTX 4070 · 12 GB graphics memory · 32 GB memory", or the honest no-graphics-card version. */
export function hardwareLine(hardware: HardwareReport): string {
  const ram = `${Math.round(hardware.ramBytes / 1024 ** 3)} GB memory`
  if (!hardware.gpu) return `No dedicated graphics card found · ${ram}`
  return `${hardware.gpu.name} · ${Math.round(hardware.gpu.totalBytes / 1024 ** 3)} GB graphics memory · ${ram}`
}

export function fitText(fit: CatalogEntry['fit']): string {
  switch (fit) {
    case 'fits':
      return 'Fits your PC'
    case 'slower':
      return 'Will run, but slowly'
    case 'tooBig':
      return 'Too big for your PC'
  }
}

/** "4.1 of 5.0 GB · about 2 minutes left"; the time is left out until a speed is known. */
export function progressText(item: DownloadItem): string {
  const sizes = `${gigabytes(item.bytes)} of ${gigabytes(item.total)} GB`
  if (item.speed <= 0) return sizes
  const minutes = Math.ceil((item.total - item.bytes) / item.speed / 60)
  return `${sizes} · ${minutes <= 1 ? 'less than a minute' : `about ${minutes} minutes`} left`
}
