// The window's Settings, composed from two owners: settings.json (the store) and core's `models` section (model
// settings). A change from the window is split between them: core's keys go to core first, the rest to the file.
// No Electron imports, so it's unit-testable.
import {
  legacyModelsSchema,
  type Settings,
  settingsPatchSchema,
  settingsSchemaVersion
} from '../shared/settings'
import type { CoreModels } from './core/configClient'
import type { ModelSettings } from './core/modelSettings'
import type { FilePatch, SettingsStore } from './settingsStore'

export type ModelPathKey = 'llamaServerPath' | 'modelsDir'

/** A core-side failure, whose message is meant for people (core's sentence, or "not running"). */
export class ModelsUpdateError extends Error {}

export interface SettingsService {
  /** The IPC Settings: the file plus core's models (decision 1). */
  get(): Settings
  /** `patch` is untrusted: anything but a valid SettingsPatch rejects with the ZodError. */
  update(patch: unknown): Promise<Settings>
  /** Main only (its file dialog or "use bundled"); null = the default. */
  setModelPath(key: ModelPathKey, path: string | null): Promise<Settings>
  /** Called when the composed value changes, from the file or from core; returns unsubscribe. */
  onChange(listener: (settings: Settings) => void): () => void
}

/** What the window is told when an update fails: a ModelsUpdateError's message, else "Settings could not be updated". */
export function updateErrorMessage(error: unknown): string {
  return error instanceof ModelsUpdateError ? error.message : 'Settings could not be updated'
}

/** Drops keys whose value is undefined: an optional key left out means "no change". */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>
}

export function createSettingsService(store: SettingsStore, models: ModelSettings): SettingsService {
  const listeners = new Set<(settings: Settings) => void>()

  function get(): Settings {
    const { showAdvancedModels, cudaOfferDismissed, legacyModels, ...file } = store.get()
    // Before core has answered once in this run: the v6 values still waiting for the import, else the defaults.
    const base = models.entry()?.value ?? legacyModels ?? legacyModelsSchema.parse({})
    return {
      ...file,
      schemaVersion: settingsSchemaVersion,
      models: { ...base, showAdvanced: showAdvancedModels, cudaOfferDismissed }
    }
  }

  async function updateCore(change: Partial<CoreModels>): Promise<void> {
    try {
      await models.update(change)
    } catch (error) {
      throw new ModelsUpdateError(error instanceof Error ? error.message : String(error), { cause: error })
    }
  }

  async function update(patch: unknown): Promise<Settings> {
    const { models: modelsPatch, ...top } = settingsPatchSchema.parse(patch)
    const { showAdvanced, cudaOfferDismissed, ...coreKeys } = modelsPatch ?? {}
    const coreChange = defined(coreKeys)
    const filePatch: FilePatch = defined({ ...top, showAdvancedModels: showAdvanced, cudaOfferDismissed })
    // Core first: if it refuses, the file part is not saved either, so a change applies whole or not at all.
    if (Object.keys(coreChange).length > 0) await updateCore(coreChange)
    if (Object.keys(filePatch).length > 0) await store.update(filePatch)
    return get()
  }

  async function setModelPath(key: ModelPathKey, path: string | null): Promise<Settings> {
    await updateCore({ [key]: path })
    return get()
  }

  let last = JSON.stringify(get())
  function notify(): void {
    const settings = get()
    const text = JSON.stringify(settings)
    if (text === last) return
    last = text
    for (const listener of listeners) listener(structuredClone(settings))
  }
  store.onChange(notify)
  models.onChange(notify)

  return {
    get,
    update,
    setModelPath,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
