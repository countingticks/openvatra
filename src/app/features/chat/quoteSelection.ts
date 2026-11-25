export const maxQuoteChars = 4000
export const maxReplyChars = 4000

const quoteElement = (node: Node | null): Element | null =>
  (node instanceof Element ? node : (node?.parentElement ?? null))?.closest('[data-quote]') ?? null

/**
 * The selected text when the selection lies inside one [data-quote] element within container: trimmed,
 * null when collapsed, blank, outside, or spanning two messages.
 */
export function quotableText(selection: Selection | null, container: HTMLElement): string | null {
  if (!selection || selection.isCollapsed) return null
  const start = quoteElement(selection.anchorNode)
  const end = quoteElement(selection.focusNode)
  if (start === null || start !== end || !container.contains(start)) return null
  const text = selection.toString().trim()
  return text === '' ? null : text
}
