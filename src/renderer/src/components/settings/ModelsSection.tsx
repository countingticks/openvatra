import { useId, useState } from 'react'
import { ModelList } from '@renderer/components/settings/ModelList'
import { PathRow } from '@renderer/components/settings/PathRow'
import { SegmentedControl } from '@renderer/components/settings/SegmentedControl'
import { SettingRow } from '@renderer/components/settings/SettingRow'
import { idleOptions } from '@renderer/lib/idleOptions'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged, settingsReplaced } from '@renderer/store/settingsSlice'
import type { PickTarget } from '../../../../shared/ipc'

/** Settings → Models: where llama.cpp and the models are, how long models stay loaded, the embedding model, and each model's options. */
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
        hint="Searches subfolders too."
        path={models.modelsDir}
        onBrowse={() => void pick('modelsDir')}
      />
      {problem && (
        <p role="alert" className="pt-3 text-destructive">
          {problem}
        </p>
      )}

      <SettingRow label="Unload models after" hint="Frees an idle model's memory." labelId={idleId}>
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

      <ModelList />
    </div>
  )
}
