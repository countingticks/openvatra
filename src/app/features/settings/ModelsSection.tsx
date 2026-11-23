import { useId, useState } from 'react'
import { Button } from '@app/ui/button'
import { GpuCard } from '@app/features/models'
import { InstalledModels } from '@app/features/models'
import { ModelList } from '@app/features/models'
import { PathRow } from './PathRow'
import { SegmentedControl } from '@app/ui/SegmentedControl'
import { SettingRow } from './SettingRow'
import { Switch } from '@app/ui/switch'
import { useGetEnginesQuery } from '@app/core/generated'
import { usePlatform } from '@app/platform/usePlatform'
import { useEngineSettings } from '@app/features/models'
import { useLlamacppSettings } from '@app/features/models'
import { idleOptions } from '@app/features/models'
import { useAppDispatch, useAppSelector } from '@app/store/hooks'
import { selectSettings, settingsChanged } from '@app/store/settingsSlice'
import { modelsDialogOpened, settingsClosed } from '@app/store/uiSlice'
import type { LlamacppChange } from '@app/features/models'
import type { PickTarget } from '@shared/ipc'

/** Settings → Models: the simple view (folder, installed models, get more, unload timer) and, behind *Show advanced*, the engine, embedding model and per-model options. */
export function ModelsSection(): React.JSX.Element {
  const { showAdvancedModels: showAdvanced } = useAppSelector(selectSettings)
  const { value: llamacpp, update } = useLlamacppSettings()
  const { value: engine, update: updateEngine } = useEngineSettings()
  const dispatch = useAppDispatch()
  const { files } = usePlatform()
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
      await files?.pick(target)
    } catch {
      setProblem('That path could not be saved.')
    }
  }

  function change(next: LlamacppChange): void {
    setProblem(undefined)
    update(next).catch((error: Error) => setProblem(error.message))
  }

  function fail(write: Promise<void>): void {
    setProblem(undefined)
    write.catch((error: Error) => setProblem(error.message))
  }

  const idle = idleOptions.find((option) => option.minutes === llamacpp.idleUnloadMinutes) ?? idleOptions[1]

  return (
    <div className="flex flex-col">
      <PathRow
        label="Models folder"
        hint="Where your downloaded models are kept."
        path={llamacpp.modelsDir}
        defaultText="The OpenVatra\Models folder in your user folder"
        browseText="Change…"
        onBrowse={files && (() => void pick('modelsDir'))}
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
        <GpuCard />
      </div>

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

      <InstalledModels />

      <SettingRow
        label="Show advanced"
        hint="More options for people who know their way around."
        controlId={advancedId}
      >
        <Switch
          id={advancedId}
          checked={showAdvanced}
          onCheckedChange={(checked) => dispatch(settingsChanged({ showAdvancedModels: checked }))}
        />
      </SettingRow>

      {showAdvanced && (
        <>
          <PathRow
            label="llama-server.exe"
            hint="The program that runs the models. The bundled one works on any GPU; use your own for CUDA."
            path={engine.path}
            defaultText={bundledText}
            browseText="Use my own…"
            onBrowse={files && (() => void pick('llamaServer'))}
          >
            {engine.path && (
              <Button variant="outline" size="sm" onClick={() => fail(updateEngine({ path: null }))}>
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
