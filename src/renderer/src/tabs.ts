// The app's tabs in sidebar order. Their position also gives the shortcut: the first is Ctrl+1, and so on.
import { Code, MessageSquare, SlidersHorizontal, Zap, type LucideIcon } from 'lucide-react'
import { tabIds, type TabId } from '../../shared/settings'

export interface Tab {
  id: TabId
  label: string
  icon: LucideIcon
  /** For aria-keyshortcuts and tooltips; the hint isn't printed in the sidebar (design decision). */
  shortcut: string
}

const details: Record<TabId, { label: string; icon: LucideIcon }> = {
  chat: { label: 'Chat', icon: MessageSquare },
  code: { label: 'Code', icon: Code },
  automations: { label: 'Automations', icon: Zap },
  settings: { label: 'Settings', icon: SlidersHorizontal }
}

export const tabs: readonly Tab[] = tabIds.map((id, index) => ({
  id,
  ...details[id],
  shortcut: `Control+${index + 1}`
}))
