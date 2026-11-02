// The settings file's shape, written once as a zod schema.
// zod checks data at runtime (a file on disk or an IPC message can hold anything), and `z.infer` derives the
// TypeScript type from the same schema, so the check and the type can never disagree.
import { z } from 'zod'

export const tabIds = ['chat', 'code', 'automations', 'settings'] as const
export type TabId = (typeof tabIds)[number]

/** Bump when the file's shape changes in a way old files can't satisfy, and add a migration for it. */
export const settingsSchemaVersion = 1

export const settingsSchema = z.object({
  schemaVersion: z.literal(settingsSchemaVersion),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  startWithWindows: z.boolean().default(false),
  lastTab: z.enum(tabIds).default('chat'),
  window: z
    .object({ x: z.number(), y: z.number(), width: z.number().min(800), height: z.number().min(560) })
    .optional()
})

export type Settings = z.infer<typeof settingsSchema>

// Frozen so no caller can change the defaults everyone else gets.
export const defaultSettings: Readonly<Settings> = Object.freeze(
  settingsSchema.parse({ schemaVersion: settingsSchemaVersion })
)
