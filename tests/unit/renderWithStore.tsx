// Renders UI inside a real Redux store, so component tests exercise the actual reducers. Only the IPC to the main
// process is faked: settings answer like main does (with the whole saved file), window.api.files answers with
// example paths, and window.api.appWindow records the window buttons and can report maximize changes the way main
// would. tests/setup.ts removes the fake window.api after each test.
import { act, render, type RenderResult } from '@testing-library/react'
import { Provider } from 'react-redux'
import { vi, type Mock } from 'vitest'
import { createAppStore, type AppStore } from '@renderer/store/store'
import type { CoreState, ModelInfo } from '../../src/shared/core'
import type {
  Api,
  AppApi,
  AppWindowApi,
  CoreApi,
  FileLocations,
  FilesApi,
  SettingsApi,
  SetupApi
} from '../../src/shared/ipc'
import type { CatalogView, DownloadItem, HardwareReport } from '../../src/shared/setup'
import { applyPatch, defaultSettings, type Settings } from '../../src/shared/settings'

export const exampleLocations: FileLocations = {
  settingsFile: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\settings.json',
  logsFolder: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\logs'
}

/** The fake models-service API, plus a way to play main's part. */
export interface FakeCore {
  restart: Mock<CoreApi['restart']>
  openLog: Mock<CoreApi['openLog']>
  load: Mock<CoreApi['load']>
  unload: Mock<CoreApi['unload']>
  /** Report a new state, as main does on every change. */
  emitState(state: CoreState): void
  /** Report a new model list, as main does on every change. */
  emitModels(models: ModelInfo[]): void
}

/** The fake first-run setup API, plus a way to play main's part. */
export interface FakeSetup {
  download: Mock<SetupApi['download']>
  downloadEngine: Mock<SetupApi['downloadEngine']>
  cancel: Mock<SetupApi['cancel']>
  resume: Mock<SetupApi['resume']>
  remove: Mock<SetupApi['remove']>
  /** Report a new download queue, as main does on every change. */
  emitDownloads(items: DownloadItem[]): void
}

export const exampleHardware: HardwareReport = {
  gpu: {
    name: 'NVIDIA GeForce RTX 4070',
    vendor: 'nvidia',
    totalBytes: 12 * 1024 ** 3,
    freeBytes: 11 * 1024 ** 3
  },
  ramBytes: 32 * 1024 ** 3
}

/** The fake window API, plus a way to play main's part. */
export interface FakeAppWindow {
  minimize: Mock<AppWindowApi['minimize']>
  toggleMaximize: Mock<AppWindowApi['toggleMaximize']>
  close: Mock<AppWindowApi['close']>
  edit: Mock<AppWindowApi['edit']>
  /** Report a new maximized state, as main does on maximize / restore. */
  emitMaximized(maximized: boolean): void
  /** How many components are listening right now. */
  listeners(): number
}

interface Rendered extends RenderResult {
  store: AppStore
  saveSettings: Mock<SettingsApi['update']>
  /** Plays main's settings:changed push; replaces the fake's saved settings too. */
  emitSettings(settings: Settings): void
  openFolder: Mock<FilesApi['openFolder']>
  /** Answers like main after the user picked a path; set its result per test. Default: cancelled (null). */
  pick: Mock<FilesApi['pick']>
  /** Answers like main after "Use bundled"; set its result per test. */
  useBundledLlama: Mock<FilesApi['useBundledLlama']>
  appWindow: FakeAppWindow
  quit: Mock<AppApi['quit']>
  core: FakeCore
  setup: FakeSetup
}

interface Options {
  /** The window starts maximized. */
  maximized?: boolean
  /** What core's state is when the UI first asks; default: starting. */
  coreState?: CoreState
  /** The model list when the UI first asks; default: none. */
  models?: ModelInfo[]
  /** The setup answers when the UI first asks; default: example hardware, an empty catalog, no downloads. */
  setup?: { hardware?: HardwareReport; catalog?: CatalogView; downloads?: DownloadItem[] }
  /** The CUDA build's state main reports; default: not installed. */
  cuda?: 'none' | 'ready' | 'stale'
}

