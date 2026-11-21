// Where the window is: a tab, plus the thing open inside it. A Route is the typed form; its path form
// ("chat/<id>") is what gets saved, so the app reopens where it was left.
import type { TabId } from '@shared/settings'

export type Route =
  | { tab: 'chat'; chatId?: string }
  | { tab: 'code'; project?: string; runId?: string }
  | { tab: 'automations'; triggerId?: string }

// A new tab id must get a route variant before the app compiles again: these fail if the unions differ.
type Assert<T extends true> = T
type _RouteCoversTabs = Assert<TabId extends Route['tab'] ? true : false>
type _TabsCoverRoute = Assert<Route['tab'] extends TabId ? true : false>
export type RouteTabsMatch = [_RouteCoversTabs, _TabsCoverRoute]

/** The route as a path: `chat`, `chat/<chatId>`, `code/<project>/<runId>`. Ids are URI-encoded; '' counts as absent. */
export function routePath(route: Route): string {
  let ids: (string | undefined)[]
  switch (route.tab) {
    case 'chat':
      ids = [route.chatId]
      break
    case 'code':
      // A run belongs to a project, so one without it has nowhere to go.
      ids = [route.project, route.project ? route.runId : undefined]
      break
    case 'automations':
      ids = [route.triggerId]
      break
  }
  const parts: string[] = [route.tab]
  for (const id of ids) {
    if (!id) break
    parts.push(encodeURIComponent(id))
  }
  return parts.join('/')
}

const maxSegments = { chat: 2, code: 3, automations: 2 } as const

/** The route a path names, or null when it names none. Never throws. */
export function parseRoute(path: string): Route | null {
  const segments = path.split('/')
  if (segments.some((segment) => segment === '')) return null
  const [tab, ...rest] = segments
  if (tab !== 'chat' && tab !== 'code' && tab !== 'automations') return null
  if (segments.length > maxSegments[tab]) return null
  let ids: string[]
  try {
    ids = rest.map(decodeURIComponent)
  } catch {
    return null
  }
  // Only the keys present, so toEqual and round trips hold without `undefined` entries.
  switch (tab) {
    case 'chat':
      return ids[0] === undefined ? { tab } : { tab, chatId: ids[0] }
    case 'automations':
      return ids[0] === undefined ? { tab } : { tab, triggerId: ids[0] }
    case 'code': {
      const route: Route = { tab }
      if (ids[0] !== undefined) route.project = ids[0]
      if (ids[1] !== undefined) route.runId = ids[1]
      return route
    }
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return routePath(a) === routePath(b)
}
