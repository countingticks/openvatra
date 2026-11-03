import { ArrowLeft, ArrowRight, PanelLeft } from 'lucide-react'
import { AppMenu } from '@renderer/components/AppMenu'
import { WindowControls } from '@renderer/components/WindowControls'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import {
  selectCanGoBack,
  selectCanGoForward,
  selectSidebarOpen,
  sidebarToggled,
  wentBack,
  wentForward
} from '@renderer/store/uiSlice'
import { sidebarId, sidebarShortcut } from '@renderer/tabs'

/** The bar's square icon buttons: same size and highlight as a selected chat (design decision). */
const iconButton =
  'grid size-8 place-items-center rounded-sm text-muted-foreground outline-none [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

interface TitleBarProps {
  /** Lets the app move focus to the toggle when Ctrl+B hides the sidebar that had it. */
  toggleRef?: React.Ref<HTMLButtonElement>
}

/**
 * The app's own title bar (the native one is hidden). "Fused": no background, laid over the top of the sidebar and
 * the content so each shows through. The empty space drags the window (and double-click maximizes, natively);
 * every control opts out of dragging, or it couldn't be clicked.
 */
export function TitleBar({ toggleRef }: TitleBarProps): React.JSX.Element {
  const dispatch = useAppDispatch()
  const sidebarOpen = useAppSelector(selectSidebarOpen)
  const canGoBack = useAppSelector(selectCanGoBack)
  const canGoForward = useAppSelector(selectCanGoForward)

  return (
    <header className="absolute inset-x-0 top-0 z-20 flex h-10 items-center gap-0.5 pl-1.5 [-webkit-app-region:drag]">
      <AppMenu />
      <button
        ref={toggleRef}
        type="button"
        aria-label="Sidebar"
        aria-expanded={sidebarOpen}
        aria-controls={sidebarId}
        aria-keyshortcuts={sidebarShortcut}
        title={`${sidebarOpen ? 'Close' : 'Open'} sidebar (Ctrl+B)`}
        onClick={() => dispatch(sidebarToggled())}
        className={iconButton}
      >
        <PanelLeft aria-hidden className="size-[18px]" />
      </button>
      {/* Dimmed (disabled) when there's nowhere to go. */}
      <button
        type="button"
        aria-label="Back"
        aria-keyshortcuts="Alt+ArrowLeft"
        title="Back (Alt+←)"
        disabled={!canGoBack}
        onClick={() => dispatch(wentBack())}
        className={iconButton}
      >
        <ArrowLeft aria-hidden className="size-[18px]" />
      </button>
      <button
        type="button"
        aria-label="Forward"
        aria-keyshortcuts="Alt+ArrowRight"
        title="Forward (Alt+→)"
        disabled={!canGoForward}
        onClick={() => dispatch(wentForward())}
        className={iconButton}
      >
        <ArrowRight aria-hidden className="size-[18px]" />
      </button>
      <div className="flex-1" />
      <WindowControls />
    </header>
  )
}
