import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

let app: ElectronApplication
let userDataDir: string

async function launch(): Promise<void> {
  app = await electron.launch({ args: appArgs(userDataDir) })
  await app.firstWindow()
}

test.beforeAll(async () => {
  userDataDir = await createUserDataDir()
  await launch()
})

test.afterAll(async () => {
  await app.close()
  await removeUserDataDir(userDataDir)
})

test('the window reopens where it was left', async () => {
  // Small enough for CI's 1024×768 screen, so the on-screen check keeps it as is.
  const moved = { x: 50, y: 40, width: 900, height: 600 }
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), moved)

  // Closing right away, before the save delay is over: the position must still be saved on the way out.
  await app.close()
  await launch()

  const restored = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNormalBounds()
  )
  expect(restored).toEqual(moved)
})
