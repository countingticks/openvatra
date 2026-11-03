import { useMaximized } from '@renderer/hooks/useMaximized'
import { cn } from '@renderer/lib/utils'

// Windows' own sizes (46×40) and thin glyphs, so the buttons feel native although the UI draws them.
const button =
  'grid h-10 w-[46px] place-items-center text-foreground outline-none [-webkit-app-region:no-drag] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'

/** A failed window action has nothing useful to show the user; log it (main copies it to main.log). */
function run(action: () => Promise<void>): void {
  action().catch((error) => console.error('Window action failed', error))
}

export function WindowControls(): React.JSX.Element {
  const maximized = useMaximized()
  const { appWindow } = window.api

  return (
    <div className="flex h-10">
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        className={button}
        onClick={() => run(appWindow.minimize)}
      >
        <svg aria-hidden width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        className={button}
        onClick={() => run(appWindow.toggleMaximize)}
      >
        {maximized ? (
          <svg
            aria-hidden
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          >
            <rect x="0.5" y="2.5" width="7" height="7" />
            <path d="M2.5 2.5V0.5h7v7h-2" />
          </svg>
        ) : (
          <svg
            aria-hidden
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          >
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        // Windows' own close red, with a white glyph.
        className={cn(button, 'hover:bg-[#C42B1C] hover:text-white')}
        onClick={() => run(appWindow.close)}
      >
        <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  )
}
