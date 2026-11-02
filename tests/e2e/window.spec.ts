import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { createRequire } from 'module'
import { join } from 'path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { appArgs, createUserDataDir, removeUserDataDir } from './testProfile'

// In Node, the 'electron' package exports the path of the Electron executable.
const electronPath = createRequire(__filename)('electron') as string

let app: ElectronApplication
let userDataDir: string

/** Null until the app first saves, so expect.poll keeps waiting instead of failing on a missing file. */
async function settingsOnDisk(): Promise<unknown> {
  return readFile(join(userDataDir, 'settings.json'), 'utf8').then(JSON.parse, () => null)
}

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

test('closing the window hides it to the tray instead of quitting', async () => {
  // The window shows itself on 'ready-to-show', which can come after firstWindow() returns on a slow machine;
  // closing before that would let it show itself again right after.
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
    .toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())

  const window = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), destroyed: w.isDestroyed() }))
  )
  expect(window).toEqual([{ visible: false, destroyed: false }])
  // The one-time notice was shown, and is remembered so it won't show again.
  await expect.poll(() => settingsOnDisk()).toMatchObject({ closeToTrayNoticeShown: true })
})

test('a second launch brings the hidden window back', async () => {
  const second = spawn(electronPath, appArgs(userDataDir), { stdio: 'ignore' })
  await new Promise((resolve) => second.on('exit', resolve))

  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
    .toBe(true)
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
