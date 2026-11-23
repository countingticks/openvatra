// Shared by the Settings → Models tests: the app with Settings open on Models, and the model and request fixtures.
import { act, screen } from '@testing-library/react'
import { Shell } from '@app/shell/Shell'
import type { LlamaCppSettings, LlamaServerSettings } from '@app/core/generated'
import { settingsOpened } from '@app/store/uiSlice'
import type { CoreState } from '@shared/core'
import type { ModelInfo } from '@app/core/types'
import { coreWrites, type FakeCoreHttp } from '../../../fakeCoreHttp'
import { exampleConnection, renderWithStore } from '../../../renderWithStore'

export const ready: CoreState = { status: 'ready', port: 1234, version: '1', connection: exampleConnection }

/** The two window flags that sit beside core's models section in a test's arguments. */
export type Preferences = Partial<LlamaCppSettings> & {
  engineSettings?: Partial<LlamaServerSettings>
  showAdvanced?: boolean
}

export const chosen: Preferences = {
  engineSettings: { path: 'C:\\llama\\llama-server.exe' },
  modelsDir: 'D:\\models',
  showAdvanced: true
}

export const qwen: ModelInfo = {
  id: 'Qwen3-8B-Q4_K_M',
  state: 'stopped',
  busy: false,
  sizeBytes: 5 * 1024 ** 3,
  kind: 'chat',
  context: null,
  moe: false,
  name: 'Qwen3 8B',
  quant: null,
  tags: [],
  memory: null
}

export const nomic: ModelInfo = {
  id: 'nomic-embed',
  state: 'ready',
  busy: false,
  sizeBytes: 140 * 1024 ** 2,
  kind: 'embedding',
  context: null,
  moe: false,
  name: 'nomic-embed',
  quant: null,
  tags: [],
  memory: null
}

type Rendered = ReturnType<typeof renderWithStore>

/** The value each PUT of the provider section carried, in order. */
export const putValues = (http: FakeCoreHttp): LlamaCppSettings[] =>
  coreWrites(http)
    .filter((write) => write.method === 'PUT' && write.path === '/api/config/provider.llamacpp')
    .map((write) => (write.body as { value: LlamaCppSettings }).value)

/**
 * Renders the app with Settings open on Models. The window's preferences go to the saved settings, the rest is
 * core's models section.
 */
export async function openModels(
  models: Preferences = chosen,
  options: NonNullable<Parameters<typeof renderWithStore>[2]> = {}
): Promise<Rendered & { section: HTMLElement }> {
  const { showAdvanced, engineSettings, ...core } = models
  const rendered = renderWithStore(
    <Shell />,
    showAdvanced === undefined ? {} : { showAdvancedModels: showAdvanced },
    { llamacppSettings: core, engineSettings, ...options }
  )
  act(() => {
    rendered.store.dispatch(settingsOpened({ section: 'models' }))
  })
  const section = await screen.findByRole('region', { name: 'Models' })
  return { ...rendered, section }
}
