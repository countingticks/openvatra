import { useId } from 'react'
import { ModelRow } from '@renderer/components/settings/ModelRow'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { useCoreState } from '@renderer/hooks/useCoreState'
import { useModels } from '@renderer/hooks/useModels'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged } from '@renderer/store/settingsSlice'
import type { ModelOptions } from '../../../../shared/settings'

/** A failed action has nothing useful to show here; log it (main copies page errors into main.log). */
function run(action: () => Promise<void>): void {
  action().catch((error) => console.error('Models service action failed', error))
}

/**
 * Setting the models up: the embedding model and each model's options. Loading and unloading is the model
 * button's job. When there's nothing to list,
 * it says why and what to do: the service has a problem, the paths aren't chosen, it's starting, or the folder is empty.
 */
export function ModelList(): React.JSX.Element {
  const { models: settings } = useAppSelector(selectSettings)
  const dispatch = useAppDispatch()
  const core = useCoreState()
  const models = useModels()
  const headingId = useId()
  const embeddingId = useId()

  function setEmbedding(id: string | null): void {
    dispatch(settingsChanged({ models: { embeddingModel: id } }))
  }

  function setOptions(id: string, next: ModelOptions | undefined): void {
    // The patch carries the whole map: one model's change can't drop another's.
    const others = Object.fromEntries(Object.entries(settings.options).filter(([key]) => key !== id))
    dispatch(settingsChanged({ models: { options: next ? { ...others, [id]: next } : others } }))
  }

  let empty: string | null = null
  if (core?.status === 'problem') empty = `The models service has a problem: ${core.reason}`
  else if (!settings.llamaServerPath || !settings.modelsDir)
    empty = 'Choose llama-server.exe and your models folder above, and your models will show here.'
  else if (core?.status !== 'ready') empty = 'Starting the models service…'
  else if (models.length === 0) empty = 'No models found. Put .gguf files in the models folder.'

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5 pt-4">
      <div className="flex items-center justify-between gap-4">
        <h3 id={headingId} className="text-sm font-medium">
          Available models
        </h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => run(window.api.core.openLog)}>
            Open log
          </Button>
          <Button variant="outline" size="sm" onClick={() => run(window.api.core.restart)}>
            Restart
          </Button>
        </div>
      </div>

      {empty ? (
        <p
          role={core?.status === 'problem' ? 'alert' : 'status'}
          className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground"
        >
          {empty}
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label htmlFor={embeddingId} className="text-sm">
                Embedding model
              </Label>
              <p className="text-[12.5px] text-muted-foreground">
                Powers document search and stays loaded beside the chat model.
              </p>
            </div>
            <select
              id={embeddingId}
              value={settings.embeddingModel ?? ''}
              onChange={(event) => setEmbedding(event.target.value || null)}
              className="h-8 max-w-64 min-w-0 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">None</option>
              {/* A chosen model whose file is gone stays listed, so the select never hides what is saved. */}
              {settings.embeddingModel && !models.some((model) => model.id === settings.embeddingModel) && (
                <option value={settings.embeddingModel}>{settings.embeddingModel}</option>
              )}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </div>
          <ul aria-labelledby={headingId} className="flex flex-col rounded-lg border border-border">
            {models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                options={settings.options[model.id]}
                onOptions={(next) => setOptions(model.id, next)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
