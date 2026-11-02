// Turns a burst of calls into one: `fn` runs `waitMs` after the last call, with that call's arguments.

export interface Debounced<A extends unknown[]> {
  (...args: A): void
  /** Runs a waiting call now instead of after the timer. Does nothing if none is waiting. */
  flush(): void
  /** Drops a waiting call. */
  cancel(): void
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastArgs: A | undefined

  function cancel(): void {
    clearTimeout(timer)
    timer = undefined
    lastArgs = undefined
  }

  function flush(): void {
    if (!lastArgs) return
    const args = lastArgs
    cancel()
    fn(...args)
  }

  function debounced(...args: A): void {
    lastArgs = args
    clearTimeout(timer)
    timer = setTimeout(flush, waitMs)
  }

  return Object.assign(debounced, { flush, cancel })
}
