// Which loopback requests the window may send. The CSP allows any 127.0.0.1 port (it cannot name a port that
// changes per run), so main narrows it to core's current port: llama-server and other local services stay
// unreachable from the page. No Electron imports, so it is unit-testable.

/** URL patterns the filter watches (Electron webRequest filter). */
export const loopbackPatterns: string[] = ['http://127.0.0.1:*/*', 'http://localhost:*/*']

/** Whether the window may send this loopback request: to core's current port, or to the dev server's origin. */
export function allowLoopbackRequest(url: string, corePort: number | undefined, appUrl: string): boolean {
  const target = parse(url)
  if (!target) return false
  if (corePort !== undefined && target.hostname === '127.0.0.1' && target.port === String(corePort))
    return true
  const app = parse(appUrl)
  // The Vite dev server (its HMR included); a file:// page has no origin to match.
  return app?.protocol === 'http:' && target.origin === app.origin
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
