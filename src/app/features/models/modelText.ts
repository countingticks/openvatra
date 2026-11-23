// Words and the status dot for models, used by the model button and its popover.
import type { Choice } from '@app/core/generated'
import type { ModelInfo } from '@app/core/types'

export function formatSize(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3
  if (gigabytes >= 1) return `${gigabytes.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** A context size in tokens: 32768 → "32K"; a size that is not a multiple of 1024 keeps its digits. */
export function formatContext(tokens: number): string {
  return tokens % 1024 === 0 ? `${tokens / 1024}K` : tokens.toLocaleString('en-US')
}

export const contextMin = 2048
export const contextMax = 1048576

/** A context size typed by the user: a whole number inside the allowed range, or undefined. */
export function parseContext(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined
  const size = Number(text)
  return size >= contextMin && size <= contextMax ? size : undefined
}

/** What a context size and placement would mean for this PC, as one line for the options of a model. */
export function fitHint(choice: Choice, gpuTotalBytes: number | null): string {
  let line = fitLine(choice, gpuTotalBytes)
  if (choice.fit === 'unknown') return line
  const { gpuExpertLayers = 0, expertLayers = 0 } = choice
  if (choice.placement === 'experts' && gpuExpertLayers > 0 && expertLayers > 0) {
    line += ` · ${gpuExpertLayers} of ${expertLayers} expert layers on the GPU`
  }
  const measured = choice.source === 'measured' ? ' · measured' : ''
  const tokens = Math.max(1, Math.round(choice.tokensPerSecond))
  const speed =
    choice.tokensPerSecond > 0 ? ` · about ${tokens} ${tokens === 1 ? 'token' : 'tokens'} per second` : ''
  return line + measured + speed
}

function fitLine(choice: Choice, gpuTotalBytes: number | null): string {
  const prefix = `${formatContext(choice.context)} tokens${choice.capped ? " (the model's maximum)" : ''}`
  const vram = formatSize(choice.vramBytes)
  const ram = formatSize(choice.ramBytes)
  switch (choice.fit) {
    case 'fits':
      return `${prefix} · fits on your GPU (${gpuTotalBytes === null ? vram : `${vram} of ${formatSize(gpuTotalBytes)}`})`
    case 'slower':
      if (choice.placement === 'experts')
        return `${prefix} · experts in RAM: slower · ${vram} GPU, ${ram} RAM`
      if (choice.placement === 'layers') {
        return `${prefix} · ${choice.layers} layers on the GPU: slower · ${vram} GPU, ${ram} RAM`
      }
      return `${prefix} · CPU only: slower · ${ram} RAM`
    case 'tooBig':
      return `${prefix} · too big for this PC · needs ${choice.placement === 'cpu' ? `${ram} RAM` : `${vram} GPU, ${ram} RAM`}`
    case 'unknown':
      return `${prefix} · memory use can't be estimated for this model`
  }
}

/** "Q4_K_M · 8.1 GB · 32k context"; unknown parts (no quant, no context choice) are left out. */
export function modelDetail(model: ModelInfo): string {
  const parts: string[] = []
  if (model.quant) parts.push(model.quant)
  parts.push(formatSize(model.sizeBytes))
  if (model.context) {
    const { context } = model.context
    parts.push(`${context % 1024 === 0 ? `${context / 1024}k` : context.toLocaleString('en-US')} context`)
  }
  return parts.join(' · ')
}

/**
 * Classes for a model's dot (decision 13): ready = brand; loading = pulsing brand; error = destructive; else a
 * hollow ring. Always shown next to words, so colour is never the only signal.
 */
export function stateDot(state: ModelInfo['state']): string {
  switch (state) {
    case 'loading':
      // The app's motion setting (data-motion on <html>) turns the pulse off.
      return 'animate-pulse bg-brand in-data-[motion=reduce]:animate-none'
    case 'ready':
      return 'bg-brand'
    case 'error':
      return 'bg-destructive'
    default:
      return 'ring-[1.5px] ring-inset ring-muted-foreground'
  }
}

const unreachable = new Set(['FETCH_ERROR', 'TIMEOUT_ERROR', 'PARSING_ERROR'])

/** A CoreQueryError's sentence, or null when the error is not one. */
function coreReason(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null
  const { status } = error as { status: unknown }
  if (typeof status === 'number') {
    const { data } = error as { data?: { message?: unknown } }
    return typeof data?.message === 'string' ? data.message : null
  }
  if (status === 'CORE_UNAVAILABLE') return 'The models service is not running'
  if (typeof status === 'string' && unreachable.has(status)) return 'Could not reach the models service'
  return null
}

/** A short sentence for a failed action: core's message, an IPC error's text, or a fixed one. */
export function failureReason(error: unknown): string {
  const fromCore = coreReason(error)
  if (fromCore !== null) return fromCore
  // Electron puts "Error invoking remote method '…': Error: " in front of main's message; people need only the end.
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}
