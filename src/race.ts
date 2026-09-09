// The race simulation: kart physics on a spline track, item boxes, bananas,
// shells, and AI drivers. Pure state + step() — rendering reads from it and
// never writes to it, which is the shape multiplayer will need later (remote
// racers become entries in `racers` fed from the wire instead of from AI).

import { Track } from './track'
import type { SkinId } from './skins'

export type ItemKind = 'banana' | 'shell'

export interface Racer {
  name: string
  hue: number
  skin: SkinId
  /** Local human, AI persona, or (later) a remote player. */
  kind: 'player' | 'ai'
  x: number
  z: number
  heading: number
  speed: number
  /** Nearest track sample, maintained incrementally. */
  seg: number
  /** Lap counter, 0-based until the first line crossing. */
  lap: number
  /** Total distance metric for standings: laps * length + cum. */
  progress: number
  prevCum: number
  /** Seconds of spin-out left. Zero when driving. */
  spin: number
  /** The item in the slot, if any. */
  held: ItemKind | null
  /** Race clock when this racer finished, or 0 while racing. */
  finished: number
  // --- AI persona ------------------------------------------------------
  topMul: number
  lane: number
  aiItemAt: number
}

export interface Banana {
  x: number
  z: number
}

export interface Shell {
  seg: number
  /** Fractional advance within the current segment, in world units. */
  along: number
  lat: number
  x: number
  z: number
  owner: Racer
  age: number
}

export interface ItemBox {
  x: number
  z: number
  /** Race clock when it respawns; 0 = live. */
  deadUntil: number
}

export interface Inputs {
  throttle: number
  steer: number
  useItem: boolean
}

const ACCEL = 560
const DRAG = 0.8
const BRAKE = 900
const REVERSE_MAX = -140
const TURN = 2.3
const GRASS_DRAG = 2.6
const SHOULDER = 55
const SPIN_TIME = 1.3
const SHELL_SPEED = 980
const SHELL_LIFE = 7
const BANANA_RADIUS = 34
const SHELL_RADIUS = 38
const TANK_RADIUS = 26
const BOX_RADIUS = 36
const BOX_RESPAWN = 3.5
export const TOTAL_LAPS = 3

const AI_NAMES = ['Rusty', 'Boomer', 'Treads', 'Duchess', 'Piston']
const AI_HUES = [8, 205, 275, 130, 45]
const AI_SKINS: SkinId[] = ['matte', 'chrome', 'woodland', 'neon', 'desert']

export interface RaceEvents {
  onPickup?: (r: Racer, item: ItemKind) => void
  onHit?: (victim: Racer, by: ItemKind) => void
  onLap?: (r: Racer, lap: number) => void
  onFinish?: (r: Racer) => void
}

export class Race {
  readonly track: Track
  readonly racers: Racer[] = []
  readonly bananas: Banana[] = []
  readonly shells: Shell[] = []
  readonly boxes: ItemBox[] = []
  readonly events: RaceEvents
  clock = 0
  /** Set once every racer with kind 'player' has finished. */
  playerDone = false
  /** Test rig: when true the player is driven by the AI. Never set by UI. */
  autopilot = false

  constructor(track: Track, playerName: string, playerHue: number, playerSkin: SkinId, events: RaceEvents = {}) {
    this.track = track
    this.events = events

    // Grid: two columns behind the start line, player at the back of one so
    // the first straight is about overtaking.
    const grid: Array<{ name: string; hue: number; skin: SkinId; kind: 'player' | 'ai'; topMul: number; lane: number }> = []
    for (let i = 0; i < 5; i++) {
      grid.push({
        name: AI_NAMES[i],
        hue: AI_HUES[i],
        skin: AI_SKINS[i],
        kind: 'ai',
        topMul: 0.94 + i * 0.018,
        lane: ((i % 3) - 1) * 0.5,
      })
    }
    grid.push({ name: playerName, hue: playerHue, skin: playerSkin, kind: 'player', topMul: 1, lane: 0 })

    const n = track.samples.length
    grid.forEach((g, idx) => {
      const back = 14 + Math.floor(idx / 2) * 16 // samples behind the line
      const i = (n - back) % n
      const lat = (idx % 2 === 0 ? -1 : 1) * track.def.halfWidth * 0.4
      const p = track.posAt(i, lat)
      const s = track.at(i)
      this.racers.push({
        name: g.name,
        hue: g.hue,
        skin: g.skin,
        kind: g.kind,
        x: p.x,
        z: p.z,
        heading: Math.atan2(-s.tz, s.tx),
        speed: 0,
        seg: i,
        lap: 0,
        progress: -((n - i) % n),
        prevCum: s.cum,
        spin: 0,
        held: null,
        finished: 0,
        topMul: g.topMul,
        lane: g.lane,
        aiItemAt: 2 + Math.random() * 4,
      })
    })

    // Item boxes: rows of three, spaced around the loop, skipping the stretch
    // right before the line so lap one has to earn its first item.
    const rows = 6
    for (let r = 0; r < rows; r++) {
      const i = Math.floor(((r + 0.55) / rows) * n)
      for (const lat of [-0.55, 0, 0.55]) {
        const p = track.posAt(i, lat * track.def.halfWidth)
        this.boxes.push({ x: p.x, z: p.z, deadUntil: 0 })
      }
    }
  }

