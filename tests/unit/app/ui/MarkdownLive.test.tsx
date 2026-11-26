import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Markdown } from '@app/ui/Markdown'

const seen = vi.hoisted(() => ({ children: [] as string[] }))

vi.mock('react-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-markdown')>()
  const Real = real.default
  return {
    ...real,
    default: (props: React.ComponentProps<typeof Real>) => {
      seen.children.push(String(props.children))
      return <Real {...props} />
    }
  }
})

describe('Markdown live', () => {
  it('re-renders only the last chunk when the text grows', () => {
    const { rerender } = render(<Markdown live text={'one\n\ntwo\n\nthree\n'} />)
    seen.children.length = 0

    rerender(<Markdown live text={'one\n\ntwo\n\nthree\nmore'} />)

    expect(seen.children).toEqual(['three\nmore'])
  })
})
