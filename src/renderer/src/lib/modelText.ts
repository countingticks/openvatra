// Words and the status dot for models, used by the model button and its popover.
import type { ModelInfo } from '@renderer/core/types'

export function formatSize(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3
  if (gigabytes >= 1) return `${gigabytes.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** Classes for a model's status dot; always shown next to words, so colour is never the only signal. */
export function stateDot(state: ModelInfo['state']): string {
  switch (state) {
    case 'loading':
      // The app's motion setting (data-motion on <html>) turns the pulse off.
      return 'animate-pulse bg-primary in-data-[motion=reduce]:animate-none'
    case 'ready':
      return 'bg-success'
    case 'error':
      return 'bg-destructive'
    default:
      return 'bg-muted-foreground/40'
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
