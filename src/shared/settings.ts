// The settings file's shape, written once as a zod schema.
// zod checks data at runtime (a file on disk or an IPC message can hold anything), and `z.infer` derives the
// TypeScript type from the same schema, so the check and the type can never disagree.
import { z } from 'zod'

export const tabIds = ['chat', 'code', 'automations', 'settings'] as const
export type TabId = (typeof tabIds)[number]

/** Bump when the file's shape changes in a way old files can't satisfy, and add a migration for it. */
export const settingsSchemaVersion = 1

/** The smallest the window may be. Shared so the schema, the window and the bounds math agree. */
export const windowMinSize = { width: 800, height: 560 } as const

const theme = z.enum(['system', 'light', 'dark'])
const startWithWindows = z.boolean()
const lastTab = z.enum(tabIds)

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
  window: windowBoundsSchema.optional()
})

export type Settings = z.infer<typeof settingsSchema>
export type WindowBounds = z.infer<typeof windowBoundsSchema>

// Frozen so no caller can change the defaults everyone else gets.
export const defaultSettings: Readonly<Settings> = Object.freeze(
  settingsSchema.parse({ schemaVersion: settingsSchemaVersion })
)

/**
 * A change sent by the UI over IPC. Only these keys, and any other key is an error (strict), because the UI is
 * untrusted: window bounds and schemaVersion belong to the main process. Built from the bare field schemas, not
 * settingsSchema, because a zod default would fill in absent keys and turn `{}` into "reset everything".
 */
export const settingsPatchSchema = z.strictObject({
  theme: theme.optional(),
  startWithWindows: startWithWindows.optional(),
  lastTab: lastTab.optional()
})

export type SettingsPatch = z.infer<typeof settingsPatchSchema>
