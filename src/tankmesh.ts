// The tank, in the same visual language as nostr-tank-arena: rounded-box hull
// and treads, cylinder dome, barrel, and a slightly-larger inside-out ink
// shell for the cartoon outline. Proportions match the arena tank so a skin
// worn there looks like the same tank here — that is the interoperability
// promise, and it starts with the silhouette.
//
// `applySkin` and the camo painter are ported from the arena renderer: the
// player's hue comes from their pubkey and survives every skin.

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { CamoId, Skin } from './skins'

export interface TankRig {
  root: THREE.Group
  /** Bounces, banks and spins. Cosmetic, between root and the body. */
  bob: THREE.Group
  hull: THREE.Group
  turret: THREE.Group
  label: THREE.Sprite
  body: THREE.MeshStandardMaterial
  trim: THREE.MeshStandardMaterial
  labelKey: string
}

const toy = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.02, ...extra })

const INK = new THREE.MeshBasicMaterial({ color: 0x141a26, side: THREE.BackSide })

const HULL_GEO = new RoundedBoxGeometry(44, 21, 30, 3, 5)
const TREAD_GEO = new RoundedBoxGeometry(48, 13, 9, 2, 4)
const DOME_GEO = new THREE.CylinderGeometry(13.5, 15, 16, 16)
const BARREL_GEO = new THREE.CylinderGeometry(3.4, 4.2, 34, 10)
BARREL_GEO.rotateZ(-Math.PI / 2)

/** The arena's identity rule: hue from the first two pubkey bytes. */
export function hueOf(pubkey: string): number {
  return (parseInt(pubkey.slice(0, 4), 16) || 0) % 360
}

export function makeTank(): TankRig {
  const root = new THREE.Group()
  const bob = new THREE.Group()
  root.add(bob)

  const body = toy(0xffffff)
  const trim = toy(0x333a48, { roughness: 0.85 })

  const hull = new THREE.Group()
  const hullMesh = new THREE.Mesh(HULL_GEO, body)
  hullMesh.position.y = 16
  hullMesh.castShadow = true
  const hullInk = new THREE.Mesh(HULL_GEO, INK)
  hullInk.position.y = 16
  hullInk.scale.setScalar(1.07)
  hull.add(hullMesh, hullInk)

  for (const side of [-1, 1]) {
    const tread = new THREE.Mesh(TREAD_GEO, trim)
    tread.position.set(0, 7, side * 17)
    tread.castShadow = true
    hull.add(tread)
  }

  const turret = new THREE.Group()
  turret.position.y = 28
  const dome = new THREE.Mesh(DOME_GEO, body)
  dome.castShadow = true
  const domeInk = new THREE.Mesh(DOME_GEO, INK)
  domeInk.scale.setScalar(1.09)
  const barrel = new THREE.Mesh(BARREL_GEO, trim)
  barrel.position.x = 26
  barrel.castShadow = true
  turret.add(dome, domeInk, barrel)

  bob.add(hull, turret)

  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }))
  label.scale.set(120, 30, 1)
  label.position.y = 62
  root.add(label)

  return { root, bob, hull, turret, label, body, trim, labelKey: '' }
}

/**
 * Paint a rig in a skin without losing its hue — ported from the arena.
 * Camo patterns are painted in shades of the tank's own colour; a hull dark
 * enough to hide the hue moves the hue to the trim (the carbon rule).
 */
export function applySkin(rig: TankRig, skin: Skin, hue: number): void {
  const h = hue / 360
  const light = Math.max(0.08, Math.min(0.95, 0.58 * skin.light))
  if (skin.camo) {
    const tex = camoTexture(skin.camo, hue)
    if (rig.body.map !== tex) {
      rig.body.map = tex
      rig.body.needsUpdate = true
    }
    rig.body.color.setHSL(0, 0, Math.min(0.95, 0.95 * skin.light))
  } else {
    if (rig.body.map) {
      rig.body.map = null
      rig.body.needsUpdate = true
    }
    rig.body.color.setHSL(h, 0.78, light)
  }
  rig.body.metalness = skin.metalness
  rig.body.roughness = skin.roughness
  rig.body.emissive.setHSL(h, 0.9, skin.emissive * 0.45)
  if (!skin.camo && light < 0.4) {
    rig.trim.color.setHSL(h, 0.85, 0.55)
  } else if (skin.trim !== null) {
    rig.trim.color.setHex(skin.trim)
  } else {
    rig.trim.color.setHSL(h, 0.4, 0.26)
  }
}

