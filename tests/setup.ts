// Runs before every test file.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Unmount whatever a test rendered, so tests never see each other's leftovers.
afterEach(() => {
  cleanup()
})
