import { useId, useState } from 'react'
import { Button } from '@app/ui/button'
import { SegmentedControl } from '@app/ui/SegmentedControl'
import {
  useCancelDownloadMutation,
  useResumeDownloadMutation,
  useStartDownloadMutation
} from '@app/core/generated'
import { gpuMemory } from './gpuMemory'
import { failureReason, formatSize } from './modelText'
import { useCudaEngine } from './useCudaEngine'
import { useEngineSettings } from './useEngineSettings'
import { cn } from '@app/lib/utils'
import { useFreshHardware } from './useFreshHardware'
import { useModels } from './useModels'
import { useSetup } from './useSetup'

type Engine = 'faster' | 'compatible'

const engines: { value: Engine; label: string }[] = [
  { value: 'faster', label: 'Faster' },
  { value: 'compatible', label: 'Compatible' }
]

// The numbers jump while the first measurement settles, and animate once they are true.
const slide = 'transition-[width] in-data-[motion=reduce]:transition-none'

const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

/** The graphics card: its memory, who holds it, and the engine switch (Faster is CUDA, Compatible is Vulkan). */
export function GpuCard(): React.JSX.Element | null {
  const { fresh } = useFreshHardware()
  const { hardware } = useSetup()
  const models = useModels()
  const { status, custom, item, progress } = useCudaEngine()
  const { value: engine, update } = useEngineSettings()
  const [startDownload] = useStartDownloadMutation()
  const [cancelDownload] = useCancelDownloadMutation()
  const [resumeDownload] = useResumeDownloadMutation()
  const labelId = useId()
  const [problem, setProblem] = useState<string>()

  if (!hardware) return null
  const card = 'flex flex-col gap-2.5 rounded-xl bg-card px-4 py-3.5'
  const { gpu } = hardware
  if (!gpu) {
    return (
      <div role="group" aria-label="Graphics card" className={card}>
        <p className="truncate">No graphics card found. Models run on the CPU.</p>
        <p className="truncate text-muted-foreground">RAM · {formatSize(hardware.ramBytes)}</p>
      </div>
    )
  }

  const running = item?.state === 'queued' || item?.state === 'downloading' || item?.state === 'verifying'
  const failed = item?.state === 'error'
  const build = engine.build
  const value: Engine =
    (build === 'auto' || build === 'cuda') && (status === 'ready' || running) ? 'faster' : 'compatible'
  const nvidia = gpu.vendor === 'nvidia'
  const memory = gpuMemory(gpu, models)
  const percent = (bytes: number): string =>
    `${memory.totalBytes > 0 ? (bytes / memory.totalBytes) * 100 : 0}%`

  const run = (work: () => Promise<unknown>): void => {
    setProblem(undefined)
    work().catch((error: unknown) => setProblem(failureReason(error)))
  }

  const choose = (next: Engine): void => {
    run(async () => {
      if (next === 'compatible') {
        await update({ build: 'bundled' })
        if (running && item) await cancelDownload({ id: item.id }).unwrap()
        return
      }
      if (status !== 'ready' && !running) {
        if (item) await resumeDownload({ id: item.id }).unwrap()
        else await startDownload({ startDownload: { engine: 'cuda' } }).unwrap()
      }
      await update({ build: 'auto' })
    })
  }

  let note: React.ReactNode
  if (custom) note = <span className="min-w-0 truncate">Your own llama-server.exe</span>
  else if (!nvidia) note = <span className="min-w-0 truncate">Vulkan</span>
  else if (running && item) {
    note = (
      <>
        <span className="min-w-0 truncate">Downloading the faster engine · {progress}%</span>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => run(() => cancelDownload({ id: item.id }).unwrap())}
        >
          Cancel
        </Button>
      </>
    )
  } else if (failed && item) {
    note = (
      <span role="alert" className="min-w-0 truncate text-destructive">
        {item.error ?? 'The download failed.'}
      </span>
    )
  } else {
    note = (
      <span className="min-w-0 truncate">
        {value === 'faster' ? 'CUDA, for NVIDIA cards' : 'Vulkan, works on any card'}
      </span>
    )
  }

  const legend = [
    { label: 'Model', bytes: memory.modelBytes, swatch: 'bg-brand' },
    { label: 'Other apps', bytes: memory.otherBytes, swatch: 'bg-subtle' },
    { label: 'Free', bytes: memory.freeBytes, swatch: 'bg-border-strong' }
  ]
  const size = formatSize(gpu.totalBytes)

  return (
    <>
      <div role="group" aria-label="Graphics card" className={card}>
        <div
          title={`${gpu.name}, ${size} of video memory`}
          className="flex min-w-0 items-center justify-between gap-3"
        >
          <p className="flex min-w-0 gap-1.5">
            <span className="truncate font-medium">{gpu.name}</span>
            <span className="shrink-0 text-muted-foreground">· {size}</span>
          </p>
          {nvidia && !custom && (
            <div className="-my-1 shrink-0">
              <span id={labelId} className="sr-only">
                Engine
              </span>
              <SegmentedControl labelledBy={labelId} value={value} options={engines} onChange={choose} />
            </div>
          )}
        </div>

        <div
          role="img"
          aria-label={`Model ${gigabytes(memory.modelBytes)}, other apps ${gigabytes(memory.otherBytes)}, free ${gigabytes(memory.freeBytes)} of ${gigabytes(memory.totalBytes)}`}
          className="flex h-2 overflow-hidden rounded-full bg-[#E9E9EC] dark:bg-border-strong"
        >
          <div
            data-slide={fresh ? '' : undefined}
            className={cn('bg-brand', fresh && slide)}
            style={{ width: percent(memory.modelBytes) }}
          />
          <div
            data-slide={fresh ? '' : undefined}
            className={cn('bg-subtle', fresh && slide)}
            style={{ width: percent(memory.otherBytes) }}
          />
        </div>

        <div className="flex min-w-0 items-center gap-4 text-[12.5px]">
          {legend.map(({ label, bytes, swatch }) => (
            <span key={label} className="flex shrink-0 items-center gap-1.5">
              <span aria-hidden className={`size-2 rounded-full ${swatch}`} />
              {label} · {gigabytes(bytes)}
            </span>
          ))}
          <span className="ml-auto flex min-w-0 items-center gap-2 text-muted-foreground">{note}</span>
        </div>
      </div>
      {problem && (
        <p role="alert" className="pt-2 text-destructive">
          {problem}
        </p>
      )}
    </>
  )
}
