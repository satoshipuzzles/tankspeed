// Garage + login flow in headless Chrome: pick a skin, see it persist and be
// worn in the race; log in through a stubbed NIP-07 extension and see the
// identity drive the name and hue. Screenshots land in .scratch/shots/.
//
// The NIP-07 stub returns a fixed pubkey and a fake signature. Profile and
// shared-skin fetches go to the real relays and are allowed to come back
// empty — the assertions only cover what the client controls.

import { existsSync, mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TS_URL ?? 'http://localhost:4460/'
const OUT = '.scratch/shots'
// hue = 0xab07 % 360 = 223
const FAKE_PK = 'ab07fadfc85caa90eeae7e235c2d5940a0690e33cdd13c65223ee3187d661f04'

const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}

mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--window-size=800,500',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
  ],
})

let failed = false
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!ok) failed = true
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 500 })
  page.on('pageerror', (e) => check(false, `pageerror: ${e.message}`))
  await page.evaluateOnNewDocument((pk) => {
    window.nostr = {
      getPublicKey: async () => pk,
      signEvent: async (t) => ({ ...t, pubkey: pk, id: '0'.repeat(64), sig: '0'.repeat(128) }),
    }
  }, FAKE_PK)
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#garage-open')

  // ------------------------------------------------------------- garage
  await page.click('#garage-open')
  const sheetShown = await page.evaluate(() => !document.getElementById('garage').hidden)
  check(sheetShown, 'garage sheet opens')

  const clickByText = (row, text) => page.evaluate((rowId, t) => {
    const b = [...document.getElementById(rowId).children].find((x) => x.textContent === t)
    if (!b) return false
    b.click()
    return true
  }, row, text)

  check(await clickByText('patterns', 'Woodland'), 'woodland pattern button exists')
  check(await clickByText('finishes', 'Chrome'), 'chrome finish button exists')
  const picked = await page.evaluate(() => window.__ts.skin())
  check(picked === 'woodland-chrome', `combo skin picked (${picked})`)

  const carbonDisabled = await page.evaluate(() => {
    const b = [...document.getElementById('finishes').children].find((x) => x.textContent === 'Carbon')
    return b.disabled
  })
  check(carbonDisabled, 'carbon disabled under a pattern')

  await new Promise((r) => setTimeout(r, 700)) // a couple of preview frames
  await page.screenshot({ path: `${OUT}/garage.png` })
  await page.click('#garage-done')

  // Persistence across a reload.
  await page.reload({ waitUntil: 'networkidle0' })
  const persisted = await page.evaluate(() => window.__ts.skin())
  check(persisted === 'woodland-chrome', `skin persists across reload (${persisted})`)

  // -------------------------------------------------------------- login
  await page.click('#login')
  await page.waitForFunction(() => window.__ts.identity().pubkey !== null, { timeout: 15000 })
  const id = await page.evaluate(() => window.__ts.identity())
  check(id.pubkey === FAKE_PK, 'login stores pubkey')
  check(id.hue === 0xab07 % 360, `hue derived from pubkey (${id.hue})`)
  const whoamiShown = await page.evaluate(() => !document.getElementById('whoami').hidden)
  check(whoamiShown, 'whoami shown after login')

  // Give the best-effort profile fetch a moment, then race and confirm the
  // player tank wears the picked skin and pubkey hue.
  await new Promise((r) => setTimeout(r, 5000))
  await page.click('#start')
  await page.evaluate(() => window.__ts.skipCountdown())
  await new Promise((r) => setTimeout(r, 1000))
  const s = await page.evaluate(() => window.__ts.state())
  check(s !== null, 'race starts while logged in')
  check(s.skin === 'woodland-chrome', `player races in picked skin (${s.skin})`)
  check(s.hue === 0xab07 % 360, `player races in pubkey hue (${s.hue})`)
  await page.evaluate(() => { window.__ts.autopilot(true); window.__ts.sideCam(true) })
  await new Promise((r) => setTimeout(r, 1200))
  await page.screenshot({ path: `${OUT}/skin-race.png` })
  await page.close()
} finally {
  await browser.close()
}

process.exit(failed ? 1 : 0)
