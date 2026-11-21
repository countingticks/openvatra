// "Follow the end" for a growing conversation: while the reader is at the bottom, new content keeps the view there;
// once they scroll up to read, it stops pulling them down and offers a way back instead.
import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '@app/ui/useReducedMotion'

/** How far from the bottom still counts as "at the end" (sub-pixel rounding and a stray line of padding). */
const nearEnd = 48

const atEnd = (el: HTMLElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= nearEnd

function scrollToEnd(el: HTMLElement, behavior?: 'smooth'): void {
  if (behavior) el.scrollTo({ top: el.scrollHeight, behavior })
  else el.scrollTop = el.scrollHeight
}

/** Follows the end of `scroller` as its first child grows; a new chat starts at its end. */
export function useFollowEnd(
  scroller: React.RefObject<HTMLElement | null>,
  chatId: string | undefined
): { following: boolean; jumpToLatest(): void } {
  const [following, setFollowing] = useState(true)
  // Refs as well as state: the observers read the latest values without being set up again on every scroll.
  const followingRef = useRef(true)
  // A smooth jump passes through positions above the end; those scroll events are not the reader leaving it.
  const jumping = useRef(false)
  const reducedMotion = useReducedMotion()

  const follow = (value: boolean): void => {
    followingRef.current = value
    setFollowing(value)
  }

  // Another chat starts at its end, following. The state follows during render; the DOM in the effect.
  const [shownChat, setShownChat] = useState(chatId)
  if (shownChat !== chatId) {
    setShownChat(chatId)
    setFollowing(true)
  }
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    scrollToEnd(el)
    jumping.current = false
    followingRef.current = true
  }, [scroller, chatId])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = (): void => {
      const end = atEnd(el)
      if (jumping.current) {
        if (!end) return
        jumping.current = false
      }
      followingRef.current = end
      setFollowing(end)
    }
    el.addEventListener('scroll', onScroll)
    const content = el.firstElementChild
    const observer =
      content && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (followingRef.current) scrollToEnd(el)
          })
        : null
    if (content) observer?.observe(content)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [scroller])

  function jumpToLatest(): void {
    const el = scroller.current
    if (!el) return
    if (reducedMotion || typeof el.scrollTo !== 'function') {
      scrollToEnd(el)
    } else {
      jumping.current = true
      scrollToEnd(el, 'smooth')
    }
    follow(true)
  }

  return { following, jumpToLatest }
}
