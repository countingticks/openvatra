// The app's tabs in sidebar order. Their position also gives the shortcut: the first is Ctrl+1, and so on.
import { Code, MessageSquare, Zap, type LucideIcon } from 'lucide-react'
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
  automations: { label: 'Automations', icon: Zap }
}

/** The sidebar panel's element id, for aria-controls on the buttons that open and close it. */
export const sidebarId = 'sidebar'
export const sidebarShortcut = 'Control+B'
/** Opens the Settings dialog (gear at the sidebar's bottom, File → Settings…). */
export const settingsShortcut = 'Control+Comma'

export const tabs: readonly Tab[] = tabIds.map((id, index) => ({
  id,
  ...details[id],
  shortcut: `Control+${index + 1}`
}))
