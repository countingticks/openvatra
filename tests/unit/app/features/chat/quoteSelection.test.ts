import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { quotableText } from '@app/features/chat/quoteSelection'

let container: HTMLElement
let outside: HTMLElement

beforeEach(() => {
  container = document.createElement('div')
  container.innerHTML = '<p data-quote>First message</p><p data-quote>Second message</p><p>Not quotable</p>'
  outside = document.createElement('p')
  outside.setAttribute('data-quote', '')
  outside.textContent = 'Elsewhere'
  document.body.append(container, outside)
})

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  container.remove()
  outside.remove()
})

function select(from: Node, start: number, to: Node = from, end = start): Selection | null {
  const range = document.createRange()
  range.setStart(from, start)
  range.setEnd(to, end)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return selection
}

const textOf = (index: number): Text => container.children[index].firstChild as Text

describe('quotableText', () => {
  it('a selection inside one message gives its trimmed text', () => {
    expect(quotableText(select(textOf(0), 5, textOf(0), 13), container)).toBe('message')
    expect(quotableText(select(textOf(0), 0, textOf(0), 6), container)).toBe('First')
  })

  it('a collapsed or blank selection gives null', () => {
    expect(quotableText(null, container)).toBeNull()
    expect(quotableText(select(textOf(0), 3), container)).toBeNull()
    expect(quotableText(select(textOf(0), 5, textOf(0), 6), container)).toBeNull()
  })

  it('a selection across two messages gives null', () => {
    expect(quotableText(select(textOf(0), 2, textOf(1), 4), container)).toBeNull()
  })

  it('a selection outside any [data-quote], or outside the container, gives null', () => {
    expect(quotableText(select(textOf(2), 0, textOf(2), 5), container)).toBeNull()
    expect(
      quotableText(select(outside.firstChild as Text, 0, outside.firstChild as Text, 5), container)
    ).toBeNull()
  })
})
