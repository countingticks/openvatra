// Words and the status dot for models, used by the model button and its popover.
import type { ModelInfo } from '../../../shared/core'

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

/** Electron puts "Error invoking remote method '…': Error: " in front of main's message; people need only the end. */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}
