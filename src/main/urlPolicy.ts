// Pure URL decisions used by the security guards. No Electron imports, so they're unit-testable.

/** True for ordinary web links (http/https) that may be handed to the user's browser. */
export function isExternalWebUrl(url: string): boolean {
  const parsed = parse(url)
  return parsed?.protocol === 'https:' || parsed?.protocol === 'http:'
}

/**
 * True when `url` is the app's own UI: same origin as the dev server, or the exact bundled index.html file.
 * Anything else must never load inside the app window.
 */
export function isAppUrl(url: string, appUrl: string): boolean {
  const target = parse(url)
  const app = parse(appUrl)
  if (!target || !app) return false
  if (app.protocol === 'file:') return target.protocol === 'file:' && target.pathname === app.pathname
  return target.origin === app.origin
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
