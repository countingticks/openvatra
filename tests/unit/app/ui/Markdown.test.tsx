import { readFileSync } from 'fs'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '@app/ui/Markdown'

describe('Markdown', () => {
  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

  beforeEach(() => {
    writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders a GFM table with its header cells', () => {
    render(<Markdown text={'| Name | Size |\n| --- | --- |\n| a | 1 |'} />)

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Size' })).toBeInTheDocument()
  })

  it('labels a code block with its language and copies its text', async () => {
    vi.useFakeTimers()
    render(<Markdown text={'```ts\nconst a = 1\n```'} />)

    expect(screen.getByText('ts')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    })

    expect(writeText).toHaveBeenCalledWith('const a = 1\n')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1500))
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
  })

  it('shows a script tag as text and never makes it an element', () => {
    const { container } = render(<Markdown text="<script>alert(1)</script>" />)

    expect(container).toHaveTextContent('<script>alert(1)</script>')
    expect(container.querySelector('script')).toBeNull()
  })

  it('shows raw HTML as literal text', () => {
    const { container } = render(<Markdown text="<b>x</b>" />)

    expect(container).toHaveTextContent('<b>x</b>')
    expect(container.querySelector('b')).toBeNull()
  })

  it('links http(s) to a new window and drops other schemes', () => {
    render(<Markdown text="[site](https://example.com) and [x](javascript:alert(1))" />)

    expect(screen.getByRole('link', { name: 'site' })).toHaveAttribute('target', '_blank')
    expect(screen.queryByRole('link', { name: 'x' })).toBeNull()
    expect(screen.getByText('x')).toBeInTheDocument()
  })

  it('shows an image as a link to it, never an img', () => {
    const { container } = render(<Markdown text="![cat](https://example.com/c.png)" />)

    expect(screen.getByRole('link', { name: 'cat' })).toHaveAttribute('href', 'https://example.com/c.png')
    expect(container.querySelector('img')).toBeNull()
  })

  describe('live', () => {
    it('shows an open code fence as plain text, still labelled and copyable', () => {
      render(<Markdown live text={'```ts\nconst a = 1\n'} />)

      expect(screen.getByText('const a = 1')).toBeInTheDocument()
      expect(screen.getByText('ts')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
    })

    it('highlights the fence once it is closed', () => {
      render(<Markdown live text={'```ts\nconst a = 1\n```\n'} />)

      expect(screen.queryByText('const a = 1')).toBeNull()
      expect(screen.getByText('const')).toBeInTheDocument()
    })

    it('renders the same HTML as the full render for a finished answer', () => {
      const text = readFileSync('tests/perf/fixtures/answer.md', 'utf8')
      const flat = (html: string): string => html.replace(/>\n</g, '><')
      const full = render(<Markdown text={text} />)
      const fullHtml = flat(full.container.innerHTML)
      full.unmount()
      const live = render(<Markdown live text={text} />)

      expect(flat(live.container.innerHTML)).toBe(fullHtml)
    })
  })
})
