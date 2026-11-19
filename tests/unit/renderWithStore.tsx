// Renders UI inside a real Redux store, so component tests exercise the actual reducers. Only the IPC to the main
// process and core's HTTP side are faked: settings answer like main does (with the whole saved file),
// window.api.files answers with example paths, window.api.appWindow records the window buttons and can report
// maximize changes the way main would, and fetch is a fake core (coreHttp). tests/setup.ts removes the fakes after
// each test.
import { act, render, type RenderResult } from '@testing-library/react'
import { Provider } from 'react-redux'
import { vi, type Mock } from 'vitest'
import { createAppStore, type AppStore } from '@app/store/store'
import type { CoreConnection, CoreState } from '../../src/shared/core'
import type { ModelInfo } from '@app/core/types'
import type { Api, AppApi, AppWindowApi, CoreApi, FilesApi, SettingsApi } from '../../src/shared/ipc'
import type { DownloadItem, HardwareReport } from '@app/core/types'
import type { CatalogView } from '@renderer/core/catalogView'
import type { Item as CoreCatalogItem, View as CoreCatalogView } from '@app/core/generated'
import { defaultSettings, type Settings } from '../../src/shared/settings'
import { defaultEngineSettings, defaultLlamacppSettings } from '@renderer/core/modelSettings'
import type { LlamaCppSettings, LlamaServerSettings } from '@app/core/generated'
import { PlatformProvider } from '@app/platform/PlatformProvider'
import { exampleLocations, fakePlatform, type FakePlatform, type OptionalMember } from './fakePlatform'
import { createFakeCoreHttp, type FakeCoreHttp } from './fakeCoreHttp'

/** A connection a ready core hands the window. */
export const exampleConnection: CoreConnection = {
  baseUrl: 'http://127.0.0.1:53121',
  token: 'a'.repeat(64)
}

export { exampleLocations }

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
  /** Report a new state, as main does on every change. */
  emitState(state: CoreState): void
  /** Report a new model list, as main does on every change. */
  emitModels(models: ModelInfo[]): void
}

/** A way to play main's part for the first-run setup; its actions now go to core (coreHttp). */
export interface FakeSetup {
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
  platform: FakePlatform
  store: AppStore
  saveSettings: Mock<SettingsApi['update']>
  /** Plays main's settings:changed push; replaces the fake's saved settings too. */
  emitSettings(settings: Settings): void
  openFolder: Mock<FilesApi['openFolder']>
  /** Answers like main after the user picked a path; set its result per test. Default: cancelled (null). */
  pick: Mock<FilesApi['pick']>
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
  /** Platform members left out, to render the UI on a host without them. */
  omit?: readonly OptionalMember[]
  /** What core's state is when the UI first asks; default: ready, with exampleConnection. */
  coreState?: CoreState
  /** The model list when the UI first asks; default: none. */
  models?: ModelInfo[]
  /** The setup answers when the UI first asks; default: example hardware, an empty catalog, no downloads. */
  setup?: { hardware?: HardwareReport; catalog?: CatalogView | CoreCatalogView; downloads?: DownloadItem[] }
  /** provider.llamacpp's value core answers (rev 1), over core's defaults. */
  llamacppSettings?: Partial<LlamaCppSettings>
  /** engine.llamaserver's value core answers (rev 1), over core's defaults. */
  engineSettings?: Partial<LlamaServerSettings>
  /** What GET /api/engines answers; default: tag b12078, CUDA not installed. */
  engines?: { tag?: string | null; cuda?: 'none' | 'ready' | 'stale' }
}

export function renderWithStore(
  ui: React.ReactElement,
  saved: Partial<Settings> = {},
  options: Options = {}
): Rendered {
  const coreHttp = createFakeCoreHttp()
  vi.stubGlobal('fetch', coreHttp.fetch)
  coreHttp.setModels(options.models ?? [])
  coreHttp.setDownloads(options.setup?.downloads ?? [])
  coreHttp.answer('/api/hardware', options.setup?.hardware ?? exampleHardware)
  coreHttp.answer(
    '/api/catalog',
    toCoreCatalog(options.setup?.catalog ?? { entries: [], diskFreeBytes: null, recommended: null })
  )
  coreHttp.setConfig('engine.llamaserver', {
    rev: 1,
    value: { ...defaultEngineSettings, ...options.engineSettings },
    effective: { path: 'C:\\OpenVatra\\resources\\llama\\llama-server.exe' }
  })
  coreHttp.setConfig('provider.llamacpp', {
    rev: 1,
    value: { ...defaultLlamacppSettings, ...options.llamacppSettings },
    effective: { modelsDir: 'C:\\Users\\me\\OpenVatra\\Models' }
  })
  coreHttp.answer('/api/engines', {
    bundled: { tag: options.engines?.tag === undefined ? 'b12078' : options.engines.tag },
    cuda: options.engines?.cuda ?? 'none'
  })
  const fake = fakePlatform({
    coreState: options.coreState ?? {
      status: 'ready',
      port: 53121,
      version: '0.4.0',
      connection: exampleConnection
    },
    settings: { ...defaultSettings, ...saved },
    maximized: options.maximized,
    omit: options.omit
  })
  // Components read window.api until they move to usePlatform.
  const api: Pick<Api, 'files' | 'appWindow' | 'app' | 'core'> = {
    app: { quit: fake.quit },
    core: {
      getState: fake.core.state,
      onState: fake.platform.core.onState,
      restart: fake.core.restart,
      openLog: fake.core.openLog
    },
    files: fake.files,
    appWindow: {
      ...fake.window,
      onMaximizedChange: (callback) => fake.platform.window?.onMaximizedChange(callback) ?? (() => {})
    }
  }
  vi.stubGlobal('api', api)

  const store = createAppStore({ platform: fake.platform, initialSettings: { ...defaultSettings, ...saved } })
  return {
    platform: fake,
    store,
    saveSettings: fake.prefs.update,
    emitSettings: (settings) => act(() => fake.prefs.emit(settings)),
    openFolder: fake.files.openFolder,
    pick: fake.files.pick,
    appWindow: {
      minimize: fake.window.minimize,
      toggleMaximize: fake.window.toggleMaximize,
      close: fake.window.close,
      edit: fake.window.edit,
      emitMaximized: (maximized) => act(() => fake.window.emitMaximized(maximized)),
      listeners: fake.window.listeners
    },
    quit: fake.quit,
    core: {
      restart: fake.core.restart,
      openLog: fake.core.openLog,
      emitState: (state) => act(() => fake.core.emit(state)),
      emitModels: (list) =>
        act(() => {
          coreHttp.setModels(list)
        })
    },
    coreHttp,
    setup: {
      emitDownloads: (items) =>
        act(() => {
          coreHttp.setDownloads(items)
        })
    },
    ...render(
      <PlatformProvider platform={fake.platform}>
        <Provider store={store}>{ui}</Provider>
      </PlatformProvider>
    )
  }
}
