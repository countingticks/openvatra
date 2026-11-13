import { app, session, shell, type WebContents } from 'electron'
import { allowLoopbackRequest, loopbackPatterns } from './loopbackFilter'
import { isAppUrl, isExternalWebUrl } from './urlPolicy'

/**
 * Guards that keep every window showing only the app's own UI (AGENTS.md "Security rules").
 * Call once, before the first window is created. `appUrl` is the URL the main window loads; `corePort` gives
 * core's port while it is ready.
 */
export function applySecurityPolicy(appUrl: string, corePort: () => number | undefined): void {
  // Camera, microphone, location, notifications...: nothing is granted unless a feature explicitly needs it.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  // The page may reach core, and no other local service. The port is read per request: a restarted core on a
  // new port needs no reload. Main's own fetch does not pass through the session, so it is not affected.
  session.defaultSession.webRequest.onBeforeRequest({ urls: loopbackPatterns }, (details, callback) =>
    callback({ cancel: !allowLoopbackRequest(details.url, corePort(), appUrl) })
  )

  app.on('web-contents-created', (_event, contents) => guardContents(contents, appUrl))
}

function guardContents(contents: WebContents, appUrl: string): void {
  // window.open and target="_blank" links: never a new app window; web links go to the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url)
    return { action: 'deny' }
  })

  // Clicked links, form posts, scripts setting location, server redirects: the window may only show our UI.
  const keepOnAppUrl = (event: Electron.Event, url: string): void => {
    if (isAppUrl(url, appUrl)) return
    event.preventDefault()
    openInBrowser(url)
  }
  contents.on('will-navigate', keepOnAppUrl)
  contents.on('will-redirect', keepOnAppUrl)

  // <webview> would embed arbitrary pages with their own settings; the app never uses it.
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/** Only ordinary http(s) links reach the operating system; file:, smb:, custom protocols etc. are dropped. */
function openInBrowser(url: string): void {
  if (isExternalWebUrl(url)) void shell.openExternal(url)
}
