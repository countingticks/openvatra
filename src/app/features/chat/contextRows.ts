import type { ContextUse } from '@app/core/generated'

export interface ContextRow {
  key: 'system' | 'messages' | 'search' | 'files' | 'free'
  label: string // "System prompt", "Messages (12)", "Web search results", "Attached files", "Free"
  tokens: number
}

/**
 * The popover's rows, in order; search and files only when above 0 (decision 7). Messages is what is left of `used`
 * after the other parts (decision 11): `used` follows the run events, the parts only come with a snapshot.
 */
export function contextRows({ used, size, parts }: ContextUse): ContextRow[] {
  const rows: ContextRow[] = [
    { key: 'system', label: 'System prompt', tokens: parts.system },
    {
      key: 'messages',
      label: `Messages (${parts.messageCount})`,
      tokens: Math.max(0, used - parts.system - parts.search - parts.files)
    }
  ]
  if (parts.search > 0) rows.push({ key: 'search', label: 'Web search results', tokens: parts.search })
  if (parts.files > 0) rows.push({ key: 'files', label: 'Attached files', tokens: parts.files })
  rows.push({ key: 'free', label: 'Free', tokens: Math.max(0, size - used) })
  return rows
}
