// TankSpeed: kart racing with tanks, in the tank-arena visual language.
// This file owns the scene, the camera, the inputs and the HUD; the racing
// itself lives in race.ts and the world in track.ts.

import * as THREE from 'three'
import { MAPS, Track, buildTrackMeshes, type MapDef } from './track'
import { Race, TOTAL_LAPS, type ItemKind, type Racer } from './race'
import { makeTank, applySkin, applyLabel, hueOf, type TankRig } from './tankmesh'
import {
  SKINS, DEFAULT_SKIN, asSkin, skinFor, patternOf, finishOf,
  PATTERNS, FINISHES, type SkinId, type Pattern, type FinishId,
} from './skins'
import { hasNip07, loginNip07, fetchProfile, fetchSharedSkin, publishSharedSkin } from './nostr'

// ------------------------------------------------------------------ storage

const stored = (k: string): string | null => {
  try { return localStorage.getItem(k) } catch { return null }
}
const store = (k: string, v: string): void => {
  try { localStorage.setItem(k, v) } catch { /* private mode */ }
}

// --------------------------------------------------------------------- DOM

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

const canvas = $('game') as unknown as HTMLCanvasElement
const lobby = $('lobby')
const nameInput = $<HTMLInputElement>('name')
const mapsRow = $('maps')
const hud = $('hud')
const placeEl = $('place')
const lapEl = $('lap')
const timerEl = $('timer')
const itemEl = $('item')
const countdownEl = $('countdown')
const toastEl = $('toast')
const resultsEl = $('results')
const resultsTitle = $('results-title')
const standingsEl = $('standings')
const touchEl = $('touch')
const loginBtn = $<HTMLButtonElement>('login')
const whoamiEl = $('whoami')
const garageEl = $('garage')
const patternsRow = $('patterns')
const finishesRow = $('finishes')
const skinBlurb = $('skin-blurb')

nameInput.value = stored('tankspeed.name') ?? ''

// ---------------------------------------------------------------- identity

// Until login, identity is a per-device guest key: a stable random hue seed
// standing in for the pubkey. Logging in replaces it with the real thing.
function guestKey(): string {
  let g = stored('tankspeed.guesthue')
  if (!g) {
    g = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
    store('tankspeed.guesthue', g)
  }
  return g
}

let pubkey: string | null = stored('tankspeed.pubkey')
let profileName: string | null = stored('tankspeed.profile.name')
let profilePicture: string | null = stored('tankspeed.profile.picture')
let currentSkin: SkinId = asSkin(stored('tankspeed.skin') ?? DEFAULT_SKIN)

const myHue = (): number => hueOf(pubkey ?? guestKey())
const myName = (): string => nameInput.value.trim() || profileName || 'anon'

function renderWhoami(): void {
  if (!pubkey) {
    whoamiEl.hidden = true
    loginBtn.hidden = false
    return
  }
  loginBtn.hidden = true
  whoamiEl.hidden = false
  whoamiEl.innerHTML = ''
  if (profilePicture) {
    const img = document.createElement('img')
    img.src = profilePicture
    img.alt = ''
    whoamiEl.appendChild(img)
  }
  const span = document.createElement('span')
  span.textContent = `${profileName ?? 'nostr'} · ${pubkey.slice(0, 8)}…`
  whoamiEl.appendChild(span)
  const out = document.createElement('button')
  out.textContent = 'logout'
  out.addEventListener('click', () => {
    pubkey = null
    profileName = null
    profilePicture = null
    store('tankspeed.pubkey', '')
    store('tankspeed.profile.name', '')
    store('tankspeed.profile.picture', '')
    renderWhoami()
    refreshDisplayTank()
  })
  whoamiEl.appendChild(out)
}

loginBtn.addEventListener('click', async () => {
  if (!hasNip07()) {
    toast('No NIP-07 extension found')
    return
  }
  try {
    loginBtn.disabled = true
    pubkey = await loginNip07()
    store('tankspeed.pubkey', pubkey)
    renderWhoami()
    refreshDisplayTank()
    // Profile and shared skin in parallel; both are best-effort.
    const [profile, remoteSkin] = await Promise.all([
      fetchProfile(pubkey),
      fetchSharedSkin(pubkey),
    ])
    profileName = profile.name
    profilePicture = profile.picture
    store('tankspeed.profile.name', profileName ?? '')
    store('tankspeed.profile.picture', profilePicture ?? '')
    if (!nameInput.value.trim() && profileName) nameInput.value = profileName
    if (remoteSkin) {
      currentSkin = remoteSkin
      store('tankspeed.skin', currentSkin)
      renderGarageRows()
    }
    renderWhoami()
    refreshDisplayTank()
  } catch {
    toast('Login failed')
  } finally {
    loginBtn.disabled = false
  }
})

