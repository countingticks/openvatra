// The settings file's shape, written once as a zod schema.
// zod checks data at runtime (a file on disk or an IPC message can hold anything), and `z.infer` derives the
// TypeScript type from the same schema, so the check and the type can never disagree.
import { z } from 'zod'

export const tabIds = ['chat', 'code', 'automations', 'settings'] as const
export type TabId = (typeof tabIds)[number]

/** Bump when the file's shape changes in a way old files can't satisfy, and add a migration for it. */
export const settingsSchemaVersion = 1

const theme = z.enum(['system', 'light', 'dark'])
const startWithWindows = z.boolean()
const lastTab = z.enum(tabIds)

export const settingsSchema = z.object({
  schemaVersion: z.literal(settingsSchemaVersion),
  theme: theme.default('system'),
  startWithWindows: startWithWindows.default(false),
  lastTab: lastTab.default('chat'),
  window: z
    .object({ x: z.number(), y: z.number(), width: z.number().min(800), height: z.number().min(560) })
    .optional()
})

export type Settings = z.infer<typeof settingsSchema>

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
