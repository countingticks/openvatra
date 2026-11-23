import { useEffect, useRef } from 'react'
import { ScrollArea } from '@base-ui/react/scroll-area'
import { cn } from '@app/lib/utils'

/** How long the scrollbar stays after the last scroll or after the pointer leaves. */
const lingerMs = 600

export interface OverlayScrollProps {
  children: React.ReactNode
  /** Where the track starts below the top and ends above the bottom, in px; default 0. */
  insetTop?: number
  insetBottom?: number
  /** Classes on the root, which is `relative` and sizes the area (e.g. `flex-1 min-h-0`). */
  className?: string
  /** Props for the element that scrolls (Base UI's Viewport): role, aria-*, className, style, ref. */
  viewport?: React.ComponentProps<'div'>
  /** Drawn inside the root, outside the viewport: not scrolled and not masked (the scroll-to-latest button). */
  overlay?: React.ReactNode
}

/** A scrolling area with a thin scrollbar drawn over the content; it shows while hovered and just after scrolling. */
export function OverlayScroll({
  children,
  insetTop = 0,
  insetBottom = 0,
  className,
  viewport,
  overlay
}: OverlayScrollProps): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The attribute is set on the DOM directly: scrolling must not re-render the conversation.
  const show = (): void => {
    clearTimeout(timer.current)
    root.current?.setAttribute('data-visible', '')
  }
  const hideSoon = (): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => root.current?.removeAttribute('data-visible'), lingerMs)
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  const { className: viewportClass, onScroll, ...viewportProps } = viewport ?? {}

  return (
    <ScrollArea.Root
      ref={root}
      className={cn('group/scroll relative', className)}
      onPointerEnter={() => {
        hovered.current = true
        show()
      }}
      onPointerLeave={() => {
        hovered.current = false
        hideSoon()
      }}
    >
      <ScrollArea.Viewport
        {...viewportProps}
        className={viewportClass}
        onScroll={(event) => {
          onScroll?.(event)
          show()
          if (!hovered.current) hideSoon()
        }}
      >
        {children}
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar
        orientation="vertical"
        style={{ top: insetTop, bottom: insetBottom }}
        className="group/bar absolute right-[3px] flex w-3 justify-center opacity-0 transition-opacity duration-150 group-data-visible/scroll:opacity-100 in-data-[motion=reduce]:transition-none"
      >
        <ScrollArea.Thumb className="min-h-8 w-[5px] rounded-full bg-border-strong transition-[width,background-color] duration-150 group-hover/bar:w-2 group-hover/bar:bg-muted-foreground group-active/bar:w-2 group-active/bar:bg-muted-foreground in-data-[motion=reduce]:transition-none" />
      </ScrollArea.Scrollbar>
      {overlay}
    </ScrollArea.Root>
  )
}
