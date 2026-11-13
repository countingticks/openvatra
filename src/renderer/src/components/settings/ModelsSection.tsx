import { useId, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { CudaEngineOffer } from '@renderer/components/CudaEngineOffer'
import { InstalledModels } from '@renderer/components/settings/InstalledModels'
import { ModelList } from '@renderer/components/settings/ModelList'
import { PathRow } from '@renderer/components/settings/PathRow'
import { SegmentedControl } from '@renderer/components/settings/SegmentedControl'
import { SettingRow } from '@renderer/components/settings/SettingRow'
import { Switch } from '@renderer/components/ui/switch'
import { useGetEnginesQuery } from '@renderer/core/generated'
import { idleOptions } from '@renderer/lib/idleOptions'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged, settingsReplaced } from '@renderer/store/settingsSlice'
import { modelsDialogOpened, settingsClosed } from '@renderer/store/uiSlice'
import type { PickTarget } from '../../../../shared/ipc'

/** Settings → Models: the simple view (folder, installed models, get more, unload timer) and, behind *Show advanced*, the engine, embedding model and per-model options. */
export function ModelsSection(): React.JSX.Element {
  const { models } = useAppSelector(selectSettings)
  const dispatch = useAppDispatch()
  const idleId = useId()
  const advancedId = useId()
  const [problem, setProblem] = useState<string>()
  // Only for the label; without core's answer, "Bundled (Vulkan)" is still true.
  const bundledTag = useGetEnginesQuery().data?.bundled.tag ?? null
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
        label="Models folder"
        hint="Where your downloaded models are kept."
        path={models.modelsDir}
        defaultText="The OpenVatra\Models folder in your user folder"
        browseText="Change…"
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

      <CudaEngineOffer variant="row" />

      <InstalledModels />

      <SettingRow
        label="Show advanced"
        hint="More options for people who know their way around."
        controlId={advancedId}
      >
        <Switch
          id={advancedId}
          checked={models.showAdvanced}
          onCheckedChange={(checked) => dispatch(settingsChanged({ models: { showAdvanced: checked } }))}
        />
      </SettingRow>

      {models.showAdvanced && (
        <>
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
          <ModelList />
        </>
      )}
    </div>
  )
}
