import { useEffect, useRef, useState } from 'react'
import { Menu } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { useAltMenu, type MenuName } from '@renderer/hooks/useAltMenu'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import {
  selectActiveTab,
  selectCanGoBack,
  selectCanGoForward,
  sidebarToggled,
  settingsOpened,
  tabSelected,
  wentBack,
  wentForward
} from '@renderer/store/uiSlice'
import { tabs } from '@renderer/tabs'
import type { EditCommand } from '../../../shared/ipc'

const menus: readonly MenuName[] = ['File', 'Edit', 'View', 'Go', 'Help']

const editItems: readonly (readonly [EditCommand, string, string] | 'separator')[] = [
  ['undo', 'Undo', 'Ctrl+Z'],
  ['redo', 'Redo', 'Ctrl+Y'],
  'separator',
  ['cut', 'Cut', 'Ctrl+X'],
  ['copy', 'Copy', 'Ctrl+C'],
  ['paste', 'Paste', 'Ctrl+V'],
  ['selectAll', 'Select all', 'Ctrl+A']
]

/** A failed menu action has nothing useful to show; log it (main copies page errors into main.log). */
function run(action: () => Promise<void>): void {
  action().catch((error) => console.error('Menu action failed', error))
}

/** "File" with its access key underlined: Alt+F opens it, as in any Windows app. */
function AccessKey({ label }: { label: string }): React.JSX.Element {
  return (
    <span>
      <span className="underline underline-offset-2">{label[0]}</span>
      {label.slice(1)}
    </span>
  )
}

/** The ≡ app menu in the title bar: File, Edit, View, Go and Help, each a submenu. */
export function AppMenu(): React.JSX.Element {
  const dispatch = useAppDispatch()
  const activeTab = useAppSelector(selectActiveTab)
  const canGoBack = useAppSelector(selectCanGoBack)
  const canGoForward = useAppSelector(selectCanGoForward)
  const [open, setOpen] = useState(false)
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null)
  // The element that had focus before the menu: Edit commands act on it, and focus returns to it on close.
  const lastFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    function remember(event: FocusEvent): void {
      const target = event.target
      if (target instanceof HTMLElement && !target.closest('[data-app-menu]')) lastFocused.current = target
    }
    document.addEventListener('focusin', remember)
    return () => document.removeEventListener('focusin', remember)
  }, [])

  useAltMenu((menu) => {
    setOpen(true)
    setOpenMenu(menu ?? null)
  })

  function onOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) setOpenMenu(null)
  }

  function edit(command: EditCommand): void {
    const send = (): void => run(() => window.api.appWindow.edit(command))
    const target = lastFocused.current
    if (!target?.isConnected) return send()
    // Chromium runs the command on whatever is focused when it arrives. Closing the menu first drops focus to the
    // page, then hands it back to the field (finalFocus), so wait for that before sending; if focus never comes
    // back, put it there ourselves.
    const fallback = setTimeout(() => {
      target.removeEventListener('focus', onFocus)
      target.focus()
      send()
    }, 400)
    function onFocus(): void {
      clearTimeout(fallback)
      target?.removeEventListener('focus', onFocus)
      send()
    }
    target.addEventListener('focus', onFocus)
  }

  const submenu = (name: MenuName): { open: boolean; onOpenChange: (next: boolean) => void } => ({
    open: openMenu === name,
    onOpenChange: (next) => setOpenMenu(next ? name : null)
  })
  // Submenus open on hover and close 250 ms after the pointer leaves, so cutting a corner toward one doesn't.
  const trigger = { openOnHover: true, delay: 0, closeDelay: 250 } as const

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        // Marked like the menu itself, so focusing the ≡ button doesn't count as "the field to return to".
        data-app-menu
        aria-label="Menu"
        title="Menu (Alt)"
        className="grid size-8 place-items-center rounded-sm text-muted-foreground outline-none [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <Menu aria-hidden className="size-[18px]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-app-menu
        aria-label="Menu"
        className="w-40"
        finalFocus={() => (lastFocused.current?.isConnected ? lastFocused.current : true)}
      >
        {menus.map((name) => (
          <DropdownMenuSub key={name} {...submenu(name)}>
            <DropdownMenuSubTrigger {...trigger}>
              <AccessKey label={name} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-app-menu aria-label={name} className="min-w-56">
              {name === 'File' && (
                <>
                  <DropdownMenuItem disabled>
                    New chat <DropdownMenuShortcut>Ctrl+N</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => dispatch(settingsOpened())}>
                    Settings… <DropdownMenuShortcut>Ctrl+,</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => run(window.api.appWindow.close)}>
                    Close window <DropdownMenuShortcut>Ctrl+W</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => run(window.api.app.quit)}>
                    Quit OpenVatra <DropdownMenuShortcut>Ctrl+Q</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </>
              )}
              {name === 'Edit' &&
                editItems.map((item, index) =>
                  item === 'separator' ? (
                    <DropdownMenuSeparator key={index} />
                  ) : (
                    <DropdownMenuItem key={item[0]} onClick={() => edit(item[0])}>
                      {item[1]} <DropdownMenuShortcut>{item[2]}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  )
                )}
              {name === 'View' && (
                <>
                  <DropdownMenuItem onClick={() => dispatch(sidebarToggled())}>
                    Toggle sidebar <DropdownMenuShortcut>Ctrl+B</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup value={activeTab}>
                    {tabs.map((tab) => (
                      <DropdownMenuRadioItem
                        key={tab.id}
                        value={tab.id}
                        onClick={() => dispatch(tabSelected(tab.id))}
                      >
                        {tab.label}{' '}
                        <DropdownMenuShortcut>{tab.shortcut.replace('Control', 'Ctrl')}</DropdownMenuShortcut>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
              {name === 'Go' && (
                <>
                  <DropdownMenuItem disabled={!canGoBack} onClick={() => dispatch(wentBack())}>
                    Back <DropdownMenuShortcut>Alt+←</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!canGoForward} onClick={() => dispatch(wentForward())}>
                    Forward <DropdownMenuShortcut>Alt+→</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </>
              )}
              {name === 'Help' && (
                <>
                  <DropdownMenuItem onClick={() => run(() => window.api.files.openFolder('logs'))}>
                    Open logs folder
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled>About OpenVatra</DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