  get player(): Racer {
    return this.racers.find((r) => r.kind === 'player')!
  }

  step(dt: number, playerInputs: Inputs): void {
    this.clock += dt
    for (const r of this.racers) {
      const inputs = r.kind === 'player' && !this.autopilot ? playerInputs : this.aiInputs(r)
      this.stepRacer(r, dt, inputs)
    }
    this.stepShells(dt)
    this.collideRacers()
    this.rank()
  }

  // ------------------------------------------------------------ physics

  private stepRacer(r: Racer, dt: number, inputs: Inputs): void {
    if (r.finished) inputs = { throttle: 0.25, steer: 0, useItem: false } // victory lap coast

    if (inputs.useItem && r.held && r.spin <= 0) this.useItem(r)

    if (r.spin > 0) {
      // The pirouette itself is cosmetic (the renderer spins the bob group);
      // the heading is left alone so the tank comes out pointing where it was
      // going — spun out, not lost.
      r.spin = Math.max(0, r.spin - dt)
      r.speed *= Math.max(0, 1 - 4 * dt)
    } else {
      const t = inputs.throttle
      if (t >= 0) {
        r.speed += (t * ACCEL - DRAG * r.speed) * dt
      } else if (r.speed > 0) {
        r.speed = Math.max(0, r.speed + t * BRAKE * dt)
      } else {
        r.speed = Math.max(REVERSE_MAX, r.speed + t * ACCEL * 0.6 * dt)
      }
      const grip = Math.min(1, Math.abs(r.speed) / 150)
      r.heading += inputs.steer * TURN * grip * Math.sign(r.speed || 1) * dt
    }

    const top = 700 * r.topMul
    r.speed = Math.min(top, r.speed)

    r.x += Math.cos(r.heading) * r.speed * dt
    r.z -= Math.sin(r.heading) * r.speed * dt

    // Track-relative bookkeeping: nearest sample, lateral clamp, lap line.
    r.seg = this.track.closest(r.x, r.z, r.seg)
    const hw = this.track.def.halfWidth
    let lat = this.track.lateral(r.x, r.z, r.seg)

    if (Math.abs(lat) > hw) {
      // On the shoulder: heavy drag, and a hard wall at its far edge.
      r.speed -= r.speed * GRASS_DRAG * dt
      const limit = hw + SHOULDER
      if (Math.abs(lat) > limit) {
        lat = Math.sign(lat) * limit
        const p = this.track.posAt(r.seg, lat)
        r.x = p.x
        r.z = p.z
        // Nudge the nose back toward the direction of travel and scrub speed,
        // which reads as a wall grind rather than a bounce.
        const s = this.track.at(r.seg)
        const trackYaw = Math.atan2(-s.tz, s.tx)
        r.heading += angleDiff(trackYaw, r.heading) * Math.min(1, 6 * dt)
        r.speed *= Math.max(0, 1 - 2.5 * dt)
      }
    }

    const cum = this.track.at(r.seg).cum
    const L = this.track.length
    if (r.prevCum > L * 0.8 && cum < L * 0.2) {
      r.lap++
      if (r.lap >= TOTAL_LAPS + 1 && !r.finished) {
        r.finished = this.clock
        this.events.onFinish?.(r)
        if (r.kind === 'player') this.playerDone = true
      } else if (!r.finished && r.lap >= 1) {
        this.events.onLap?.(r, r.lap)
      }
    } else if (cum > L * 0.8 && r.prevCum < L * 0.2) {
      r.lap--
    }
    r.prevCum = cum
    r.progress = r.lap * L + cum

    // Pickups: boxes and bananas share the simple circle test.
    if (r.spin <= 0 && !r.finished) {
      if (!r.held) {
        for (const box of this.boxes) {
          if (box.deadUntil > this.clock) continue
          if (dist2(r.x, r.z, box.x, box.z) < (BOX_RADIUS + TANK_RADIUS) ** 2) {
            box.deadUntil = this.clock + BOX_RESPAWN
            r.held = Math.random() < 0.5 ? 'banana' : 'shell'
            this.events.onPickup?.(r, r.held)
            break
          }
        }
      }
      for (let i = this.bananas.length - 1; i >= 0; i--) {
        const b = this.bananas[i]
        if (dist2(r.x, r.z, b.x, b.z) < (BANANA_RADIUS + TANK_RADIUS) ** 2) {
          this.bananas.splice(i, 1)
          r.spin = SPIN_TIME
          this.events.onHit?.(r, 'banana')
          break
        }
      }
    }
  }

