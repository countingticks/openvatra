import { useId, useState } from 'react'
import { ModelRow } from '@renderer/components/settings/ModelRow'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { useCoreState } from '@renderer/hooks/useCoreState'
import { useModels } from '@renderer/hooks/useModels'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged } from '@renderer/store/settingsSlice'
import type { ModelInfo } from '../../../../shared/core'
import type { ModelOptions } from '../../../../shared/settings'

/** A failed action has nothing useful to show here; log it (main copies page errors into main.log). */
function run(action: () => Promise<void>): void {
  action().catch((error) => console.error('Models service action failed', error))
}

interface ModelGroupProps {
  title: string
  models: ModelInfo[]
  options: Record<string, ModelOptions>
  onOptions: (id: string, next: ModelOptions | undefined) => void
  /** The one model whose options are open, across all groups. */
  openId: string | null
  onOpen: (id: string | null) => void
}

/** One kind of model under its heading; nothing at all when there are none. */
function ModelGroup({
  title,
  models,
  options,
  onOptions,
  openId,
  onOpen
}: ModelGroupProps): React.JSX.Element | null {
  if (models.length === 0) return null
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="flex flex-col rounded-lg border border-border">
        {models.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            options={options[model.id]}
            onOptions={(next) => onOptions(model.id, next)}
            expanded={openId === model.id}
            onToggle={() => onOpen(openId === model.id ? null : model.id)}
          />
        ))}
      </ul>
    </section>
  )
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
  const problemId = useId()

  const [openId, setOpenId] = useState<string | null>(null)
  const chat = models.filter((model) => model.kind === 'chat')
  const embedding = models.filter((model) => model.kind === 'embedding')
  const unreadable = models.filter((model) => model.kind === 'unreadable')
  // Same rule as core: the saved choice if it is an embedding model, else Automatic = the first one.
  const chosenIsEmbedding = embedding.some((model) => model.id === settings.embeddingModel)
  const automatic = embedding[0]?.id
  const chosenProblem = settings.embeddingModel && !chosenIsEmbedding ? settings.embeddingModel : null
  const chosenKind = models.find((model) => model.id === chosenProblem)?.kind

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
              <p className="text-[12.5px] text-muted-foreground">Powers document search.</p>
            </div>
            <select
              id={embeddingId}
              value={chosenIsEmbedding ? (settings.embeddingModel ?? '') : ''}
              disabled={embedding.length === 0}
              aria-describedby={chosenProblem ? problemId : undefined}
              onChange={(event) => setEmbedding(event.target.value || null)}
              className="h-8 max-w-64 min-w-0 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {embedding.length === 0 ? (
                <option value="">No embedding model found</option>
              ) : (
                <>
                  <option value="">Automatic ({automatic})</option>
                  {embedding.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}
                    </option>
                  ))}
                </>
              )}
            </select>
          </div>
          {/* {embedding.length === 0 && (
            <p className="text-[12.5px] text-muted-foreground">
              Add an embedding .gguf (e.g. Qwen3-Embedding-0.6B) to enable document search.
            </p>
          )} */}
          {chosenProblem && (
            <div
              id={problemId}
              role="alert"
              className="flex items-center justify-between gap-3 text-[12.5px] text-destructive"
            >
              <span>
                {chosenKind === 'chat'
                  ? `${chosenProblem} is a chat model, so Automatic is used`
                  : `${chosenProblem} isn't an available embedding model, so Automatic is used`}
              </span>
              <Button variant="outline" size="sm" onClick={() => setEmbedding(null)}>
                Reset
              </Button>
            </div>
          )}
          <ModelGroup
            title="Chat models"
            models={chat}
            options={settings.options}
            onOptions={setOptions}
            openId={openId}
            onOpen={setOpenId}
          />
          <ModelGroup
            title="Embedding models"
            models={embedding}
            options={settings.options}
            onOptions={setOptions}
            openId={openId}
            onOpen={setOpenId}
          />
          {unreadable.length > 0 && (
            <section aria-label="Files that can't be used" className="flex flex-col gap-1.5">
              <h4 className="text-xs font-medium text-muted-foreground">Can&apos;t be used</h4>
              <ul className="flex flex-col rounded-lg border border-border">
                {unreadable.map((model) => (
                  <li
                    key={model.id}
                    className="flex flex-col gap-0.5 border-b border-border px-3 py-2.5 last:border-b-0"
                  >
                    <span className="truncate font-mono text-[13px]" title={model.id}>
                      {model.id}
                    </span>
                    <span className="text-xs text-destructive">
                      {model.error ?? 'The file could not be read.'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  )
}
