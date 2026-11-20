import { describe, expect, it } from 'vitest'
import { createApp } from '@app/createApp'
import { selectConnection } from '@app/core/connectionSlice'
import type { CoreConnection, CoreState } from '@shared/core'
import { fakePlatform } from '../fakePlatform'

// Listener effects and promises run after dispatch returns; one macrotask lets them finish.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const connection: CoreConnection = { baseUrl: 'http://127.0.0.1:53121', token: 'a'.repeat(64) }
const ready = (to: CoreConnection): CoreState => ({
  status: 'ready',
  port: 53121,
  version: '1.0.0',
  connection: to
})

describe("core's connection", () => {
  it('a ready state pushed by main sets the connection; a starting state clears it', () => {
    const fake = fakePlatform()
    const store = createApp({ platform: fake.platform })

    fake.core.emit(ready(connection))
    expect(selectConnection(store.getState())).toEqual(connection)

    fake.core.emit({ status: 'starting' })
    expect(selectConnection(store.getState())).toBeNull()
  })

  it("ignores getState's answer when a newer state was already pushed", async () => {
    const fake = fakePlatform()
    const store = createApp({ platform: fake.platform })

    fake.core.emit(ready(connection))
    fake.core.answer({ status: 'starting' })
    await settle()

    expect(selectConnection(store.getState())).toEqual(connection)
  })

  it('keeps the same object when an equal connection is pushed twice', () => {
    const fake = fakePlatform()
    const store = createApp({ platform: fake.platform })

    fake.core.emit(ready(connection))
    const first = selectConnection(store.getState())
    fake.core.emit(ready({ ...connection }))

    expect(selectConnection(store.getState())).toBe(first)
  })
})
