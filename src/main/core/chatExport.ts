// A chat as Markdown for Export: its title from GET /api/chats/{id}, its text from GET /api/chats/{id}/export.
// Main reads both with its own token, so no chat text crosses IPC. No Electron imports, so tests need only a fake
// `request`.
import { z } from 'zod'
import { coreErrorMessage } from './coreError'

export interface ChatExport {
  read(chatId: string): Promise<{ fileName: string; markdown: string }>
}

const chatSchema = z.object({ chat: z.object({ title: z.string() }) })

export function createChatExport(
  request: (path: string, init?: RequestInit) => Promise<Response>
): ChatExport {
  async function ok(path: string): Promise<Response> {
    const response = await request(path)
    if (!response.ok) throw new Error(await coreErrorMessage(response))
    return response
  }

  return {
    async read(chatId) {
      const base = `/api/chats/${encodeURIComponent(chatId)}`
      const chat = chatSchema.safeParse(await (await ok(base)).json().catch(() => null))
      if (!chat.success) throw new Error('core sent a malformed chat')
      const markdown = await (await ok(`${base}/export`)).text()
      return { fileName: exportFileName(chat.data.chat.title), markdown }
    }
  }
}

const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** A Windows-safe file name for a chat's title, so the Save dialog opens on a name the user can just accept. */
export function exportFileName(title: string): string {
  const name = title
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 100)
    .replace(/[. ]+$/, '')
  return `${name === '' || reservedNames.test(name) ? 'Chat' : name}.md`
}
