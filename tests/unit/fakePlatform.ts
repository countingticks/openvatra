// A desktop-shaped Platform made of mocks: what the UI gets from its host, with a way to play the host's pushes.
import { vi, type Mock } from 'vitest'
import type { CoreState } from '../../src/shared/core'
import type { AppWindowApi, FileLocations, FilesApi, SettingsApi } from '../../src/shared/ipc'
import { applyPatch, defaultSettings, type Settings } from '../../src/shared/settings'
import type { Platform } from '@app/platform/platform'

export const exampleLocations: FileLocations = {
  settingsFile: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\settings.json',
  logsFolder: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\logs'
}

export type OptionalMember = 'window' | 'files' | 'quit' | 'restart' | 'openLog'

export interface FakePlatformOptions {
  /** What core.state() answers; omitted: it never answers until core.answer() (store-only tests stay offline). */
  coreState?: CoreState
  /** What prefs hold at the start; default defaultSettings. */
  settings?: Settings
  /** What window.isMaximized() answers; default false. */
  maximized?: boolean
  /** Members left out, to test a host without them. */
  omit?: readonly OptionalMember[]
}

export interface FakePlatform {
  platform: Platform
  prefs: {
    get: Mock<SettingsApi['get']>
    update: Mock<SettingsApi['update']>
    /** Plays main's settings:changed push; also becomes what get/update start from. */
    emit(settings: Settings): void
  }
  core: {
    state: Mock<() => Promise<CoreState>>
    restart: Mock<() => Promise<void>>
    openLog: Mock<() => Promise<void>>
    /** Plays main's core:state push. */
    emit(state: CoreState): void
    /** Resolves a state() call that is still pending (only when coreState was omitted). */
    answer(state: CoreState): void
  }
  window: {
    minimize: Mock<AppWindowApi['minimize']>
    toggleMaximize: Mock<AppWindowApi['toggleMaximize']>
    close: Mock<AppWindowApi['close']>
    isMaximized: Mock<AppWindowApi['isMaximized']>
    edit: Mock<AppWindowApi['edit']>
    emitMaximized(maximized: boolean): void
    /** How many onMaximizedChange subscribers are live. */
    listeners(): number
  }
  files: {
    locations: Mock<FilesApi['locations']>
    openFolder: Mock<FilesApi['openFolder']>
    pick: Mock<FilesApi['pick']>
  }
  quit: Mock<() => Promise<void>>
}

function subscribers<T>(): {
  add(callback: (value: T) => void): () => void
  emit(value: T): void
  size(): number
} {
  const callbacks = new Set<(value: T) => void>()
  return {
    add: (callback) => {
      callbacks.add(callback)
      return () => callbacks.delete(callback)
    },
    emit: (value) => callbacks.forEach((callback) => callback(value)),
    size: () => callbacks.size
  }
}

export function fakePlatform(options: FakePlatformOptions = {}): FakePlatform {
  const omit = new Set(options.omit ?? [])
  let current: Settings = options.settings ?? defaultSettings

  const settingsPushes = subscribers<Settings>()
  const prefs: FakePlatform['prefs'] = {
    get: vi.fn<SettingsApi['get']>(async () => current),
    update: vi.fn<SettingsApi['update']>(async (patch) => (current = applyPatch(current, patch))),
    emit: (settings) => {
      current = settings
      settingsPushes.emit(settings)
    }
  }

  const statePushes = subscribers<CoreState>()
  const pending: Array<(state: CoreState) => void> = []
  const { coreState } = options
  const core: FakePlatform['core'] = {
    state: vi.fn<() => Promise<CoreState>>(() =>
      coreState ? Promise.resolve(coreState) : new Promise((resolve) => pending.push(resolve))
    ),
    restart: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    openLog: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    emit: (state) => statePushes.emit(state),
    answer: (state) => pending.splice(0).forEach((resolve) => resolve(state))
  }

  const maximizedPushes = subscribers<boolean>()
  const windowFake: FakePlatform['window'] = {
    minimize: vi.fn<AppWindowApi['minimize']>().mockResolvedValue(undefined),
    toggleMaximize: vi.fn<AppWindowApi['toggleMaximize']>().mockResolvedValue(undefined),
    close: vi.fn<AppWindowApi['close']>().mockResolvedValue(undefined),
    isMaximized: vi.fn<AppWindowApi['isMaximized']>().mockResolvedValue(options.maximized ?? false),
    edit: vi.fn<AppWindowApi['edit']>().mockResolvedValue(undefined),
    emitMaximized: (maximized) => maximizedPushes.emit(maximized),
    listeners: () => maximizedPushes.size()
  }

  const files: FakePlatform['files'] = {
    locations: vi.fn<FilesApi['locations']>().mockResolvedValue(exampleLocations),
    openFolder: vi.fn<FilesApi['openFolder']>().mockResolvedValue(undefined),
    pick: vi.fn<FilesApi['pick']>().mockResolvedValue(false)
  }
  const quit = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

  const platform: Platform = {
    kind: 'desktop',
    core: {
      state: core.state,
      onState: statePushes.add,
      ...(omit.has('restart') ? {} : { restart: core.restart }),
      ...(omit.has('openLog') ? {} : { openLog: core.openLog })
    },
    prefs: { get: prefs.get, update: prefs.update, onChange: settingsPushes.add },
    ...(omit.has('window')
      ? {}
      : {
          window: {
            minimize: windowFake.minimize,
            toggleMaximize: windowFake.toggleMaximize,
            close: windowFake.close,
            isMaximized: windowFake.isMaximized,
            edit: windowFake.edit,
            onMaximizedChange: maximizedPushes.add
          }
        }),
    ...(omit.has('files') ? {} : { files }),
    ...(omit.has('quit') ? {} : { quit })
  }

  return { platform, prefs, core, window: windowFake, files, quit }
}
