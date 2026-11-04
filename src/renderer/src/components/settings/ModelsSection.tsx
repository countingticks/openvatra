import { useEffect, useId, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { ModelList } from '@renderer/components/settings/ModelList'
import { PathRow } from '@renderer/components/settings/PathRow'
import { SegmentedControl } from '@renderer/components/settings/SegmentedControl'
import { SettingRow } from '@renderer/components/settings/SettingRow'
import { idleOptions } from '@renderer/lib/idleOptions'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged, settingsReplaced } from '@renderer/store/settingsSlice'
import { modelsDialogOpened, settingsClosed } from '@renderer/store/uiSlice'
import type { PickTarget } from '../../../../shared/ipc'

/** Settings → Models: where llama.cpp and the models are, how long models stay loaded, the embedding model, and each model's options. */
export function ModelsSection(): React.JSX.Element {
  const { models } = useAppSelector(selectSettings)
  const dispatch = useAppDispatch()
  const idleId = useId()
  const [problem, setProblem] = useState<string>()
  const [bundledTag, setBundledTag] = useState<string | null>(null)

  useEffect(() => {
    // Only for the label; if main can't answer, "Bundled (Vulkan)" is still true.
    window.api.files.bundledLlama().then(
      ({ tag }) => setBundledTag(tag),
      () => undefined
    )
  }, [])
  const bundledText = `Bundled (${bundledTag ? `${bundledTag}, ` : ''}Vulkan)`

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

  async function switchToBundled(): Promise<void> {
    setProblem(undefined)
    try {
      dispatch(settingsReplaced(await window.api.files.useBundledLlama()))
    } catch {
      setProblem('That setting could not be saved.')
    }
  }

  const idle = idleOptions.find((option) => option.minutes === models.idleUnloadMinutes) ?? idleOptions[1]

  return (
    <div className="flex flex-col">
      <PathRow
        label="llama-server.exe"
        hint="The program that runs the models. The bundled one works on any GPU; use your own for CUDA."
        path={models.llamaServerPath}
        defaultText={bundledText}
        browseText="Use my own…"
        onBrowse={() => void pick('llamaServer')}
      >
        {models.llamaServerPath && (
          <Button variant="outline" size="sm" onClick={() => void switchToBundled()}>
            Use bundled
          </Button>
        )}
      </PathRow>
      <PathRow
        label="Models folder"
        hint="Scans this folder and its subfolders."
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

      <div className="pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // One dialog at a time: the Models dialog replaces Settings instead of stacking on it.
            dispatch(settingsClosed())
            dispatch(modelsDialogOpened())
          }}
        >
          Get more models…
        </Button>
      </div>

      <ModelList />
    </div>
  )
}
