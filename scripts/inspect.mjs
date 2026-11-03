// Prints the layout of elements in the built app as text, so alignment and spacing can be checked by numbers
// instead of full-window screenshots. Needs a build first (`npx electron-vite build`).
//
//   npm run inspect -- "<selector>" ["<selector>" ...] [--press <keys>] [--click <selector>] [--shot]
//
// Selectors are Playwright selectors: CSS ("header button") or role/text ("role=banner", "text=Settings").
// --press / --click run before measuring (e.g. --press Control+, opens Settings). Both may repeat.
// --shot also saves a cropped screenshot of the first selector's first match to test-results/inspect.png.
import { _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const selectors = []
const actions = []
let shot = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shot') shot = true
  else if (args[i] === '--press' || args[i] === '--click') actions.push([args[i], args[++i]])
  else selectors.push(args[i])
}
if (selectors.length === 0) {
  console.log('usage: npm run inspect -- "<selector>" [...] [--press <keys>] [--click <selector>] [--shot]')
  process.exit(1)
}

// A throwaway profile, like the e2e tests: never touch the real %APPDATA%\OpenVatra.
const userDataDir = await mkdtemp(join(tmpdir(), 'openvatra-inspect-'))
const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`] })

try {
  const page = await app.firstWindow()
  await page.getByRole('banner').waitFor()
  for (const [kind, value] of actions) {
    if (kind === '--press') await page.keyboard.press(value)
    else await page.locator(value).first().click()
  }
  // Let open/close animations settle so the boxes are final.
  await page.waitForTimeout(400)

  // Electron windows have no Playwright viewport; ask the page for its size instead.
  console.log(`window ${await page.evaluate(() => `${innerWidth}x${innerHeight}`)}`)
  for (const selector of selectors) {
    const matches = await page.locator(selector).all()
    console.log(`\n${selector}: ${matches.length} match(es)`)
    for (const [index, match] of matches.slice(0, 20).entries()) {
      const info = await match.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 30)
        const [x, y, w, h, cx, cy] = [
          box.x,
          box.y,
          box.width,
          box.height,
          box.x + box.width / 2,
          box.y + box.height / 2
        ].map((value) => Math.round(value * 10) / 10)
        return [
          `<${element.tagName.toLowerCase()}> "${label}"`,
          `x=${x} y=${y} w=${w} h=${h}  cx=${cx} cy=${cy}`,
          `font=${style.fontSize}/${style.lineHeight} pad=${style.padding} margin=${style.margin}`,
          `display=${style.display} align=${style.alignItems} justify=${style.justifyContent}`
        ].join('  ')
      })
      console.log(`  [${index}] ${info}`)
    }
  }

  if (shot) {
    const path = 'test-results/inspect.png'
    await page.locator(selectors[0]).first().screenshot({ path })
    console.log(`\nscreenshot: ${path}`)
  }
} finally {
  await app.close()
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
