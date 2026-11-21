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
 * 4: model options became llama-swap style argument text (`sharedArgs`, `options[id].args`).
 * 5: `sharedArgs` and the per-model unload time and projector switch were removed.
 * 6: added `models.engine`, `showAdvanced` and `cudaOfferDismissed` (model setup).
 * 7: model settings moved to core; the two view preferences moved to the top level.
 * 8: `lastTab` became `lastRoute`, a route path.
 */
export const settingsSchemaVersion = 8

/** The smallest the window may be. Shared so the schema, the window and the bounds math agree. */
export const windowMinSize = { width: 800, height: 560 } as const

export const themes = ['system', 'light', 'dark'] as const
/** What closing the window does: keep running in the tray, or quit the app. */
export const closeActions = ['tray', 'quit'] as const
/** Animations: follow Windows' reduced-motion setting, or always / never animate. */
export const motions = ['system', 'on', 'off'] as const

const theme = z.enum(themes)
const startWithWindows = z.boolean()
/** A route path (src/app/store/route.ts); the app falls back to Chat when it names nothing. */
const lastRoute = z
  .string()
  .max(512)
  .regex(/^(chat|code|automations)(\/.*)?$/)
const closeAction = z.enum(closeActions)
const sidebarOpen = z.boolean()
const motion = z.enum(motions)

/** Which llama.cpp build runs the models: the one shipped with the app, or the faster NVIDIA (CUDA) one. */
export const engines = ['bundled', 'cuda'] as const

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
  lastRoute: lastRoute.default('chat'),
  closeAction: closeAction.default('tray'),
  sidebarOpen: sidebarOpen.default(true),
  motion: motion.default('system'),
  window: windowBoundsSchema.optional(),
  /** The "still running in the tray" notice is shown once, the first time the window is closed. */
  closeToTrayNoticeShown: z.boolean().default(false)
}

/** The window's Settings (IPC). Core owns everything about models. */
export const settingsSchema = z.object({
  ...topLevelShape,
  /** Show the full model list and technical details instead of the simple view. */
  showAdvancedModels: z.boolean().default(false),
  /** The user said "no thanks" to the faster NVIDIA engine offer. */
  cudaOfferDismissed: z.boolean().default(false)
})

/**
 * settings.json (v8): the file holds exactly the window's Settings. zod strips any other key, so a leftover
 * `legacyModels` is dropped on load.
 */
export const settingsFileSchema = settingsSchema

export type Settings = z.infer<typeof settingsSchema>
export type SettingsFile = z.infer<typeof settingsFileSchema>
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
  lastRoute: lastRoute.optional(),
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
