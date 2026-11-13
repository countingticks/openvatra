import { describe, expect, it } from 'vitest'
import { ipcChannels } from '../../../src/shared/ipc'

describe('ipcChannels', () => {
  it('holds exactly the 17 reviewed channels', () => {
    expect(Object.values(ipcChannels).sort()).toEqual([
      'app:quit',
      'core:get-state',
      'core:open-log',
      'core:restart',
      'core:state-changed',
      'files:locations',
      'files:open-folder',
      'files:pick',
      'settings:changed',
      'settings:get',
      'settings:update',
      'window:close',
      'window:edit',
      'window:is-maximized',
      'window:maximized-changed',
      'window:minimize',
      'window:toggle-maximize'
    ])
  })
})
