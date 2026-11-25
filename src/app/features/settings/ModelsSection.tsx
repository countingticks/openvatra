import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@app/ui/button'
import { DownloadsCard, EmbeddingSelect, GpuCard } from '@app/features/models'
import { ModelsTabs } from './ModelsTabs'
import { PathRow } from './PathRow'
import { SegmentedControl } from '@app/ui/SegmentedControl'
import { SettingRow } from './SettingRow'
import { useGetEnginesQuery } from '@app/core/generated'
import { usePlatform } from '@app/platform/usePlatform'
import { useEngineSettings } from '@app/features/models'
import { useLlamacppSettings } from '@app/features/models'
import { idleOptions, useModelSettingsReady } from '@app/features/models'
import { cn } from '@app/lib/utils'
import { useAppDispatch, useAppSelector } from '@app/store/hooks'
import { selectSettings, settingsChanged } from '@app/store/settingsSlice'
import type { LlamacppChange } from '@app/features/models'
import type { PickTarget } from '@shared/ipc'

/** A failed action has nothing useful to show here; log it (main copies page errors into main.log). */
function run(action: () => Promise<void>): void {
  action().catch((error) => console.error('Models service action failed', error))
}

/** Settings → Models: the GPU, folder, unload timer, the models themselves, and behind Advanced the engine and service. */
export function ModelsSection(): React.JSX.Element {
  const { showAdvancedModels: showAdvanced } = useAppSelector(selectSettings)
  const { value: llamacpp, update } = useLlamacppSettings()
  const { value: engine, update: updateEngine } = useEngineSettings()
  const ready = useModelSettingsReady()
  const dispatch = useAppDispatch()
  const { files, core } = usePlatform()
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

  // Until core has answered, every value here would be a default that then switches.
  if (!ready) return <div className="flex flex-col" />

  return (
    <div className="flex flex-col">
      <GpuCard />
      <DownloadsCard />

      <div className="pt-4">
        <PathRow
          label="Models folder"
          hint="Where your downloaded models are kept."
          path={llamacpp.modelsDir}
          defaultText="The OpenVatra\Models folder in your user folder"
          browseText="Change…"
          onBrowse={files && (() => void pick('modelsDir'))}
        />
      </div>
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

      <div className="pt-5">
        <ModelsTabs />
      </div>

      <div className="pt-5">
        <button
          type="button"
          aria-expanded={showAdvanced}
          aria-controls={advancedId}
          onClick={() => dispatch(settingsChanged({ showAdvancedModels: !showAdvanced }))}
          className="flex items-center gap-1.5 rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Advanced
          <ChevronDown
            aria-hidden
            className={cn(
              'size-4 text-muted-foreground transition-transform in-data-[motion=reduce]:transition-none',
              showAdvanced && 'rotate-180'
            )}
          />
        </button>
        {showAdvanced && (
          <div id={advancedId} className="flex flex-col">
            <PathRow
              label="llama-server.exe"
              hint={`${bundledText}. Use your own build to try a newer llama.cpp.`}
              path={engine.path}
              defaultText="Using the bundled build"
              browseText="Use my own…"
              onBrowse={files && (() => void pick('llamaServer'))}
            >
              {engine.path && (
                <Button variant="outline" size="sm" onClick={() => fail(updateEngine({ path: null }))}>
                  Use bundled
                </Button>
              )}
            </PathRow>
            <EmbeddingSelect />
            {(core.openLog || core.restart) && (
              <SettingRow label="Models service" hint="Its log, and a fresh start if it misbehaves.">
                <div className="flex gap-2">
                  {core.openLog && (
                    <Button variant="outline" size="sm" onClick={() => run(async () => core.openLog?.())}>
                      Open log
                    </Button>
                  )}
                  {core.restart && (
                    <Button variant="outline" size="sm" onClick={() => run(async () => core.restart?.())}>
                      Restart
                    </Button>
                  )}
                </div>
              </SettingRow>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
