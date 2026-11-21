// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createChatExport, exportFileName } from '../../../src/main/core/chatExport'

type Request = (path: string, init?: RequestInit) => Promise<Response>

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('chat export', () => {
  it('reads the Markdown and names the file after the title', async () => {
    const request = vi.fn<Request>(async (path) =>
      path.endsWith('/export')
        ? new Response('# Trip to Cluj\n', { headers: { 'Content-Type': 'text/markdown' } })
        : json({ seq: 4, chat: { id: 'c 1', title: 'Trip to Cluj' } })
    )

    expect(await createChatExport(request).read('c 1')).toEqual({
      fileName: 'Trip to Cluj.md',
      markdown: '# Trip to Cluj\n'
    })
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/chats/c%201', '/api/chats/c%201/export'])
  })

  it("rejects with core's message when core doesn't know the chat", async () => {
    const request = vi.fn<Request>(async () =>
      json({ error: 'chat_not_found', message: 'no such chat' }, 404)
    )

    await expect(createChatExport(request).read('c1')).rejects.toThrow('no such chat')
  })
})

describe('exportFileName', () => {
  it.each([
    ['Trip: Cluj/Napoca?', 'Trip Cluj Napoca.md'],
    ['con', 'Chat.md'],
    ['...', 'Chat.md'],
    ['a'.repeat(300), `${'a'.repeat(100)}.md`]
  ])('%s → %s', (title, fileName) => {
    expect(exportFileName(title)).toBe(fileName)
  })
})
