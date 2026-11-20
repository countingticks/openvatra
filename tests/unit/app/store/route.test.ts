import { describe, expect, it } from 'vitest'
import { parseRoute, routePath, sameRoute, type Route } from '@app/store/route'

const shapes: Route[] = [
  { tab: 'chat' },
  { tab: 'chat', chatId: 'a' },
  { tab: 'code' },
  { tab: 'code', project: 'p' },
  { tab: 'code', project: 'p', runId: 'r' },
  { tab: 'automations' },
  { tab: 'automations', triggerId: 't' }
]

describe('routes', () => {
  it.each(shapes)('round trips %o', (route) => {
    expect(parseRoute(routePath(route))).toEqual(route)
  })

  it('encodes ids in the path and decodes them back', () => {
    const route: Route = { tab: 'chat', chatId: 'a/b c%é' }
    const path = routePath(route)
    expect(path).toBe('chat/a%2Fb%20c%25%C3%A9')
    expect(parseRoute(path)).toEqual(route)
  })

  it('gives exactly { tab } for a bare tab, with no undefined keys', () => {
    const route = parseRoute('chat')
    expect(route).toStrictEqual({ tab: 'chat' })
  })

  it.each([
    '',
    'settings',
    'Chat',
    'chat/',
    '/chat',
    'chat/a/b',
    'code//x',
    'code/a/b/c',
    'automations/a/b',
    'chat/%E0%A4%A'
  ])('rejects %j', (path) => {
    expect(parseRoute(path)).toBeNull()
  })

  it('writes a code route with a run but no project as code', () => {
    expect(routePath({ tab: 'code', runId: 'r' })).toBe('code')
  })

  it('compares routes by path', () => {
    expect(sameRoute({ tab: 'chat', chatId: 'a' }, { tab: 'chat', chatId: 'a' })).toBe(true)
    expect(sameRoute({ tab: 'chat', chatId: 'a' }, { tab: 'chat', chatId: 'b' })).toBe(false)
    expect(sameRoute({ tab: 'chat' }, { tab: 'code' })).toBe(false)
  })
})
