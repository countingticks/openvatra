import { useState } from 'react'
import { useGetChatQuery, useGetConfigChatQuery, useUpdateChatMutation } from '@app/core/generated'
import { useModels } from '@app/features/models'

/**
 * The model a chat answers with, and the way to change it (decision 19). A saved chat's model is its own (core keeps
 * it) while installed; if it is gone the button shows the fallback, the same rule core uses on the next send
 * (decision 5). A new chat's is the one picked on it, else the fallback: core's `chat.lastModel` while installed,
 * else the first chat model (decision 12), so what the button shows is what the next send uses.
 */
export function useChatModel(chatId: string | undefined): {
  model: string | null
  loading: boolean
  pick(id: string): Promise<void>
} {
  const saved = chatId !== undefined && chatId !== ''
  const { currentData: chat } = useGetChatQuery({ id: chatId ?? '' }, { skip: !saved })
  const { data: config } = useGetConfigChatQuery()
  const [updateChat] = useUpdateChatMutation()
  const chatModels = useModels().filter((model) => model.kind === 'chat')
  // Belongs to the chat it was picked on, so opening another chat forgets it.
  const [picked, setPicked] = useState<{ chatId: string | undefined; id: string } | null>(null)

  const fallback = (): string | null => {
    const last = config?.value.lastModel ?? null
    return chatModels.some((entry) => entry.id === last) ? last : (chatModels[0]?.id ?? null)
  }

  let model: string | null
  if (saved) {
    const own = chat?.chat.model ?? null
    model =
      own === null || chatModels.length === 0 || chatModels.some((entry) => entry.id === own)
        ? own
        : fallback()
  } else if (picked !== null && picked.chatId === chatId) {
    model = picked.id
  } else {
    model = fallback()
  }
  const loading = chatModels.some((entry) => entry.id === model && entry.state === 'loading')

  async function pick(id: string): Promise<void> {
    if (chatId !== undefined && chatId !== '') {
      await updateChat({ id: chatId, body: { model: id } }).unwrap()
      return
    }
    setPicked({ chatId, id })
  }

  return { model, loading, pick }
}
