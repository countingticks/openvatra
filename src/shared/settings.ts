// The settings file's shape, written once as a zod schema.
// zod checks data at runtime (a file on disk or an IPC message can hold anything), and `z.infer` derives the
// TypeScript type from the same schema, so the check and the type can never disagree.
import { z } from 'zod'

// Settings is a dialog, not a tab (since schema version 2).
export const tabIds = ['chat', 'code', 'automations'] as const
export type TabId = (typeof tabIds)[number]

/**
 * Bump when the file's shape changes in a way old files can't satisfy, and add a migration for it
 * (src/main/settings.ts). 2: `lastTab` can no longer be 'settings'. 3: added `models`.
 */
export const settingsSchemaVersion = 3

/** The smallest the window may be. Shared so the schema, the window and the bounds math agree. */
export const windowMinSize = { width: 800, height: 560 } as const

export const themes = ['system', 'light', 'dark'] as const
/** What closing the window does: keep running in the tray, or quit the app. */
export const closeActions = ['tray', 'quit'] as const
/** Animations: follow Windows' reduced-motion setting, or always / never animate. */
export const motions = ['system', 'on', 'off'] as const

const theme = z.enum(themes)
const startWithWindows = z.boolean()
const lastTab = z.enum(tabIds)
const closeAction = z.enum(closeActions)
const sidebarOpen = z.boolean()
const motion = z.enum(motions)

/** Minutes a model may sit unused before core unloads it; null means never. */
export const idleUnloadMinutesChoices = [5, 15, 60] as const

/** Per-model llama-server tweaks; a missing field means llama-server's own default (0 gpuLayers = CPU only). */
export const modelOptionsSchema = z.strictObject({
  contextSize: z.number().int().positive().optional(),
  gpuLayers: z.number().int().min(0).optional(),
  // An argument list passed straight to the process, never a command string: no shell ever sees it.
  extraArgs: z.array(z.string().max(1000)).max(50).optional()
})

// Bare field schemas, shared by the file schema (with defaults) and the UI patch (without).
const modelId = z.string().min(1)
const idleUnloadMinutes = z.union(idleUnloadMinutesChoices.map((minutes) => z.literal(minutes))).nullable()
const modelOptionsById = z.record(modelId, modelOptionsSchema)

/** What core needs to run models. main sends it to core.exe (POST /api/config) on start and on every change. */
export const modelsSettingsSchema = z.object({
  /** Full path to llama-server.exe; null until chosen. */
  llamaServerPath: z.string().min(1).nullable().default(null),
  modelsDir: z.string().min(1).nullable().default(null),
  /** A model id (its file name without .gguf). */
  embeddingModel: modelId.nullable().default(null),
  idleUnloadMinutes: idleUnloadMinutes.default(15),
  options: modelOptionsById.default({})
})

/** The window's last normal (not maximized) position and size, in DIPs. */
export const windowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(windowMinSize.width),
  height: z.number().min(windowMinSize.height)
})

export const settingsSchema = z.object({
  schemaVersion: z.literal(settingsSchemaVersion),
  theme: theme.default('system'),
  startWithWindows: startWithWindows.default(false),
  lastTab: lastTab.default('chat'),
  closeAction: closeAction.default('tray'),
  sidebarOpen: sidebarOpen.default(true),
  motion: motion.default('system'),
  window: windowBoundsSchema.optional(),
  // prefault, not default: the empty object still runs through the field defaults above.
  models: modelsSettingsSchema.prefault({}),
  /** The "still running in the tray" notice is shown once, the first time the window is closed. */
  closeToTrayNoticeShown: z.boolean().default(false)
})

export type Settings = z.infer<typeof settingsSchema>
export type ModelsSettings = z.infer<typeof modelsSettingsSchema>
export type WindowBounds = z.infer<typeof windowBoundsSchema>

// Frozen so no caller can change the defaults everyone else gets.
export const defaultSettings: Readonly<Settings> = Object.freeze(
  settingsSchema.parse({ schemaVersion: settingsSchemaVersion })
)

/**
 * A change sent by the UI over IPC. Only these keys, and any other key is an error (strict), because the UI is
 * untrusted: window bounds, the tray notice flag and schemaVersion belong to the main process. Built from the bare
 * field schemas, not settingsSchema, because a zod default would fill in absent keys and turn `{}` into "reset
 * everything".
 */
export const settingsPatchSchema = z.strictObject({
  theme: theme.optional(),
  startWithWindows: startWithWindows.optional(),
  lastTab: lastTab.optional(),
  closeAction: closeAction.optional(),
  sidebarOpen: sidebarOpen.optional(),
  motion: motion.optional(),
  // No paths: core runs llamaServerPath, so only main's own file dialog may set it (files.pick), never the UI.
  models: z
    .strictObject({
      embeddingModel: modelId.nullable().optional(),
      idleUnloadMinutes: idleUnloadMinutes.optional(),
      /** The whole map: the UI sends every model's options, not one model's. */
      options: modelOptionsById.optional()
    })
    .optional()
})

export type SettingsPatch = z.infer<typeof settingsPatchSchema>

/** Drops keys whose value is undefined: an optional key left out means "no change", not "store undefined". */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>
}

/**
 * The one merge rule, used by main (to save) and the UI (to show the change at once): top-level keys replace,
 * `models` merges key by key, so changing the embedding model keeps the paths.
 */
export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  const { models, ...rest } = patch
  return {
    ...settings,
    ...defined(rest),
    ...(models && { models: { ...settings.models, ...defined(models) } })
  }
}