  private useItem(r: Racer): void {
    const item = r.held!
    r.held = null
    if (item === 'banana') {
      // Dropped a tank-length behind, so it catches the pursuer, not the tail.
      r.speed = Math.max(r.speed, 0)
      this.bananas.push({
        x: r.x - Math.cos(r.heading) * 70,
        z: r.z + Math.sin(r.heading) * 70,
      })
    } else {
      const lat = this.track.lateral(r.x, r.z, r.seg)
      this.shells.push({
        seg: r.seg,
        along: 0,
        lat: clamp(lat, -this.track.def.halfWidth * 0.8, this.track.def.halfWidth * 0.8),
        x: r.x,
        z: r.z,
        owner: r,
        age: 0,
      })
    }
  }

  private stepShells(dt: number): void {
    const n = this.track.samples.length
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i]
      sh.age += dt
      if (sh.age > SHELL_LIFE) {
        this.shells.splice(i, 1)
        continue
      }
      // Advance along the centerline, sliding gently to lane 0 so it hunts
      // down the racing line the way a green shell hugs the road.
      let travel = SHELL_SPEED * dt
      while (travel > 0) {
        const a = this.track.at(sh.seg)
        const b = this.track.at(sh.seg + 1)
        const segLen = Math.hypot(b.x - a.x, b.z - a.z)
        const left = segLen - sh.along
        if (travel < left) {
          sh.along += travel
          travel = 0
        } else {
          travel -= left
          sh.along = 0
          sh.seg = (sh.seg + 1) % n
        }
      }
      sh.lat += (0 - sh.lat) * Math.min(1, 1.2 * dt)
      const s = this.track.at(sh.seg)
      sh.x = s.x + s.tx * sh.along + s.nx * sh.lat
      sh.z = s.z + s.tz * sh.along + s.nz * sh.lat

      for (const r of this.racers) {
        if (r === sh.owner && sh.age < 0.6) continue
        if (r.spin > 0) continue
        if (dist2(r.x, r.z, sh.x, sh.z) < (SHELL_RADIUS + TANK_RADIUS) ** 2) {
          r.spin = SPIN_TIME
          this.shells.splice(i, 1)
          this.events.onHit?.(r, 'shell')
          break
        }
      }
    }
  }

  /** Soft tank-vs-tank separation so the pack jostles instead of stacking. */
  private collideRacers(): void {
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        const a = this.racers[i]
        const b = this.racers[j]
        const dx = b.x - a.x
        const dz = b.z - a.z
        const d2 = dx * dx + dz * dz
        const min = TANK_RADIUS * 2
        if (d2 > min * min || d2 === 0) continue
        const d = Math.sqrt(d2)
        const push = (min - d) / 2
        const ux = dx / d
        const uz = dz / d
        a.x -= ux * push
        a.z -= uz * push
        b.x += ux * push
        b.z += uz * push
      }
    }
  }

  // ----------------------------------------------------------------- AI

  private aiInputs(r: Racer): Inputs {
    // Chase a point on the centerline ahead of the tank, offset into the
    // persona's lane, weaving a little so five bots don't ride one rail.
    const look = 14 + Math.floor(Math.abs(r.speed) / 45)
    const target = this.track.at(r.seg + look)
    const wobble = Math.sin(this.clock * 0.7 + r.hue) * 0.25
    const lat = (r.lane + wobble) * this.track.def.halfWidth * 0.6
    const tx = target.x + target.nx * lat
    const tz = target.z + target.nz * lat

    const want = Math.atan2(-(tz - r.z), tx - r.x)
    const diff = angleDiff(want, r.heading)
    const steer = clamp(diff * 2.2, -1, 1)

    // Rubber band around the player so the pack stays a fight: trailing bots
    // get quicker, the runaway leader eases off.
    const player = this.player
    const gap = r.progress - player.progress
    if (!player.finished) {
      if (gap < -600) r.topMul = Math.min(1.1, r.topMul + 0.0005)
      else if (gap > 600) r.topMul = Math.max(0.88, r.topMul - 0.0005)
    }

    let useItem = false
    if (r.held && this.clock > r.aiItemAt) {
      useItem = true
      r.aiItemAt = this.clock + 2 + Math.random() * 4
    }

    const hardCorner = Math.abs(diff) > 1.1
    return { throttle: hardCorner ? 0.45 : 1, steer, useItem }
  }

  // ------------------------------------------------------------ standings

  private rank(): void {
    // Sorted copy; place is read off it. Finished racers rank by finish time.
    const order = [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finished - b.finished
      if (a.finished) return -1
      if (b.finished) return 1
      return b.progress - a.progress
    })
    order.forEach((r, i) => { (r as Racer & { place: number }).place = i + 1 })
  }

  placeOf(r: Racer): number {
    return (r as Racer & { place?: number }).place ?? 1
  }
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  return (ax - bx) ** 2 + (az - bz) ** 2
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Shortest signed angle from `from` to `to`, in (-π, π]. */
function angleDiff(to: number, from: number): number {
  let d = to - from
  while (d > Math.PI) d -= Math.PI * 2
  while (d <= -Math.PI) d += Math.PI * 2
  return d
}
