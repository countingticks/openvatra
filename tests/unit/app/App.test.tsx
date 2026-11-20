import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '@app/App'
import { createApp } from '@app/createApp'
import { defaultSettings } from '@shared/settings'
import { fakePlatform } from '../fakePlatform'

describe('App', () => {
  it('renders the shell inside the platform and store it is given', () => {
    const { platform } = fakePlatform()
    render(<App platform={platform} store={createApp({ platform })} />)

    expect(screen.getByRole('banner')).toBeInTheDocument()
    const sidebar = screen.getByRole('navigation', { name: 'Main' })
    expect(within(sidebar).getByRole('button', { name: 'Chat' })).toBeInTheDocument()
  })

  it('starts from the initial settings it is given', () => {
    const { platform } = fakePlatform()
    const store = createApp({ platform, initialSettings: { ...defaultSettings, lastRoute: 'code' } })
    render(<App platform={platform} store={store} />)

    const sidebar = screen.getByRole('navigation', { name: 'Main' })
    expect(within(sidebar).getByRole('button', { name: 'Code' })).toHaveAttribute('aria-current', 'page')
  })
})
