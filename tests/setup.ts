// Runs before every test file.
import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// A failed query normally prints every accessible role and the whole DOM: over a thousand lines for one
// test. `npm run check` only shows the end of a failing step, so there the real message would be cut off;
// keep just its first lines. Plain `npm test` still prints everything.
const shortElementError = (message: string | null): Error => {
  const error = new Error((message ?? '').split('\n').slice(0, 6).join('\n'))
  error.name = 'TestingLibraryElementError'
  // Leave this helper out of the stack, so the report points at the failing line of the test.
  Error.captureStackTrace(error, shortElementError)
  return error
}
if (process.env.CHECK_QUIET) configure({ getElementError: shortElementError })

// jsdom can't draw on a canvas: getContext returns null after logging a "Not implemented" error. Return null
// quietly instead, so components with a canvas (the pixel backdrop) render without noise. Tests that need
// drawing hand in their own fake context.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
}

// Unmount whatever a test rendered, so tests never see each other's leftovers.
afterEach(() => {
  cleanup()
  // Fakes put on window (like window.api from renderWithStore) never leak into the next test.
  vi.unstubAllGlobals()
  // Nor does the app's motion decision on <html> (set by App, or by a test). Node-only test files have no document.
  if (typeof document !== 'undefined') document.documentElement.removeAttribute('data-motion')
})
