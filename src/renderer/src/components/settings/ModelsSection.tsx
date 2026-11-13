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
import { useModelSettings } from '@renderer/hooks/useModelSettings'
import { idleOptions } from '@renderer/lib/idleOptions'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged } from '@renderer/store/settingsSlice'
import { modelsDialogOpened, settingsClosed } from '@renderer/store/uiSlice'
import type { ModelsChange } from '@renderer/core/modelSettings'
import type { PickTarget } from '../../../../shared/ipc'

/** Settings → Models: the simple view (folder, installed models, get more, unload timer) and, behind *Show advanced*, the engine, embedding model and per-model options. */
export function ModelsSection(): React.JSX.Element {
  const { showAdvanced } = useAppSelector(selectSettings).models
  const { value: models, update } = useModelSettings()
  const dispatch = useAppDispatch()
  const idleId = useId()
  const advancedId = useId()
  const [problem, setProblem] = useState<string>()
  // Only for the label; without core's answer, "Bundled (Vulkan)" is still true.
  const bundledTag = useGetEnginesQuery().data?.bundled.tag ?? null
  const bundledText = `Bundled (${bundledTag ? `${bundledTag}, ` : ''}Vulkan)`

  // Main shows the dialog and saves the choice in core; the new path arrives through core's config.changed.
  async function pick(target: PickTarget): Promise<void> {
    setProblem(undefined)
    try {
      await window.api.files.pick(target)
    } catch {
      setProblem('That path could not be saved.')
    }
  }

  function change(next: ModelsChange): void {
    setProblem(undefined)
    update(next).catch((error: Error) => setProblem(error.message))
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
            if (option) change({ idleUnloadMinutes: option.minutes })
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
          checked={showAdvanced}
          onCheckedChange={(checked) => dispatch(settingsChanged({ models: { showAdvanced: checked } }))}
        />
      </SettingRow>

      {showAdvanced && (
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
              <Button variant="outline" size="sm" onClick={() => change({ llamaServerPath: null })}>
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
