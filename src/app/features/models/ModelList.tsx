import { useId, useState } from 'react'
import { Button } from '@app/ui/button'
import { Label } from '@app/ui/label'
import { usePlatform } from '@app/platform/usePlatform'
import { useCoreState } from '@app/core/useCoreState'
import { useLlamacppSettings } from './useLlamacppSettings'
import { useModels } from './useModels'
import type { LlamacppChange } from './modelSettings'

/** A failed action has nothing useful to show here; log it (main copies page errors into main.log). */
function run(action: () => Promise<void>): void {
  action().catch((error) => console.error('Models service action failed', error))
}

/** The embedding model, and the service's log and restart. Each model's own options are the Installed list's. */
export function ModelList(): React.JSX.Element {
  const { value: settings, update } = useLlamacppSettings()
  const [saveProblem, setSaveProblem] = useState<string>()
  const core = useCoreState()
  const platform = usePlatform()
  const models = useModels()
  const headingId = useId()
  const embeddingId = useId()
  const problemId = useId()

  const embedding = models.filter((model) => model.kind === 'embedding')
  // Same rule as core: the saved choice if it is an embedding model, else Automatic = the first one.
  const chosenIsEmbedding = embedding.some((model) => model.id === settings.embeddingModel)
  const automatic = embedding[0]?.id
  const chosenProblem = settings.embeddingModel && !chosenIsEmbedding ? settings.embeddingModel : null
  const chosenKind = models.find((model) => model.id === chosenProblem)?.kind
  // The list says why when there is nothing to show; the select only makes sense once core has models.
  const showSelect = core?.status === 'ready' && models.length > 0

  function change(next: LlamacppChange): void {
    setSaveProblem(undefined)
    update(next).catch((error: Error) => setSaveProblem(error.message))
  }

  function setEmbedding(id: string | null): void {
    change({ embeddingModel: id })
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5 pt-4">
      <div className="flex items-center justify-between gap-4">
        <h3 id={headingId} className="text-sm font-medium">
          Available models
        </h3>
        <div className="flex gap-2">
          {platform.core.openLog && (
            <Button variant="outline" size="sm" onClick={() => run(async () => platform.core.openLog?.())}>
              Open log
            </Button>
          )}
          {platform.core.restart && (
            <Button variant="outline" size="sm" onClick={() => run(async () => platform.core.restart?.())}>
              Restart
            </Button>
          )}
        </div>
      </div>
      {saveProblem && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {saveProblem}
        </p>
      )}

      {showSelect && (
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
                <option value="">Not found</option>
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
        </>
      )}
    </section>
  )
}
