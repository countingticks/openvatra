import { useId } from 'react'
import { ArgsField } from '@renderer/components/settings/ArgsField'
import { SegmentedControl } from '@renderer/components/settings/SegmentedControl'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { idleOptions } from '@renderer/lib/idleOptions'
import type { ModelOptions } from '../../../../shared/settings'

interface ModelOptionsFormProps {
  id: string
  modelId: string
  /** File name of the detected vision projector, if any. */
  projector: string | undefined
  options: ModelOptions | undefined
  /** The model's new options, or undefined when every field is back to its default. */
  onChange: (next: ModelOptions | undefined) => void
}

// "Default" means "use the global setting", which is stored as the key being absent.
const unloadOptions = [{ value: 'default', label: 'Default' }, ...idleOptions]

/** A model's own settings: arguments, vision projector on/off, and how long it may sit unused. */
export function ModelOptionsForm({
  id,
  modelId,
  projector,
  options,
  onChange
}: ModelOptionsFormProps): React.JSX.Element {
  const unloadId = useId()
  const projectorId = useId()

  /** Merges one change; a field set back to its default is removed, and no fields left means no entry. */
  function update(patch: Partial<ModelOptions>): void {
    const merged = Object.fromEntries(
      Object.entries({ ...options, ...patch }).filter(([, value]) => value !== undefined)
    ) as ModelOptions
    onChange(Object.keys(merged).length > 0 ? merged : undefined)
  }

  const unload =
    options?.idleUnloadMinutes === undefined
      ? 'default'
      : (idleOptions.find((option) => option.minutes === options.idleUnloadMinutes)?.value ?? 'default')

  return (
    <div
      id={id}
      role="group"
      aria-label={`Options for ${modelId}`}
      className="mt-2.5 flex flex-col gap-3 rounded-md bg-sidebar p-3"
    >
      <ArgsField
        label="Arguments"
        value={options?.args ?? ''}
        placeholder="-c 131072"
        hint='Added after the arguments for every model, e.g. -c 131072. Use "…" around values with spaces.'
        onCommit={(text) => update({ args: text || undefined })}
      />

      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Label htmlFor={projectorId} className="text-xs">
            Use vision projector
          </Label>
          <p className="truncate text-xs text-muted-foreground" title={projector}>
            {projector ?? 'No projector found next to this model.'}
          </p>
        </div>
        <Switch
          id={projectorId}
          disabled={!projector}
          checked={projector ? options?.mmproj !== false : false}
          onCheckedChange={(checked) => update({ mmproj: checked ? undefined : false })}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <span id={unloadId} className="text-xs font-medium">
          Unload after
        </span>
        <SegmentedControl
          labelledBy={unloadId}
          value={unload}
          options={unloadOptions}
          onChange={(value) => {
            const option = idleOptions.find((candidate) => candidate.value === value)
            // Missing key = Default; null (Never) is a real choice, so it must not be dropped.
            update({ idleUnloadMinutes: option ? option.minutes : undefined })
          }}
        />
      </div>
    </div>
  )
}
