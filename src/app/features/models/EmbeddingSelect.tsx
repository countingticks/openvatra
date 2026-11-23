import { useId, useState } from 'react'
import { Button } from '@app/ui/button'
import { Label } from '@app/ui/label'
import { useLlamacppSettings } from './useLlamacppSettings'
import { useModels } from './useModels'
import type { LlamacppChange } from './modelSettings'

/** The model that powers document search: Automatic (the first embedding model) or one the user picked. */
export function EmbeddingSelect(): React.JSX.Element {
  const { value: settings, update } = useLlamacppSettings()
  const [saveProblem, setSaveProblem] = useState<string>()
  const models = useModels()
  const embeddingId = useId()
  const problemId = useId()

  const embedding = models.filter((model) => model.kind === 'embedding')
  // Same rule as core: the saved choice if it is an embedding model, else Automatic = the first one.
  const chosenIsEmbedding = embedding.some((model) => model.id === settings.embeddingModel)
  const automatic = embedding[0]?.id
  const chosenProblem = settings.embeddingModel && !chosenIsEmbedding ? settings.embeddingModel : null
  const chosenKind = models.find((model) => model.id === chosenProblem)?.kind

  function change(next: LlamacppChange): void {
    setSaveProblem(undefined)
    update(next).catch((error: Error) => setSaveProblem(error.message))
  }

  function setEmbedding(id: string | null): void {
    change({ embeddingModel: id })
  }

  return (
    <div className="flex flex-col gap-2.5 border-b border-border py-4">
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
      {saveProblem && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {saveProblem}
        </p>
      )}
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
    </div>
  )
}