// ------------------------------------------------------------------- scene

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, 1, 1, 6000)

const sun = new THREE.DirectionalLight(0xfff3df, 2.6)
sun.position.set(600, 900, 400)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.left = -1600
sun.shadow.camera.right = 1600
sun.shadow.camera.top = 1600
sun.shadow.camera.bottom = -1600
sun.shadow.camera.far = 3200
scene.add(sun)
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x3a4a34, 1.1))

function resize(): void {
  const w = innerWidth
  const h = innerHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  // Portrait phones get a wider lens so the road ahead still fits the frame.
  camera.fov = camera.aspect < 1 ? 74 : 60
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

// ------------------------------------------------------------------ inputs

const keys = new Set<string>()
let itemQueued = false
addEventListener('keydown', (e) => {
  if (e.repeat) return
  keys.add(e.code)
  if (e.code === 'Space') {
    itemQueued = true
    e.preventDefault()
  }
})
addEventListener('keyup', (e) => keys.delete(e.code))

const touchHeld = { left: false, right: false, brake: false }
let touchSeen = false
function bindPad(id: string, set: (v: boolean) => void): void {
  const el = $(id)
  const down = (e: Event) => {
    e.preventDefault()
    touchSeen = true
    set(true)
    el.classList.add('held')
  }
  const up = (e: Event) => {
    e.preventDefault()
    set(false)
    el.classList.remove('held')
  }
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('pointerleave', up)
}
bindPad('steer-l', (v) => { touchHeld.left = v })
bindPad('steer-r', (v) => { touchHeld.right = v })
bindPad('brake', (v) => { touchHeld.brake = v })
$('use-item').addEventListener('pointerdown', (e) => {
  e.preventDefault()
  touchSeen = true
  itemQueued = true
})

function readInputs(): { throttle: number; steer: number; useItem: boolean } {
  let throttle = 0
  let steer = 0
  if (keys.has('ArrowUp') || keys.has('KeyW')) throttle += 1
  if (keys.has('ArrowDown') || keys.has('KeyS')) throttle -= 1
  if (keys.has('ArrowLeft') || keys.has('KeyA')) steer -= 1
  if (keys.has('ArrowRight') || keys.has('KeyD')) steer += 1
  if (touchHeld.left) steer -= 1
  if (touchHeld.right) steer += 1
  if (touchHeld.brake) throttle -= 1
  // Touch players get auto-gas: steering is the whole game on a phone.
  else if (touchSeen && throttle === 0) throttle = 1
  const useItem = itemQueued
  itemQueued = false
  return {
    throttle: Math.max(-1, Math.min(1, throttle)),
    steer: Math.max(-1, Math.min(1, steer)),
    useItem,
  }
}

// ------------------------------------------------------------------- lobby

let pickedMap: MapDef = MAPS.find((m) => m.id === stored('tankspeed.map')) ?? MAPS[0]
for (const def of MAPS) {
  const b = document.createElement('button')
  b.textContent = def.label
  if (def === pickedMap) b.classList.add('picked')
  b.addEventListener('click', () => {
    pickedMap = def
    store('tankspeed.map', def.id)
    for (const other of mapsRow.children) other.classList.remove('picked')
    b.classList.add('picked')
    startIdle()
  })
  mapsRow.appendChild(b)
}

$('start').addEventListener('click', () => {
  store('tankspeed.name', nameInput.value.trim())
  startRace(pickedMap)
})
$('again').addEventListener('click', () => startRace(pickedMap))
$('menu').addEventListener('click', () => {
  resultsEl.hidden = true
  lobby.hidden = false
  startIdle()
})

// ------------------------------------------------------------------ garage

let garageOpen = false

function renderGarageRows(): void {
  const pattern = patternOf(currentSkin)
  const finish = finishOf(currentSkin)
  const fill = (row: HTMLElement, ids: readonly string[], picked: string, apply: (id: string) => void) => {
    row.innerHTML = ''
    for (const id of ids) {
      const b = document.createElement('button')
      b.textContent = id === 'solid' ? 'Solid' : id[0].toUpperCase() + id.slice(1)
      if (id === picked) b.classList.add('picked')
      // The one impossible cell, same as the arena: carbon cannot carry a
      // pattern (its trick is a near-black hull), so it greys out.
      if (row === finishesRow && id === 'carbon' && pattern !== 'solid') b.disabled = true
      b.addEventListener('click', () => {
        apply(id)
        store('tankspeed.skin', currentSkin)
        renderGarageRows()
        refreshDisplayTank()
        if (pubkey) void publishSharedSkin(currentSkin).catch(() => {})
      })
      row.appendChild(b)
    }
  }
  fill(patternsRow, PATTERNS, pattern, (id) => {
    currentSkin = skinFor(id as Pattern, finishOf(currentSkin) === 'carbon' && id !== 'solid' ? 'matte' : finishOf(currentSkin))
  })
  fill(finishesRow, FINISHES, finish, (id) => {
    currentSkin = skinFor(patternOf(currentSkin), id as FinishId)
  })
  skinBlurb.textContent = `${SKINS[currentSkin].label} — ${SKINS[currentSkin].blurb}`
}

$('garage-open').addEventListener('click', () => {
  garageOpen = true
  lobby.hidden = true
  garageEl.hidden = false
  renderGarageRows()
})
$('garage-done').addEventListener('click', () => {
  garageOpen = false
  garageEl.hidden = true
  lobby.hidden = false
})

// -------------------------------------------------------------- race state

interface RigEntry {
  racer: Racer
  rig: TankRig
}

let race: Race | null = null
let trackGroup: THREE.Group | null = null
let rigs: RigEntry[] = []
let bananaMeshes: THREE.Mesh[] = []
let shellMeshes: THREE.Mesh[] = []
let boxMeshes: THREE.Mesh[] = []
let countdown = 0
let resultsShown = false

const BANANA_GEO = new THREE.TorusGeometry(11, 4.5, 8, 12, Math.PI * 1.15)
const BANANA_MAT = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.5 })
const SHELL_GEO = new THREE.SphereGeometry(15, 16, 12)
const SHELL_MAT = new THREE.MeshStandardMaterial({ color: 0x3fae4a, roughness: 0.35, metalness: 0.15 })
const BOX_GEO = new THREE.BoxGeometry(30, 30, 30)
const BOX_MAT = new THREE.MeshNormalMaterial()

