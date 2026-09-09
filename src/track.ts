// The track: a closed loop in the XZ plane, defined by control points and
// sampled densely once. Everything else — the road mesh, wall collision, lap
// progress, AI steering, where the item boxes sit — reads from those samples.
//
// The sim runs in 2D (x, z). Height exists only in the renderer.

import * as THREE from 'three'

export interface TrackSample {
  x: number
  z: number
  /** Unit tangent (direction of travel). */
  tx: number
  tz: number
  /** Unit left normal. `pos + n * lateral` with positive lateral = left. */
  nx: number
  nz: number
  /** Distance from the start line along the loop, in world units. */
  cum: number
}

export interface MapDef {
  id: string
  label: string
  /** Closed loop control points, counter-clockwise. */
  points: [number, number][]
  /** Half-width of the drivable road. */
  halfWidth: number
  /** Scenery + sky flavour. */
  ground: number
  road: number
  sky: number
  fog: number
}

export const MAPS: MapDef[] = [
  {
    id: 'sunset',
    label: 'Sunset Circuit',
    points: [
      [-900, -600], [0, -760], [900, -600], [1150, 0], [900, 550],
      [350, 660], [0, 420], [-350, 660], [-950, 500], [-1150, -100],
    ],
    halfWidth: 130,
    ground: 0x3f7a3a,
    road: 0x3a3f4c,
    sky: 0xffb36b,
    fog: 0xf7c78e,
  },
  {
    id: 'frost',
    label: 'Frostbite Run',
    points: [
      [-800, -500], [200, -700], [800, -450], [600, 0], [1050, 350],
      [700, 700], [0, 550], [-500, 750], [-1050, 400], [-800, -50],
    ],
    halfWidth: 120,
    ground: 0xdfe8f2,
    road: 0x46506b,
    sky: 0x9fc4ef,
    fog: 0xc9daef,
  },
]

const SAMPLES = 800

export class Track {
  readonly def: MapDef
  readonly samples: TrackSample[] = []
  readonly length: number

  constructor(def: MapDef) {
    this.def = def
    const curve = new THREE.CatmullRomCurve3(
      def.points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      'centripetal',
    )
    const pts = curve.getSpacedPoints(SAMPLES)
    pts.pop() // getSpacedPoints on a closed curve repeats the first point
    let cum = 0
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % pts.length]
      const dx = q.x - p.x
      const dz = q.z - p.z
      const d = Math.hypot(dx, dz)
      this.samples.push({
        x: p.x,
        z: p.z,
        tx: dx / d,
        tz: dz / d,
        // Left of travel: rotate the tangent +90° about +Y.
        nx: dz / d,
        nz: -dx / d,
        cum,
      })
      cum += d
    }
    this.length = cum
  }

  /**
   * The nearest sample to a position, searched locally around a hint index so
   * the per-frame cost is constant. The hint must track the racer (it does:
   * every racer stores its index and updates it each step); a cold query can
   * pass -1 for a full scan.
   */
  closest(x: number, z: number, hint: number): number {
    const n = this.samples.length
    if (hint < 0) {
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < n; i++) {
        const s = this.samples[i]
        const d = (s.x - x) ** 2 + (s.z - z) ** 2
        if (d < bestD) { bestD = d; best = i }
      }
      return best
    }
    let best = hint
    let bestD = Infinity
    for (let off = -12; off <= 12; off++) {
      const i = (hint + off + n) % n
      const s = this.samples[i]
      const d = (s.x - x) ** 2 + (s.z - z) ** 2
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  at(i: number): TrackSample {
    const n = this.samples.length
    return this.samples[((i % n) + n) % n]
  }

  /** Signed lateral offset from the centerline at sample i. Positive = left. */
  lateral(x: number, z: number, i: number): number {
    const s = this.at(i)
    return (x - s.x) * s.nx + (z - s.z) * s.nz
  }

  /** A world position from (sample index, lateral offset). */
  posAt(i: number, lateral: number): { x: number; z: number } {
    const s = this.at(i)
    return { x: s.x + s.nx * lateral, z: s.z + s.nz * lateral }
  }
}

// ------------------------------------------------------------- the meshes

/**
 * Build the visible track: road ribbon, curbs, start line, and scattered
 * scenery. Deterministic per map so every client sees the same world.
 */
