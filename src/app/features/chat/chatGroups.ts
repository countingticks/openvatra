import type { ChatItem } from '@app/core/generated'

export type ChatGroupId = 'today' | 'week' | 'older'
export const chatGroupIds: readonly ChatGroupId[] = ['today', 'week', 'older']

export interface ChatGroup {
  id: ChatGroupId
  label: string
  chats: ChatItem[]
}

const labels: Record<ChatGroupId, string> = { today: 'Today', week: 'Previous 7 days', older: 'Older' }

/**
 * Splits the list by updatedAt in local time; empty groups left out; chats keep their order.
 * Calendar days, not 24 h blocks, so a DST change moves no chat.
 */
export function groupChats(chats: readonly ChatItem[], now: number): ChatGroup[] {
  const d = new Date(now)
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const startOfWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7).getTime()
  const buckets: Record<ChatGroupId, ChatItem[]> = { today: [], week: [], older: [] }
  for (const chat of chats) {
    const id: ChatGroupId =
      chat.updatedAt >= startOfToday ? 'today' : chat.updatedAt >= startOfWeek ? 'week' : 'older'
    buckets[id].push(chat)
  }
  return chatGroupIds
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({ id, label: labels[id], chats: buckets[id] }))
}

/** Unix ms of the next local midnight after `now`. */
export function nextLocalMidnight(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}
