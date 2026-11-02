// Runs before every test file.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom can't draw on a canvas: getContext returns null after logging a "Not implemented" error. Return null
// quietly instead, so components with a canvas (the pixel backdrop) render without noise. Tests that need
// drawing hand in their own fake context.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
}

// Unmount whatever a test rendered, so tests never see each other's leftovers.
afterEach(() => {
  cleanup()
})
