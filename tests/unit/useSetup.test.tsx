import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSetup } from '@renderer/hooks/useSetup'
import { exampleConnection, renderWithStore } from './renderWithStore'
import type { CatalogView } from '../../src/shared/setup'

const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const
const catalog: CatalogView = { entries: [], diskFreeBytes: 7, recommended: null }

function Probe(): React.JSX.Element {
  const { catalog } = useSetup()
  return <p>{catalog ? `free ${catalog.diskFreeBytes}` : 'no catalog'}</p>
}

describe('useSetup', () => {
  it('waits for core to be ready before asking it, then asks again after a restart', async () => {
    const errors = vi.spyOn(console, 'error')
    const { core } = renderWithStore(<Probe />, {}, { setup: { catalog } })
    const { hardware, catalog: readCatalog } = window.api.setup

    expect(hardware).not.toHaveBeenCalled()
    expect(readCatalog).not.toHaveBeenCalled()

    core.emitState(ready)
    expect(await screen.findByText('free 7')).toBeInTheDocument()
    expect(hardware).toHaveBeenCalledTimes(1)

    // While core restarts the last catalog stays on screen; a fresh one is read once it is ready again.
    core.emitState({ status: 'starting' })
    expect(screen.getByText('free 7')).toBeInTheDocument()
    core.emitState(ready)
    await vi.waitFor(() => expect(readCatalog).toHaveBeenCalledTimes(2))
    expect(errors).not.toHaveBeenCalled()
  })
})