export function buildTrackMeshes(track: Track): THREE.Group {
  const group = new THREE.Group()
  const { def, samples } = track
  const n = samples.length
  const hw = def.halfWidth

  // Road ribbon: two verts per sample, triangulated around the loop.
  const roadPos: number[] = []
  const roadIdx: number[] = []
  for (let i = 0; i < n; i++) {
    const s = samples[i]
    roadPos.push(s.x + s.nx * hw, 0.5, s.z + s.nz * hw)
    roadPos.push(s.x - s.nx * hw, 0.5, s.z - s.nz * hw)
    const a = i * 2
    const b = ((i + 1) % n) * 2
    roadIdx.push(a, a + 1, b, a + 1, b + 1, b)
  }
  const roadGeo = new THREE.BufferGeometry()
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPos, 3))
  roadGeo.setIndex(roadIdx)
  roadGeo.computeVertexNormals()
  const road = new THREE.Mesh(
    roadGeo,
    new THREE.MeshStandardMaterial({ color: def.road, roughness: 0.9, metalness: 0 }),
  )
  road.receiveShadow = true
  group.add(road)

  // Curbs: short red/white segments riding each edge of the road.
  const curbMatRed = new THREE.MeshStandardMaterial({ color: 0xd94436, roughness: 0.8 })
  const curbMatWhite = new THREE.MeshStandardMaterial({ color: 0xe8e6dd, roughness: 0.8 })
  const curbRed: THREE.BufferGeometry[] = []
  const curbWhite: THREE.BufferGeometry[] = []
  const step = 4
  for (let i = 0; i < n; i += step) {
    const s = samples[i]
    const q = samples[(i + step) % n]
    for (const side of [-1, 1]) {
      const ax = s.x + s.nx * hw * side
      const az = s.z + s.nz * hw * side
      const bx = q.x + q.nx * hw * side
      const bz = q.z + q.nz * hw * side
      const len = Math.hypot(bx - ax, bz - az)
      const geo = new THREE.BoxGeometry(len, 3, 14)
      const yaw = Math.atan2(-(bz - az), bx - ax)
      const m = new THREE.Matrix4()
        .makeRotationY(yaw)
        .setPosition((ax + bx) / 2, 1.5, (az + bz) / 2)
      geo.applyMatrix4(m)
      ;((i / step) % 2 === 0 ? curbRed : curbWhite).push(geo)
    }
  }
  group.add(new THREE.Mesh(mergeGeos(curbRed), curbMatRed))
  group.add(new THREE.Mesh(mergeGeos(curbWhite), curbMatWhite))

  // Start line: a checkered strip across the road at sample 0.
  const s0 = samples[0]
  const cells = 8
  const cellW = (hw * 2) / cells
  const startGeos: THREE.BufferGeometry[][] = [[], []]
  for (let row = 0; row < 2; row++) {
    for (let c = 0; c < cells; c++) {
      const lat = -hw + cellW * (c + 0.5)
      const along = (row - 0.5) * cellW
      const geo = new THREE.PlaneGeometry(cellW, cellW)
      const m = new THREE.Matrix4()
        .makeRotationX(-Math.PI / 2)
        .premultiply(new THREE.Matrix4().makeRotationY(Math.atan2(-s0.tz, s0.tx)))
        .setPosition(
          s0.x + s0.nx * lat + s0.tx * along,
          1,
          s0.z + s0.nz * lat + s0.tz * along,
        )
      geo.applyMatrix4(m)
      startGeos[(c + row) % 2].push(geo)
    }
  }
  group.add(new THREE.Mesh(mergeGeos(startGeos[0]), new THREE.MeshBasicMaterial({ color: 0x14181f })))
  group.add(new THREE.Mesh(mergeGeos(startGeos[1]), new THREE.MeshBasicMaterial({ color: 0xf2f0e8 })))

  // Ground plane under everything.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(7000, 7000),
    new THREE.MeshStandardMaterial({ color: def.ground, roughness: 1, metalness: 0 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.5
  ground.receiveShadow = true
  group.add(ground)

  // Scenery: low-poly trees (cone on a trunk) scattered off-road, seeded per
  // map so both clients and repeat visits agree.
  let seed = [...def.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)
  const rand = () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const foliage: THREE.BufferGeometry[] = []
  const trunks: THREE.BufferGeometry[] = []
  let placed = 0
  let tries = 0
  while (placed < 90 && tries < 900) {
    tries++
    const x = (rand() - 0.5) * 4400
    const z = (rand() - 0.5) * 4400
    const i = track.closest(x, z, -1)
    const s = samples[i]
    const d = Math.hypot(x - s.x, z - s.z)
    if (d < hw + 70) continue // keep the road and its shoulders clear
    const h = 70 + rand() * 60
    const cone = new THREE.ConeGeometry(24 + rand() * 14, h, 7)
    cone.applyMatrix4(new THREE.Matrix4().setPosition(x, h / 2 + 18, z))
    foliage.push(cone)
    const trunk = new THREE.CylinderGeometry(6, 7, 20, 6)
    trunk.applyMatrix4(new THREE.Matrix4().setPosition(x, 10, z))
    trunks.push(trunk)
    placed++
  }
  const leafColor = def.id === 'frost' ? 0xd7e6ee : 0x2c6b2f
  const leaves = new THREE.Mesh(
    mergeGeos(foliage),
    new THREE.MeshStandardMaterial({ color: leafColor, roughness: 1 }),
  )
  leaves.castShadow = true
  group.add(leaves)
  group.add(new THREE.Mesh(
    mergeGeos(trunks),
    new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 1 }),
  ))

  return group
}

/** Concatenate simple position/normal/index geometries into one. */
function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry()
  const pos: number[] = []
  const norm: number[] = []
  const idx: number[] = []
  let base = 0
  for (const g of geos) {
    const p = g.getAttribute('position')
    const nrm = g.getAttribute('normal')
    const gi = g.getIndex()
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i))
      norm.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
    }
    if (gi) {
      for (let i = 0; i < gi.count; i++) idx.push(gi.getX(i) + base)
    } else {
      for (let i = 0; i < p.count; i++) idx.push(i + base)
    }
    base += p.count
    g.dispose()
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3))
  merged.setIndex(idx)
  return merged
}
