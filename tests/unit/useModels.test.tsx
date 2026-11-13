import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useModels } from '@renderer/hooks/useModels'
import type { ModelInfo } from '../../src/shared/core'
import { exampleConnection, renderWithStore } from './renderWithStore'

const model = (id: string): ModelInfo => ({
  id,
  state: 'stopped',
  busy: false,
  sizeBytes: 1024,
  kind: 'chat'
})
const ready = { status: 'ready', port: 1234, version: '1', connection: exampleConnection } as const

function Probe(): React.JSX.Element {
  return (
    <p>
      {useModels()
        .map((item) => item.id)
        .join(', ') || 'none'}
    </p>
  )
}

describe('useModels', () => {
  it('lists the models core sends after hello', async () => {
    renderWithStore(<Probe />, {}, { models: [model('qwen'), model('nomic')] })

    expect(await screen.findByText('qwen, nomic')).toBeInTheDocument()
  })

  it('replaces the list when a later model.state arrives', async () => {
    const { core } = renderWithStore(<Probe />, {}, { models: [model('qwen')] })
    expect(await screen.findByText('qwen')).toBeInTheDocument()

    core.emitModels([model('llama')])

    expect(await screen.findByText('llama')).toBeInTheDocument()
  })

  it('empties while core restarts and fills again from the new stream', async () => {
    const { core } = renderWithStore(<Probe />, {}, { models: [model('qwen')] })
    expect(await screen.findByText('qwen')).toBeInTheDocument()

    core.emitState({ status: 'starting' })
    expect(await screen.findByText('none')).toBeInTheDocument()

    core.emitState({ ...ready, connection: { ...exampleConnection, token: 'b'.repeat(64) } })
    expect(await screen.findByText('qwen')).toBeInTheDocument()
  })
})
