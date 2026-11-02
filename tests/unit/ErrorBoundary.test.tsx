import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'

let broken = true
function Page(): React.JSX.Element {
  if (broken) throw new Error('page broke')
  return <p>Page content</p>
}

beforeEach(() => {
  broken = true
  // React reports caught render errors to the console; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('shows a short message instead of a blank window when a page fails', () => {
    render(<ErrorBoundary>{<Page />}</ErrorBoundary>)

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong here')
  })

  it('logs what failed, so it ends up in main.log', () => {
    render(<ErrorBoundary>{<Page />}</ErrorBoundary>)

    expect(console.error).toHaveBeenCalledWith(
      'A page failed to render',
      expect.objectContaining({ message: 'page broke' }),
      expect.any(String)
    )
  })

  it('tries the page again on request', () => {
    render(<ErrorBoundary>{<Page />}</ErrorBoundary>)

    broken = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('Page content')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows its content untouched when nothing fails', () => {
    broken = false
    render(<ErrorBoundary>{<Page />}</ErrorBoundary>)

    expect(screen.getByText('Page content')).toBeInTheDocument()
  })
})