/** Name plate over the tank. Re-rendered only when the text changes. */
export function applyLabel(rig: TankRig, name: string, hue: number): void {
  const key = `${name}|${hue}`
  if (rig.labelKey === key) return
  rig.labelKey = key
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.font = '800 34px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 8
  ctx.strokeStyle = 'rgba(16, 20, 31, 0.85)'
  ctx.strokeText(name, 128, 34)
  ctx.fillStyle = `hsl(${hue}, 80%, 70%)`
  ctx.fillText(name, 128, 34)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = rig.label.material
  mat.map?.dispose()
  mat.map = tex
  mat.needsUpdate = true
}

/** Deterministic PRNG so every client paints the same camo blotches. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const camoCache = new Map<string, THREE.CanvasTexture>()

function camoTexture(camo: CamoId, hue: number): THREE.CanvasTexture {
  const key = `${camo}|${hue}`
  const held = camoCache.get(key)
  if (held) return held

  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const tone = (sat: number, l: number) => `hsl(${hue}, ${sat}%, ${l}%)`
  const recipes: Record<CamoId, { tones: string[]; style: 'blob' | 'pixel' | 'stripe' }> = {
    woodland: { tones: [tone(45, 32), tone(50, 18), tone(38, 44), 'hsl(0, 0%, 12%)'], style: 'blob' },
    desert: { tones: [tone(38, 62), tone(30, 48), tone(45, 74), tone(20, 55)], style: 'blob' },
    digital: { tones: [tone(40, 40), tone(45, 22), tone(35, 58), 'hsl(0, 0%, 25%)'], style: 'pixel' },
    tiger: { tones: [tone(55, 45), 'hsl(0, 0%, 10%)'], style: 'stripe' },
    navy: { tones: [tone(55, 24), tone(60, 13), tone(45, 34)], style: 'blob' },
    urban: { tones: ['hsl(0, 0%, 42%)', 'hsl(0, 0%, 25%)', 'hsl(0, 0%, 60%)', tone(65, 45)], style: 'blob' },
  }
  const { tones, style } = recipes[camo]
  const rand = mulberry32([...camo].reduce((a, c) => a * 31 + c.charCodeAt(0), 7))

  ctx.fillStyle = tones[0]
  ctx.fillRect(0, 0, size, size)
  if (style === 'pixel') {
    const cell = 8
    for (let y = 0; y < size; y += cell) {
      for (let x = 0; x < size; x += cell) {
        ctx.fillStyle = tones[Math.floor(rand() * tones.length)]
        ctx.fillRect(x, y, cell, cell)
      }
    }
  } else if (style === 'stripe') {
    ctx.strokeStyle = tones[1]
    ctx.lineCap = 'round'
    for (let i = 0; i < 14; i++) {
      ctx.lineWidth = 5 + rand() * 9
      ctx.beginPath()
      const x = rand() * size * 1.4 - size * 0.2
      ctx.moveTo(x, -8)
      ctx.bezierCurveTo(
        x - 18 + rand() * 36, size * 0.33,
        x - 18 + rand() * 36, size * 0.66,
        x + rand() * 30 - 15, size + 8,
      )
      ctx.stroke()
    }
  } else {
    for (let i = 0; i < 46; i++) {
      ctx.fillStyle = tones[1 + Math.floor(rand() * (tones.length - 1))]
      const x = rand() * size
      const y = rand() * size
      const r = 6 + rand() * 15
      ctx.beginPath()
      ctx.ellipse(x, y, r, r * (0.5 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  camoCache.set(key, texture)
  return texture
}
