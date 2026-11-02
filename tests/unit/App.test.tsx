import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@renderer/App'

describe('App', () => {
  it('shows the app name as the main heading', () => {
    render(<App />)

    expect(screen.getByRole('heading', { level: 1, name: 'OpenVatra' })).toBeInTheDocument()
  })

  it('offers a way to get started', () => {
    render(<App />)

    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument()
  })
})
