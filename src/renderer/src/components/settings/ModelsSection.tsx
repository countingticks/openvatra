import { useId, useState } from 'react'
import { ModelList } from '@renderer/components/settings/ModelList'
import { PathRow } from '@renderer/components/settings/PathRow'
import { SegmentedControl } from '@renderer/components/settings/SegmentedControl'
import { SettingRow } from '@renderer/components/settings/SettingRow'
import { ArgsField } from '@renderer/components/settings/ArgsField'
import { idleOptions } from '@renderer/lib/idleOptions'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged, settingsReplaced } from '@renderer/store/settingsSlice'
import type { PickTarget } from '../../../../shared/ipc'

/** Settings → Models: where llama.cpp and the models are, arguments and idle time for all models, and the models. */
export function ModelsSection(): React.JSX.Element {
  const { models } = useAppSelector(selectSettings)
  const dispatch = useAppDispatch()
  const idleId = useId()
  const [problem, setProblem] = useState<string>()

  // Main shows the dialog and saves the choice, then hands back the saved settings.
  async function pick(target: PickTarget): Promise<void> {
    setProblem(undefined)
    try {
      const saved = await window.api.files.pick(target)
      if (saved) dispatch(settingsReplaced(saved))
    } catch {
      setProblem('That path could not be saved.')
    }
  }

  const idle = idleOptions.find((option) => option.minutes === models.idleUnloadMinutes) ?? idleOptions[1]

  return (
    <div className="flex flex-col">
      <PathRow
        label="llama-server.exe"
        hint="The program that runs the models, from a llama.cpp release."
        path={models.llamaServerPath}
        onBrowse={() => void pick('llamaServer')}
      />
      <PathRow
        label="Models folder"
        hint="Every .gguf file in it, subfolders included, is a model."
        path={models.modelsDir}
        onBrowse={() => void pick('modelsDir')}
      />
      {problem && (
        <p role="alert" className="pt-3 text-destructive">
          {problem}
        </p>
      )}

      <SettingRow
        label="Unload models after"
        hint="A model nobody has used for this long gives its memory back."
        labelId={idleId}
      >
        <SegmentedControl
          labelledBy={idleId}
          value={idle.value}
          options={idleOptions}
          onChange={(value) => {
            const option = idleOptions.find((candidate) => candidate.value === value)
            if (option) dispatch(settingsChanged({ models: { idleUnloadMinutes: option.minutes } }))
          }}
        />
      </SettingRow>

      <div className="border-b border-border py-4">
        <ArgsField
          label="Arguments for every model"
          value={models.sharedArgs}
          placeholder="-fa on -ctk q8_0 -ctv q8_0 --jinja"
          hint='llama-server arguments, typed like in a llama-swap config. Use "…" around values with spaces.'
          onCommit={(text) => dispatch(settingsChanged({ models: { sharedArgs: text } }))}
        />
      </div>

      <ModelList />
    </div>
  )
}
