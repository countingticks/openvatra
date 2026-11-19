import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformProvider } from '@renderer/platform/PlatformProvider'
import { usePlatform } from '@renderer/platform/usePlatform'
import { fakePlatform } from './fakePlatform'

function Kind(): React.JSX.Element {
  return <p>{usePlatform().kind}</p>
}

describe('usePlatform', () => {
  afterEach(() => vi.restoreAllMocks())

  it('gives a component under the provider its platform', () => {
    render(
      <PlatformProvider platform={fakePlatform().platform}>
        <Kind />
      </PlatformProvider>
    )
    expect(screen.getByText('desktop')).toBeInTheDocument()
  })

  it('throws without a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(<Kind />)).toThrow('usePlatform needs a PlatformProvider')
  })
})
