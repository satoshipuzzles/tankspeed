// Drives a real race in headless Chrome against the preview build and fails
// loudly when the game does not actually play: the tank must move, make lap
// progress, and the item system must produce bananas or shells on the road.
// Screenshots land in .scratch/shots/ for eyeballing — desktop and iPhone.
//
// Usage: npm run build && npm run preview (or vite dev on 4460), then
//        node test/race.mjs

import { existsSync, mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TS_URL ?? 'http://localhost:4460/'
const OUT = '.scratch/shots'

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
    '--window-size=1280,800',
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
  // ------------------------------------------------------------- desktop
  // Small viewport on purpose: swiftshader is fill-rate bound, and the sim
  // clamps dt per frame, so a big canvas makes game time crawl far behind
  // wall time. The layout screenshots still read fine at this size.
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 500 })
  page.on('pageerror', (e) => check(false, `pageerror: ${e.message}`))
  await page.goto(URL, { waitUntil: 'networkidle0' })

  await page.waitForSelector('#start')
  await page.screenshot({ path: `${OUT}/lobby.png` })

  await page.type('#name', 'TestPilot')
  await page.click('#start')
  await page.evaluate(() => window.__ts.skipCountdown())
  await new Promise((r) => setTimeout(r, 400))

  const s0 = await page.evaluate(() => window.__ts.state())
  check(s0 !== null, 'race started')

  // The player drives itself for the soak so it corners and hits item rows.
  // Items are transient (shells despawn, bananas get run over), so the check
  // is cumulative over the soak, not a single end-of-run sample.
  // Soak by GAME clock, not wall clock: headless software rendering can run
  // the sim at a fraction of real time. 25 game-seconds is a third of a lap
  // past several item rows, whatever the frame rate.
  await page.evaluate(() => window.__ts.autopilot(true))
  let itemsSeen = 0
  let s1 = s0
  const soakStart = Date.now()
  while (s1.clock < 25 && Date.now() - soakStart < 120000) {
    await new Promise((r) => setTimeout(r, 500))
    s1 = await page.evaluate(() => window.__ts.state())
    if (s1.bananas + s1.shells > 0 || s1.held !== null) itemsSeen++
  }
  await page.screenshot({ path: `${OUT}/race.png` })

  check(s1.clock >= 25, `sim reached 25 game-seconds (clock ${s1.clock.toFixed(1)})`)
  check(s1.speed > 100, `tank is moving (speed ${s1.speed.toFixed(0)})`)
  check(
    s1.progress - s0.progress > 4000,
    `lap progress made (${(s1.progress - s0.progress).toFixed(0)} units)`,
  )
  check(itemsSeen > 0, `items in play (seen in ${itemsSeen} samples)`)

  // Manual input still works: kill autopilot, hold the gas, expect forward
  // motion over game time. Progress, not instantaneous speed — the handoff
  // can leave the tank mid-spin or grinding a wall for a moment.
  await page.evaluate(() => window.__ts.autopilot(false))
  await page.keyboard.down('ArrowUp')
  const k0 = await page.evaluate(() => window.__ts.state())
  let k1 = k0
  const kbStart = Date.now()
  while (k1.clock < k0.clock + 4 && Date.now() - kbStart < 60000) {
    await new Promise((r) => setTimeout(r, 400))
    k1 = await page.evaluate(() => window.__ts.state())
  }
  await page.keyboard.up('ArrowUp')
  check(
    k1.progress - k0.progress > 200 || k1.speed > 50,
    `keyboard throttle works (moved ${(k1.progress - k0.progress).toFixed(0)}u, speed ${k1.speed.toFixed(0)})`,
  )

  // The canvas must actually be painting, not a black void. The WebGL buffer
  // is not readable after compositing (no preserveDrawingBuffer), so the
  // screenshot is the witness: decode it in the page and count lit pixels.
  const shotB64 = await page.screenshot({ encoding: 'base64' })
  const px = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = 128
    c.height = 128
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0, 128, 128)
    const d = ctx.getImageData(0, 0, 128, 128).data
    let lit = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] + d[i + 1] + d[i + 2] > 40) lit++
    }
    return lit
  }, shotB64)
  check(px > 6000, `page is painting (${px}/16384 lit samples)`)
  await page.close()

  // -------------------------------------------------------------- iPhone
  const phone = await browser.newPage()
  await phone.emulate({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
  phone.on('pageerror', (e) => check(false, `iphone pageerror: ${e.message}`))
  await phone.goto(URL, { waitUntil: 'networkidle0' })
  await phone.waitForSelector('#start')
  await phone.screenshot({ path: `${OUT}/iphone-lobby.png` })
  await phone.tap('#start')
  await phone.evaluate(() => window.__ts.skipCountdown())
  await new Promise((r) => setTimeout(r, 300))

  // Touch pads must be visible on a coarse pointer while racing.
  const pads = await phone.evaluate(() => {
    const el = document.getElementById('steer-l')
    const r = el.getBoundingClientRect()
    return { visible: getComputedStyle(document.getElementById('touch')).display !== 'none', h: r.height }
  })
  check(pads.visible && pads.h > 0, `touch pads shown on iPhone (h ${pads.h})`)

  await phone.evaluate(() => window.__ts.autopilot(true))
  await new Promise((r) => setTimeout(r, 6000))
  const p1 = await phone.evaluate(() => window.__ts.state())
  check(p1.speed > 100, `iphone race runs (speed ${p1.speed.toFixed(0)})`)
  await phone.screenshot({ path: `${OUT}/iphone-race.png` })
  await phone.close()
} finally {
  await browser.close()
}

process.exit(failed ? 1 : 0)
