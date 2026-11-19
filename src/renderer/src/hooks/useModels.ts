import type { ModelInfo } from '@app/core/types'
import { selectConnection } from '@app/core/connectionSlice'
import { useListModelsQuery } from '@app/core/generated'
import { useAppSelector } from '@app/store/hooks'

const none: ModelInfo[] = []

/** Every model in the models folder with its state, live. Empty until core answers, and while there is no connection. */
export function useModels(): ModelInfo[] {
  const connection = useAppSelector(selectConnection)
  const { data } = useListModelsQuery(undefined, { skip: connection === null })
  return connection === null ? none : (data?.models ?? none)
}