function fakeSetup(options: Options['setup'] = {}): { api: SetupApi; fake: FakeSetup } {
  const listeners = new Set<(items: DownloadItem[]) => void>()
  const fake: FakeSetup = {
    download: vi.fn<SetupApi['download']>().mockResolvedValue(undefined),
    downloadEngine: vi.fn<SetupApi['downloadEngine']>().mockResolvedValue(undefined),
    cancel: vi.fn<SetupApi['cancel']>().mockResolvedValue(undefined),
    resume: vi.fn<SetupApi['resume']>().mockResolvedValue(undefined),
    remove: vi.fn<SetupApi['remove']>().mockResolvedValue(undefined),
    emitDownloads: (items) => act(() => listeners.forEach((listener) => listener(items)))
  }
  const api: SetupApi = {
    hardware: vi.fn<SetupApi['hardware']>().mockResolvedValue(options.hardware ?? exampleHardware),
    catalog: vi
      .fn<SetupApi['catalog']>()
      .mockResolvedValue(options.catalog ?? { entries: [], diskFreeBytes: null, recommended: null }),
    download: fake.download,
    downloadEngine: fake.downloadEngine,
    cancel: fake.cancel,
    resume: fake.resume,
    remove: fake.remove,
    downloads: vi.fn<SetupApi['downloads']>().mockResolvedValue(options.downloads ?? []),
    onDownloads: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
  return { api, fake }
}

function fakeCore(start: CoreState, models: ModelInfo[]): { api: CoreApi; fake: FakeCore } {
  const listeners = new Set<(state: CoreState) => void>()
  const modelListeners = new Set<(models: ModelInfo[]) => void>()
  const fake: FakeCore = {
    restart: vi.fn<CoreApi['restart']>().mockResolvedValue(undefined),
    openLog: vi.fn<CoreApi['openLog']>().mockResolvedValue(undefined),
    load: vi.fn<CoreApi['load']>().mockResolvedValue(undefined),
    unload: vi.fn<CoreApi['unload']>().mockResolvedValue(undefined),
    emitState: (state) => act(() => listeners.forEach((listener) => listener(state))),
    emitModels: (list) => act(() => modelListeners.forEach((listener) => listener(list)))
  }
  const api: CoreApi = {
    getState: vi.fn<CoreApi['getState']>().mockResolvedValue(start),
    onState: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    restart: fake.restart,
    openLog: fake.openLog,
    models: vi.fn<CoreApi['models']>().mockResolvedValue(models),
    onModels: (callback) => {
      modelListeners.add(callback)
      return () => modelListeners.delete(callback)
    },
    load: fake.load,
    unload: fake.unload
  }
  return { api, fake }
}

function fakeAppWindow(startMaximized: boolean): { api: AppWindowApi; fake: FakeAppWindow } {
  const listeners = new Set<(maximized: boolean) => void>()
  const fake: FakeAppWindow = {
    minimize: vi.fn<AppWindowApi['minimize']>().mockResolvedValue(undefined),
    toggleMaximize: vi.fn<AppWindowApi['toggleMaximize']>().mockResolvedValue(undefined),
    close: vi.fn<AppWindowApi['close']>().mockResolvedValue(undefined),
    edit: vi.fn<AppWindowApi['edit']>().mockResolvedValue(undefined),
    emitMaximized: (maximized) => act(() => listeners.forEach((listener) => listener(maximized))),
    listeners: () => listeners.size
  }
  const api: AppWindowApi = {
    minimize: fake.minimize,
    toggleMaximize: fake.toggleMaximize,
    close: fake.close,
    edit: fake.edit,
    isMaximized: vi.fn<AppWindowApi['isMaximized']>().mockResolvedValue(startMaximized),
    onMaximizedChange: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
  return { api, fake }
}

export function renderWithStore(
  ui: React.ReactElement,
  saved: Partial<Settings> = {},
  options: Options = {}
): Rendered {
  let current: Settings = { ...defaultSettings, ...saved }
  const saveSettings = vi.fn<SettingsApi['update']>(async (patch) => (current = applyPatch(current, patch)))
  const openFolder = vi.fn<FilesApi['openFolder']>().mockResolvedValue(undefined)
  const appWindow = fakeAppWindow(options.maximized ?? false)
  const quit = vi.fn<AppApi['quit']>().mockResolvedValue(undefined)
  const pick = vi.fn<FilesApi['pick']>().mockResolvedValue(null)
  const useBundledLlama = vi
    .fn<FilesApi['useBundledLlama']>()
    .mockImplementation(async () => ({ ...current, models: { ...current.models, llamaServerPath: null } }))
  const core = fakeCore(options.coreState ?? { status: 'starting' }, options.models ?? [])
  const setup = fakeSetup(options.setup)
  const api: Pick<Api, 'files' | 'appWindow' | 'app' | 'core' | 'setup'> = {
    setup: setup.api,
    app: { quit },
    core: core.api,
    files: {
      locations: vi.fn<FilesApi['locations']>().mockResolvedValue(exampleLocations),
      openFolder,
      pick,
      bundledLlama: vi
        .fn<FilesApi['bundledLlama']>()
        .mockResolvedValue({ tag: 'b12078', cuda: options.cuda ?? 'none' }),
      useBundledLlama
    },
    appWindow: appWindow.api
  }
  vi.stubGlobal('api', api)

  const settingsListeners = new Set<(settings: Settings) => void>()
  const onChange: SettingsApi['onChange'] = (callback) => {
    settingsListeners.add(callback)
    return () => settingsListeners.delete(callback)
  }
  const emitSettings = (settings: Settings): void => {
    current = settings
    act(() => settingsListeners.forEach((listener) => listener(settings)))
  }

  const store = createAppStore({ settings: { update: saveSettings, onChange }, initialSettings: current })
  return {
    store,
    saveSettings,
    emitSettings,
    openFolder,
    pick,
    useBundledLlama,
    appWindow: appWindow.fake,
    quit,
    core: core.fake,
    setup: setup.fake,
    ...render(<Provider store={store}>{ui}</Provider>)
  }
}