function clearRace(): void {
  if (trackGroup) scene.remove(trackGroup)
  for (const e of rigs) scene.remove(e.rig.root)
  for (const m of [...bananaMeshes, ...shellMeshes, ...boxMeshes]) scene.remove(m)
  rigs = []
  bananaMeshes = []
  shellMeshes = []
  boxMeshes = []
  if (displayTank) {
    scene.remove(displayTank.root)
    displayTank = null
  }
}

function toast(text: string): void {
  toastEl.textContent = text
  toastEl.hidden = false
  setTimeout(() => { toastEl.hidden = true }, 1400)
}

const ITEM_ICON: Record<ItemKind, string> = { banana: '🍌', shell: '🚀' }

function startRace(def: MapDef): void {
  clearRace()
  lobby.hidden = true
  garageEl.hidden = true
  garageOpen = false
  resultsEl.hidden = true
  resultsShown = false

  const track = new Track(def)
  trackGroup = buildTrackMeshes(track)
  scene.add(trackGroup)
  scene.background = new THREE.Color(def.sky)
  scene.fog = new THREE.Fog(def.fog, 900, 3600)

  race = new Race(track, myName(), myHue(), currentSkin, {
    onPickup: (r, item) => {
      if (r.kind === 'player') {
        itemEl.textContent = ITEM_ICON[item]
        itemEl.classList.remove('empty')
        itemEl.classList.add('full')
      }
    },
    onHit: (victim, by) => {
      if (victim.kind === 'player') toast(by === 'banana' ? '🍌 SPUN OUT!' : '🚀 HIT!')
    },
    onLap: (r, lap) => {
      if (r.kind === 'player' && lap > 1) toast(lap === TOTAL_LAPS ? 'FINAL LAP!' : `LAP ${lap}`)
    },
    onFinish: (r) => {
      if (r.kind === 'player') toast('FINISH!')
    },
  })

  for (const racer of race.racers) {
    const rig = makeTank()
    applySkin(rig, SKINS[racer.skin], racer.hue)
    applyLabel(rig, racer.name, racer.hue)
    // You know which tank you are — it's the one the camera chases. Your own
    // plate would just sit in the middle of the screen.
    rig.label.visible = racer.kind !== 'player'
    rig.root.position.set(racer.x, 0, racer.z)
    rig.root.rotation.y = racer.heading
    scene.add(rig.root)
    rigs.push({ racer, rig })
  }

  for (const box of race.boxes) {
    const m = new THREE.Mesh(BOX_GEO, BOX_MAT)
    m.position.set(box.x, 26, box.z)
    scene.add(m)
    boxMeshes.push(m)
  }

  itemEl.textContent = ''
  itemEl.classList.add('empty')
  itemEl.classList.remove('full')
  hud.hidden = false
  touchEl.classList.add('racing')
  countdown = 3.6
  snapCamera()
}

