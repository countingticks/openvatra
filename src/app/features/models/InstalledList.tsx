import { useState } from 'react'
import { InstalledRow } from './InstalledRow'
import { useCoreState } from '@app/core/useCoreState'
import { useLlamacppSettings } from './useLlamacppSettings'
import { useModels } from './useModels'
import type { ModelOptions } from '@app/core/generated'
import type { ModelInfo } from '@app/core/types'

const byName = (a: ModelInfo, b: ModelInfo): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

/** Every model core found: chat models first, then embedding models, each by name. One row's options are open. */
export function InstalledList(): React.JSX.Element {
  const { value: settings, update } = useLlamacppSettings()
  const core = useCoreState()
  const models = useModels()
  const [openId, setOpenId] = useState<string | null>(null)

  const usable = [
    ...models.filter((model) => model.kind === 'chat').sort(byName),
    ...models.filter((model) => model.kind === 'embedding').sort(byName)
  ]

  function setOptions(id: string, next: ModelOptions | undefined): Promise<void> {
    // The patch carries the whole map: one model's change can't drop another's.
    const others = Object.fromEntries(Object.entries(settings.options).filter(([key]) => key !== id))
    return update({ options: next ? { ...others, [id]: next } : others })
  }

  let empty: string | null = null
  if (core?.status === 'problem') empty = `The models service has a problem: ${core.reason}`
  else if (core?.status !== 'ready') empty = 'Starting the models service…'
  else if (models.length === 0) empty = 'No models found. Put .gguf files in the models folder.'

  if (empty) {
    return (
      <p
        role={core?.status === 'problem' ? 'alert' : 'status'}
        className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground"
      >
        {empty}
      </p>
    )
  }

  return (
    <ul aria-label="Installed models" className="flex flex-col rounded-lg border border-border">
      {usable.map((model) => (
        <InstalledRow
          key={model.id}
          model={model}
          options={settings.options[model.id]}
          onOptions={(next) => setOptions(model.id, next)}
          expanded={openId === model.id}
          onToggle={() => setOpenId(openId === model.id ? null : model.id)}
        />
      ))}
    </ul>
  )
}
