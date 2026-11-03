// Words about models, shared by the Settings model list and the model button's popover.
import type { ModelInfo } from '../../../shared/core'

export function formatSize(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3
  if (gigabytes >= 1) return `${gigabytes.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

export function describeModel(model: ModelInfo): string {
  switch (model.state) {
    case 'loading':
      return 'Loading…'
    case 'ready':
      return model.busy ? 'Loaded, answering' : 'Loaded'
    case 'error':
      return `Problem: ${model.error ?? 'it could not be loaded'}`
    default:
      return 'Not loaded'
  }
}

/** Electron puts "Error invoking remote method '…': Error: " in front of main's message; people need only the end. */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}
