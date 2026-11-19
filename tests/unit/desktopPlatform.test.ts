import { describe, expect, it, vi } from 'vitest'
import { desktopPlatform } from '@renderer/desktopPlatform'
import type { Api } from '../../src/shared/ipc'
import type { CoreState } from '../../src/shared/core'
import { defaultSettings } from '../../src/shared/settings'

function buildApi(): Api {
  return {
    app: { quit: vi.fn().mockResolvedValue('quit') },
    core: {
      getState: vi.fn().mockResolvedValue('state'),
      onState: vi.fn().mockReturnValue('off-state'),
      restart: vi.fn().mockResolvedValue('restart'),
      openLog: vi.fn().mockResolvedValue('log')
    },
    settings: {
      get: vi.fn().mockResolvedValue(defaultSettings),
      update: vi.fn().mockResolvedValue(defaultSettings),
      onChange: vi.fn().mockReturnValue('off-change')
    },
    appWindow: {
      minimize: vi.fn().mockResolvedValue('min'),
      toggleMaximize: vi.fn().mockResolvedValue('toggle'),
      close: vi.fn().mockResolvedValue('close'),
      isMaximized: vi.fn().mockResolvedValue(true),
      onMaximizedChange: vi.fn().mockReturnValue('off-max'),
      edit: vi.fn().mockResolvedValue('edit')
    },
    files: {
      locations: vi.fn().mockResolvedValue('locations'),
      openFolder: vi.fn().mockResolvedValue('opened'),
      pick: vi.fn().mockResolvedValue(true)
    }
  } as unknown as Api
}

describe('desktopPlatform', () => {
  it('is the desktop kind', () => {
    expect(desktopPlatform(buildApi()).kind).toBe('desktop')
  })

  it('forwards each member to its window.api counterpart with the same arguments and result', async () => {
    const api = buildApi()
    const platform = desktopPlatform(api)
    const callback = vi.fn()
    const maxCallback = vi.fn()
    const changeCallback = vi.fn()

    expect(await platform.core.state()).toBe('state')
    expect(api.core.getState).toHaveBeenCalledWith()
    expect(platform.core.onState(callback)).toBe('off-state')
    expect(api.core.onState).toHaveBeenCalledWith(callback)
    expect(await platform.core.restart?.()).toBe('restart')
    expect(await platform.core.openLog?.()).toBe('log')

    expect(platform.prefs.onChange(changeCallback)).toBe('off-change')
    expect(api.settings.onChange).toHaveBeenCalledWith(changeCallback)

    expect(await platform.window?.minimize()).toBe('min')
    expect(await platform.window?.toggleMaximize()).toBe('toggle')
    expect(await platform.window?.close()).toBe('close')
    expect(await platform.window?.isMaximized()).toBe(true)
    expect(platform.window?.onMaximizedChange(maxCallback)).toBe('off-max')
    expect(api.appWindow.onMaximizedChange).toHaveBeenCalledWith(maxCallback)
    expect(await platform.window?.edit('copy')).toBe('edit')
    expect(api.appWindow.edit).toHaveBeenCalledWith('copy')

    expect(await platform.files?.locations()).toBe('locations')
    expect(await platform.files?.openFolder('logs')).toBe('opened')
    expect(api.files.openFolder).toHaveBeenCalledWith('logs')
    expect(await platform.files?.pick('modelsDir')).toBe(true)
    expect(api.files.pick).toHaveBeenCalledWith('modelsDir')

    expect(await platform.quit?.()).toBe('quit')
  })

  it('hands out the settings api object itself as prefs', () => {
    const api = buildApi()
    expect(desktopPlatform(api).prefs).toBe(api.settings)
  })

  it('passes a core state through unchanged', async () => {
    const api = buildApi()
    const state: CoreState = { status: 'starting' } as CoreState
    vi.mocked(api.core.getState).mockResolvedValue(state)
    expect(await desktopPlatform(api).core.state()).toBe(state)
  })
})
