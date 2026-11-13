// The settings file's shape, written once as a zod schema.
// zod checks data at runtime (a file on disk or an IPC message can hold anything), and `z.infer` derives the
// TypeScript type from the same schema, so the check and the type can never disagree.
import { z } from 'zod'
import { splitArgs } from './args'

// Settings is a dialog, not a tab (since schema version 2).
export const tabIds = ['chat', 'code', 'automations'] as const
export type TabId = (typeof tabIds)[number]

/**
 * Bump when the file's shape changes in a way old files can't satisfy, and add a migration for it
 * (src/main/settings.ts). 2: `lastTab` can no longer be 'settings'. 3: added `models`.
 * 4: model options became llama-swap style argument text (`sharedArgs`, `options[id].args`).
 * 5: `sharedArgs` and the per-model unload time and projector switch were removed.
 * 6: added `models.engine`, `showAdvanced` and `cudaOfferDismissed` (model setup).
 * 7: model settings moved to core; the file keeps `legacyModels` until they are imported, and the two view
 * preferences at the top level.
 */
export const settingsSchemaVersion = 7

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
export const idleUnloadMinutesChoices = [5, 15, 30, 60] as const

/**
 * llama-server arguments as the user typed them (`-c 131072 --jinja`). Kept as text so the box shows exactly what
 * was typed; main splits it into a list for core (src/shared/args.ts), and text that doesn't split is never saved.
 */
const argsText = z
  .string()
  .refine((text) => splitArgs(text).ok, { message: 'invalid llama-server arguments' })

// Bare field schemas, shared by the file schema (with defaults) and the UI patch (without).
const modelId = z.string().min(1)
const idleUnloadMinutes = z.union(idleUnloadMinutesChoices.map((minutes) => z.literal(minutes))).nullable()

/**
 * One model's own settings. Arguments are the only option: the projector is passed whenever one is found
 * (`--no-mmproj` in the arguments turns that off), and models unload by the global time.
 */
export const modelOptionsSchema = z.strictObject({
  args: argsText.optional()
})
const modelOptionsById = z.record(modelId, modelOptionsSchema)

/** Which llama.cpp build runs the models: the one shipped with the app, or the faster NVIDIA (CUDA) one. */
export const engines = ['bundled', 'cuda'] as const
const engine = z.enum(engines)

/** The window's last normal (not maximized) position and size, in DIPs. */
export const windowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(windowMinSize.width),
  height: z.number().min(windowMinSize.height)
})

// The keys the file and the window's Settings share.
const topLevelShape = {
  schemaVersion: z.literal(settingsSchemaVersion),
  theme: theme.default('system'),
  startWithWindows: startWithWindows.default(false),
  lastTab: lastTab.default('chat'),
  closeAction: closeAction.default('tray'),
  sidebarOpen: sidebarOpen.default(true),
  motion: motion.default('system'),
  window: windowBoundsSchema.optional(),
  /** The "still running in the tray" notice is shown once, the first time the window is closed. */
  closeToTrayNoticeShown: z.boolean().default(false)
}

/** The window's Settings (IPC): the file's keys without `legacyModels`. Core owns everything about models. */
export const settingsSchema = z.object({
  ...topLevelShape,
  /** Show the full model list and technical details instead of the simple view. */
  showAdvancedModels: z.boolean().default(false),
  /** The user said "no thanks" to the faster NVIDIA engine offer. */
  cudaOfferDismissed: z.boolean().default(false)
})

/** A v6 user's six model keys, with the v6 defaults; the shape of `legacyModels` until core has taken them. */
export const legacyModelsSchema = z.object({
  /** Full path to llama-server.exe; null = the default engine. */
  llamaServerPath: z.string().min(1).nullable().default(null),
  /** null = the default folder (`%USERPROFILE%OpenVatraModels`). */
  modelsDir: z.string().min(1).nullable().default(null),
  /** A model id (its file name without .gguf). */
  embeddingModel: modelId.nullable().default(null),
  idleUnloadMinutes: idleUnloadMinutes.default(15),
  options: modelOptionsById.default({}),
  engine: engine.default('bundled')
})

/** settings.json (v7). */
export const settingsFileSchema = settingsSchema.extend({
  /** A v6 user's model settings, kept until core has taken them (src/main/core/legacyImport.ts). */
  legacyModels: legacyModelsSchema.optional()
})

export type Settings = z.infer<typeof settingsSchema>
export type SettingsFile = z.infer<typeof settingsFileSchema>
export type LegacyModels = z.infer<typeof legacyModelsSchema>
export type ModelOptions = z.infer<typeof modelOptionsSchema>
export type WindowBounds = z.infer<typeof windowBoundsSchema>

// Frozen so no caller can change the defaults everyone else gets.
export const defaultSettings: Readonly<Settings> = Object.freeze(
  settingsSchema.parse({ schemaVersion: settingsSchemaVersion })
)
export const defaultSettingsFile: Readonly<SettingsFile> = Object.freeze(
  settingsFileSchema.parse({ schemaVersion: settingsSchemaVersion })
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
  showAdvancedModels: z.boolean().optional(),
  cudaOfferDismissed: z.boolean().optional()
})

export type SettingsPatch = z.infer<typeof settingsPatchSchema>

/** Top-level keys replace; undefined means no change. */
export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  const changes = Object.entries(patch).filter(([, value]) => value !== undefined)
  return { ...settings, ...Object.fromEntries(changes) }
}