// ------------------------------------------------------------------ camera

const camPos = new THREE.Vector3()
const camAim = new THREE.Vector3()
/** Test rig: park the camera beside the tank for close-up screenshots. */
let sideCam = false

function cameraTargets(): { pos: THREE.Vector3; aim: THREE.Vector3 } {
  const p = race!.player
  const fx = Math.cos(p.heading)
  const fz = -Math.sin(p.heading)
  if (sideCam) {
    return {
      pos: new THREE.Vector3(p.x - fz * 130 - fx * 40, 45, p.z + fx * 130 - fz * 40),
      aim: new THREE.Vector3(p.x, 24, p.z),
    }
  }
  const pos = new THREE.Vector3(p.x - fx * 190, 100, p.z - fz * 190)
  const aim = new THREE.Vector3(p.x + fx * 90, 30, p.z + fz * 90)
  return { pos, aim }
}

function snapCamera(): void {
  const { pos, aim } = cameraTargets()
  camPos.copy(pos)
  camAim.copy(aim)
  camera.position.copy(pos)
  camera.lookAt(aim)
}

// -------------------------------------------------------------------- HUD

const ORDINAL = ['', 'st', 'nd', 'rd', 'th', 'th', 'th']

function fmtTime(t: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

function updateHud(): void {
  const r = race!
  const p = r.player
  const place = r.placeOf(p)
  placeEl.innerHTML = `${place}<sup>${ORDINAL[place]}</sup>`
  const lap = Math.min(TOTAL_LAPS, Math.max(1, p.lap))
  lapEl.textContent = `LAP ${lap}/${TOTAL_LAPS}`
  timerEl.textContent = fmtTime(p.finished || r.clock)
  if (!p.held) {
    itemEl.textContent = ''
    itemEl.classList.add('empty')
    itemEl.classList.remove('full')
  }
}

function showResults(): void {
  resultsShown = true
  const r = race!
  const p = r.player
  const place = r.placeOf(p)
  resultsTitle.textContent = place === 1 ? '🏆 VICTORY!' : `${place}${ORDINAL[place]} PLACE`
  standingsEl.innerHTML = ''
  const order = [...r.racers].sort((a, b) => r.placeOf(a) - r.placeOf(b))
  for (const racer of order) {
    const li = document.createElement('li')
    if (racer.kind === 'player') li.classList.add('you')
    const nameSpan = document.createElement('span')
    nameSpan.textContent = `${r.placeOf(racer)}. ${racer.name}`
    const timeSpan = document.createElement('span')
    timeSpan.textContent = racer.finished ? fmtTime(racer.finished) : '—'
    li.append(nameSpan, timeSpan)
    standingsEl.appendChild(li)
  }
  resultsEl.hidden = false
  touchEl.classList.remove('racing')
}

// -------------------------------------------------------------------- loop

let last = performance.now()
let finishedAt = 0

function frame(now: number): void {
  requestAnimationFrame(frame)
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now

  if (race) {
    if (countdown > 0) {
      countdown -= dt
      const n = Math.ceil(countdown)
      countdownEl.hidden = false
      countdownEl.textContent = countdown <= 0.6 ? 'GO!' : String(n)
      if (countdown <= 0) {
        countdownEl.hidden = true
      }
    } else {
      race.step(dt, readInputs())
    }

    // Sync meshes to sim state.
    for (const { racer, rig } of rigs) {
      rig.root.position.set(racer.x, 0, racer.z)
      rig.root.rotation.y = racer.heading
      // Spin-out pirouette rides the bob so the label stays upright.
      rig.bob.rotation.y = racer.spin > 0 ? racer.spin * 9 : 0
      // A touch of bank in corners sells the speed.
      const bank = racer.kind === 'player' && racer.spin <= 0
        ? -readBank() * Math.min(1, Math.abs(racer.speed) / 400) * 0.12
        : 0
      rig.bob.rotation.x += (bank - rig.bob.rotation.x) * Math.min(1, 8 * dt)
    }

    syncPool(bananaMeshes, race.bananas.length, BANANA_GEO, BANANA_MAT)
    race.bananas.forEach((b, i) => {
      bananaMeshes[i].position.set(b.x, 8, b.z)
      bananaMeshes[i].rotation.set(Math.PI / 2, 0, 0)
    })
    syncPool(shellMeshes, race.shells.length, SHELL_GEO, SHELL_MAT)
    race.shells.forEach((s, i) => shellMeshes[i].position.set(s.x, 14, s.z))
    race.boxes.forEach((b, i) => {
      const m = boxMeshes[i]
      m.visible = b.deadUntil <= race!.clock
      m.rotation.y += dt * 1.6
      m.rotation.x += dt * 0.9
      m.position.y = 26 + Math.sin(now / 400 + i) * 4
    })

    // Camera chase with a light lag, which is most of the game feel.
    const { pos, aim } = cameraTargets()
    const k = Math.min(1, 5 * dt)
    camPos.lerp(pos, k)
    camAim.lerp(aim, Math.min(1, 9 * dt))
    camera.position.copy(camPos)
    camera.lookAt(camAim)

    updateHud()

    if (race.playerDone && !resultsShown) {
      if (!finishedAt) finishedAt = now
      if (now - finishedAt > 1400) {
        finishedAt = 0
        showResults()
      }
    }
  } else {
    idleCamera(dt)
  }

  renderer.render(scene, camera)
}

/** Current steer input, for the cosmetic bank only. */
function readBank(): number {
  let steer = 0
  if (keys.has('ArrowLeft') || keys.has('KeyA') || touchHeld.left) steer -= 1
  if (keys.has('ArrowRight') || keys.has('KeyD') || touchHeld.right) steer += 1
  return steer
}

function syncPool(pool: THREE.Mesh[], want: number, geo: THREE.BufferGeometry, mat: THREE.Material): void {
  while (pool.length < want) {
    const m = new THREE.Mesh(geo, mat)
    m.castShadow = true
    scene.add(m)
    pool.push(m)
  }
  while (pool.length > want) {
    const m = pool.pop()!
    scene.remove(m)
  }
}

requestAnimationFrame(frame)

// Invisible test handle for test/race.mjs. Never rendered, never in the UI.
declare global {
  interface Window { __ts?: unknown }
}
window.__ts = {
  state: () => {
    if (!race) return null
    const p = race.player
    return {
      clock: race.clock,
      progress: p.progress,
      lap: p.lap,
      speed: p.speed,
      held: p.held,
      spin: p.spin,
      place: race.placeOf(p),
      bananas: race.bananas.length,
      shells: race.shells.length,
      trackLength: race.track.length,
      playerDone: race.playerDone,
      countdown,
      skin: p.skin,
      hue: p.hue,
      name: p.name,
    }
  },
  autopilot: (on: boolean) => { if (race) race.autopilot = on },
  skipCountdown: () => { countdown = Math.min(countdown, 0.01) },
  sideCam: (on: boolean) => { sideCam = on },
  skin: () => currentSkin,
  identity: () => ({ pubkey, name: myName(), hue: myHue() }),
}

// ------------------------------------------------------------- idle scene
// The lobby backdrop: the picked map slowly orbited, with the player's own
// tank parked on the start line wearing the current skin — which is also the
// garage's live preview when the garage sheet is open.

let displayTank: TankRig | null = null
let idleAngle = 0
let idleAnchor = new THREE.Vector3()

function refreshDisplayTank(): void {
  if (!displayTank) return
  applySkin(displayTank, SKINS[currentSkin], myHue())
  applyLabel(displayTank, myName(), myHue())
}

function startIdle(): void {
  race = null
  clearRace()
  hud.hidden = true
  touchEl.classList.remove('racing')

  const track = new Track(pickedMap)
  trackGroup = buildTrackMeshes(track)
  scene.add(trackGroup)
  scene.background = new THREE.Color(pickedMap.sky)
  scene.fog = new THREE.Fog(pickedMap.fog, 900, 3600)

  const s0 = track.at(0)
  displayTank = makeTank()
  displayTank.root.position.set(s0.x, 0, s0.z)
  displayTank.root.rotation.y = Math.atan2(-s0.tz, s0.tx)
  scene.add(displayTank.root)
  refreshDisplayTank()
  idleAnchor.set(s0.x, 0, s0.z)
}

function idleCamera(dt: number): void {
  idleAngle += dt * 0.08
  if (garageOpen && displayTank) {
    // Close orbit around the tank so the garage reads as a showroom.
    const r = 150
    const t = displayTank.root.position
    camera.position.set(t.x + Math.sin(idleAngle * 3) * r, 70, t.z + Math.cos(idleAngle * 3) * r)
    camera.lookAt(t.x, 22, t.z)
  } else {
    camera.position.set(
      idleAnchor.x + Math.sin(idleAngle) * 900,
      420,
      idleAnchor.z + Math.cos(idleAngle) * 900,
    )
    camera.lookAt(idleAnchor.x, 0, idleAnchor.z)
  }
}

renderWhoami()
startIdle()
