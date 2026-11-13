// Renders UI inside a real Redux store, so component tests exercise the actual reducers. Only the IPC to the main
// process and core's HTTP side are faked: settings answer like main does (with the whole saved file),
// window.api.files answers with example paths, window.api.appWindow records the window buttons and can report
// maximize changes the way main would, and fetch is a fake core (coreHttp). tests/setup.ts removes the fakes after
// each test.
import { act, render, type RenderResult } from '@testing-library/react'
import { Provider } from 'react-redux'
import { vi, type Mock } from 'vitest'
import { createAppStore, type AppStore } from '@renderer/store/store'
import type { CoreConnection, CoreState, ModelInfo } from '../../src/shared/core'
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
import type { Item as CoreCatalogItem, Models, View as CoreCatalogView } from '@renderer/core/generated'
import { applyPatch, defaultSettings, type Settings } from '../../src/shared/settings'
import { createFakeCoreHttp, defaultCoreModels, type FakeCoreHttp } from './fakeCoreHttp'

/** A connection a ready core hands the window. */
export const exampleConnection: CoreConnection = {
  baseUrl: 'http://127.0.0.1:53121',
  token: 'a'.repeat(64)
}

export const exampleLocations: FileLocations = {
  settingsFile: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\settings.json',
  logsFolder: 'C:\\Users\\ana\\AppData\\Roaming\\OpenVatra\\logs'
}

/** A catalog entry as core sends it: its files, no total size. */
export function exampleCatalogEntry(overrides: Partial<CoreCatalogItem> = {}): CoreCatalogItem {
  return {
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    summary: 'A small, quick chat model.',
    tags: ['chat'],
    licence: 'Apache-2.0',
    repo: 'example/qwen3-4b-GGUF',
    revision: 'main',
    files: [{ name: 'qwen3-4b-q4.gguf', sha256: 'f'.repeat(64), sizeBytes: 1024 }],
    needsGB: 4,
    rank: 1,
    fit: 'fits',
    installed: false,
    diskShortBytes: 0,
    ...overrides
  }
}

/** What GET /api/catalog answers: a UI-shaped view is turned into core's shape (its size becomes one file). */
function toCoreCatalog(catalog: CatalogView | CoreCatalogView): CoreCatalogView {
  const entries = catalog.entries.map((entry) => {
    if ('files' in entry) return entry
    const { sizeBytes, ...rest } = entry
    return exampleCatalogEntry({
      ...rest,
      files: [{ name: `${entry.id}.gguf`, sha256: 'f'.repeat(64), sizeBytes }]
    })
  })
  return { entries, diskFreeBytes: catalog.diskFreeBytes, recommended: catalog.recommended }
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
  /** core's HTTP side, stubbed in as fetch: what the window's data layer reaches over loopback. */
  coreHttp: FakeCoreHttp
  setup: FakeSetup
}

interface Options {
  /** The window starts maximized. */
  maximized?: boolean
  /** What core's state is when the UI first asks; default: ready, with exampleConnection. */
  coreState?: CoreState
  /** The model list when the UI first asks; default: none. */
  models?: ModelInfo[]
  /** The setup answers when the UI first asks; default: example hardware, an empty catalog, no downloads. */
  setup?: { hardware?: HardwareReport; catalog?: CatalogView | CoreCatalogView; downloads?: DownloadItem[] }
  /** The CUDA build's state main reports over IPC; default: not installed. */
  cuda?: 'none' | 'ready' | 'stale'
  /** The models section's value core answers (rev 1), over core's defaults. */
  modelSettings?: Partial<Models>
  /** What GET /api/engines answers; default: tag b12078, CUDA not installed. */
  engines?: { tag?: string | null; cuda?: 'none' | 'ready' | 'stale' }
}

function fakeSetup(
  options: Options['setup'] = {},
  coreHttp: FakeCoreHttp
): { api: SetupApi; fake: FakeSetup } {
  const listeners = new Set<(items: DownloadItem[]) => void>()
  const fake: FakeSetup = {
    download: vi.fn<SetupApi['download']>().mockResolvedValue(undefined),
    downloadEngine: vi.fn<SetupApi['downloadEngine']>().mockResolvedValue(undefined),
    cancel: vi.fn<SetupApi['cancel']>().mockResolvedValue(undefined),
    resume: vi.fn<SetupApi['resume']>().mockResolvedValue(undefined),
    remove: vi.fn<SetupApi['remove']>().mockResolvedValue(undefined),
    emitDownloads: (items) =>
      act(() => {
        coreHttp.setDownloads(items)
      })
  }
  const api: SetupApi = {
    hardware: vi.fn<SetupApi['hardware']>().mockResolvedValue(options.hardware ?? exampleHardware),
    catalog: vi
      .fn<SetupApi['catalog']>()
      .mockResolvedValue(
        options.catalog && !options.catalog.entries.some((entry) => 'files' in entry)
          ? (options.catalog as CatalogView)
          : { entries: [], diskFreeBytes: null, recommended: null }
      ),
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

function fakeCore(
  start: CoreState,
  models: ModelInfo[],
  coreHttp: FakeCoreHttp
): { api: CoreApi; fake: FakeCore } {
  const listeners = new Set<(state: CoreState) => void>()
  const modelListeners = new Set<(models: ModelInfo[]) => void>()
  const fake: FakeCore = {
    restart: vi.fn<CoreApi['restart']>().mockResolvedValue(undefined),
    openLog: vi.fn<CoreApi['openLog']>().mockResolvedValue(undefined),
    load: vi.fn<CoreApi['load']>().mockResolvedValue(undefined),
    unload: vi.fn<CoreApi['unload']>().mockResolvedValue(undefined),
    emitState: (state) => act(() => listeners.forEach((listener) => listener(state))),
    emitModels: (list) =>
      act(() => {
        coreHttp.setModels(list)
      })
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
  const coreHttp = createFakeCoreHttp()
  vi.stubGlobal('fetch', coreHttp.fetch)
  coreHttp.setModels(options.models ?? [])
  coreHttp.setDownloads(options.setup?.downloads ?? [])
  coreHttp.answer('/api/hardware', options.setup?.hardware ?? exampleHardware)
  coreHttp.answer(
    '/api/catalog',
    toCoreCatalog(options.setup?.catalog ?? { entries: [], diskFreeBytes: null, recommended: null })
  )
  coreHttp.setConfigModels({
    rev: 1,
    value: { ...defaultCoreModels, ...options.modelSettings },
    effective: {
      llamaServerPath: 'C:\\OpenVatra\\resources\\llama\\llama-server.exe',
      modelsDir: 'C:\\Users\\me\\OpenVatra\\Models'
    }
  })
  coreHttp.answer('/api/engines', {
    bundled: { tag: options.engines?.tag === undefined ? 'b12078' : options.engines.tag },
    cuda: options.engines?.cuda ?? 'none'
  })
  const core = fakeCore(
    options.coreState ?? { status: 'ready', port: 53121, version: '0.4.0', connection: exampleConnection },
    options.models ?? [],
    coreHttp
  )
  const setup = fakeSetup(options.setup, coreHttp)
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

  const store = createAppStore({
    settings: { update: saveSettings, onChange },
    initialSettings: current,
    core: core.api
  })
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
    coreHttp,
    setup: setup.fake,
    ...render(<Provider store={store}>{ui}</Provider>)
  }
}
