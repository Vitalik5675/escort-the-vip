import {
  GRID_COLS, GRID_ROWS, WALL_COUNT,
  H_WALL_COUNT, hWallIndex, vWallIndex,
  WALL_NONE, WALL_CONCRETE, WALL_HEDGE, WALL_METAL_WALL,
  WALL_WOOD_FENCE, WALL_METAL_DOOR, WALL_WOOD_DOOR,
  STATE_SOLID, STATE_OPEN, STATE_DESTROYED, WALL_HP_DEFAULT,
  MazeOptions, MazeWeight, MAZE_OPTIONS,
  randInt,
} from './constants'
import { placeVipAndSafetyRandom, RegionSide } from './MazeTemplates'
import { Tile, findPath, reachableTiles, wallIdxBetween } from './Pathfinder'

// ── Public types ──────────────────────────────────────────────────────────────

// Tile lives in Pathfinder.ts and is imported above; re-export so callers
// that only touch MazeGenerator don't need an extra Pathfinder import.
export { Tile }

export interface MazeConfig {
  templateId:    string

  wallTypes:     number[]
  wallStates:    number[]
  wallHP:        number[]
  wallMaxHP:     number[]

  staticMask:    boolean[]

  vipSpawn:      Tile
  vipRoomTiles:  Tile[]
  vipRoomDoors:  number[]

  safetyTiles:   Tile[]

  spawnPool:     Tile[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

// Generation pulls every knob from MAZE_OPTIONS in constants.ts (single
// source of tuning for all matches). Two strict, non-overlapping wall sets:
//   • Structural walls (between corridors) → CONCRETE / METAL_WALL / HEDGE / WOOD_FENCE
//   • Corridor obstacles                  → METAL_DOOR / WOOD_DOOR only

function pickWeighted(bias: Array<{ type: number; weight: number }>): number {
  const total = bias.reduce((s, b) => s + b.weight, 0)
  let roll = Math.random() * total
  for (const b of bias) {
    roll -= b.weight
    if (roll <= 0) return b.type
  }
  return bias[0].type
}

// Builds a length-N sequence that contains each type proportionally to its
// weight, ordered so consecutive picks always rotate to a different type
// (greedy "largest deficit" round-robin). Use this when you want the types
// CHARACTERISTICALLY ALTERNATED rather than independently random — produces
// balanced counts and avoids long runs of the same type.
function buildBalancedSequence(bias: Array<{ type: number; weight: number }>, count: number): number[] {
  if (count <= 0 || bias.length === 0) return []
  const total = bias.reduce((s, b) => s + b.weight, 0) || 1
  const slots = bias.map(b => ({ type: b.type, share: b.weight / total, current: 0 }))
  const out: number[] = []
  let lastType = -1
  for (let k = 0; k < count; k++) {
    // Pick the slot whose actual count is most behind its proportional share.
    // Skip whichever was picked last so two identical types never sit next to
    // each other in the sequence (unless only one type is in the bias).
    let bestIdx = -1
    let bestGap = -Infinity
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].type === lastType && slots.length > 1) continue
      const expected = slots[i].share * (k + 1)
      const gap = expected - slots[i].current
      if (gap > bestGap) { bestGap = gap; bestIdx = i }
    }
    if (bestIdx < 0) bestIdx = 0   // fallback (shouldn't hit unless slots empty)
    out.push(slots[bestIdx].type)
    slots[bestIdx].current++
    lastType = slots[bestIdx].type
  }
  return out
}

// ── Single-route pre-carving ─────────────────────────────────────────────────
// Before the DFS runs, we hand-carve one escort route from a VIP-room door
// to the safety zone, routed through a single lateral waypoint so the path
// crosses the maze rather than running in a straight line. One route keeps
// the open-corridor footprint minimal; the DFS fills everything else.


interface RouteCarveResult {
  routeWalls: Set<number>
  routeCells: Set<number>
}

function tileKey(t: Tile): number { return t.row * GRID_COLS + t.col }

// Cell just outside a VIP-room door (the side NOT inside the room).
function outsideOfVipDoor(
  doorIdx: number,
  vipRoom: { colMin: number; colMax: number; rowMin: number; rowMax: number }
): Tile | null {
  const isH = doorIdx < H_WALL_COUNT
  let a: Tile, b: Tile
  if (isH) {
    const r = (doorIdx / GRID_COLS) | 0
    const c = doorIdx % GRID_COLS
    a = { col: c, row: r }; b = { col: c, row: r + 1 }
  } else {
    const r = ((doorIdx - H_WALL_COUNT) / (GRID_COLS - 1)) | 0
    const c = (doorIdx - H_WALL_COUNT) % (GRID_COLS - 1)
    a = { col: c, row: r }; b = { col: c + 1, row: r }
  }
  const inRoom = (t: Tile) =>
    t.col >= vipRoom.colMin && t.col <= vipRoom.colMax &&
    t.row >= vipRoom.rowMin && t.row <= vipRoom.rowMax
  if (inRoom(a) && !inRoom(b)) return b
  if (inRoom(b) && !inRoom(a)) return a
  return null
}

// BFS for nearest non-blocked tile (used to nudge waypoints out of the VIP
// room or safety zone if random arithmetic landed them inside).
function nearestOpenTile(t: Tile, blockedTiles: Set<number>): Tile {
  const inBounds = (q: Tile) =>
    q.col >= 0 && q.col < GRID_COLS && q.row >= 0 && q.row < GRID_ROWS
  if (inBounds(t) && !blockedTiles.has(tileKey(t))) return t
  const queue: Tile[] = [t]
  const seen = new Set<number>([tileKey(t)])
  while (queue.length > 0) {
    const c = queue.shift()!
    for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as Array<[number, number]>) {
      const n: Tile = { col: c.col + dc, row: c.row + dr }
      if (!inBounds(n)) continue
      const k = tileKey(n)
      if (seen.has(k)) continue
      seen.add(k)
      if (!blockedTiles.has(k)) return n
      queue.push(n)
    }
  }
  return t
}

// Random Manhattan walk from `from` to `to` that interleaves the dx and dy
// steps non-deterministically (so the path zig-zags rather than going as a
// straight L). Skips into blocked tiles by trying alternate cardinals.
function windingPath(from: Tile, to: Tile, blockedTiles: Set<number>): Tile[] {
  const path: Tile[] = [{ ...from }]
  let cur: Tile = { ...from }
  const maxSteps = (GRID_COLS + GRID_ROWS) * 4
  for (let step = 0; step < maxSteps; step++) {
    if (cur.col === to.col && cur.row === to.row) break
    const dx = to.col - cur.col, dy = to.row - cur.row
    const ax = Math.abs(dx),     ay = Math.abs(dy)

    // Pick a primary axis by random weight (each axis weighted by how much
    // distance is left along it). Occasionally inject a perpendicular detour
    // to make the path twist.
    let dc = 0, dr = 0
    if (ax === 0 && ay === 0) break
    const detour = (ax > 0 || ay > 0) && Math.random() < 0.42
    if (detour) {
      // Step perpendicular to the current best direction, only if in bounds.
      if (ax >= ay) {
        dr = Math.random() < 0.5 ? 1 : -1
      } else {
        dc = Math.random() < 0.5 ? 1 : -1
      }
    } else {
      const r = Math.random() * (ax + ay)
      if (r < ax) dc = Math.sign(dx)
      else        dr = Math.sign(dy)
    }

    let next: Tile = { col: cur.col + dc, row: cur.row + dr }
    const valid = (q: Tile) =>
      q.col >= 0 && q.col < GRID_COLS && q.row >= 0 && q.row < GRID_ROWS &&
      !blockedTiles.has(tileKey(q))

    if (!valid(next)) {
      // Fall back to any cardinal that points toward `to` and is valid.
      const alts: Array<[number, number]> = [
        [Math.sign(dx) || 0, 0], [0, Math.sign(dy) || 0],
        [-Math.sign(dx) || 0, 0], [0, -Math.sign(dy) || 0],
        [1, 0], [-1, 0], [0, 1], [0, -1],
      ]
      let took: Tile | null = null
      for (const [ac, ar] of alts) {
        if (ac === 0 && ar === 0) continue
        const n: Tile = { col: cur.col + ac, row: cur.row + ar }
        if (valid(n)) { took = n; break }
      }
      if (!took) break
      next = took
    }
    path.push(next)
    cur = next
  }
  return path
}

function carveOneRoute(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  from: Tile, to: Tile, blockedTiles: Set<number>,
  routeWalls: Set<number>, routeCells: Set<number>
) {
  const path = windingPath(from, to, blockedTiles)
  if (path.length === 0) return
  routeCells.add(tileKey(path[0]))
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1]
    routeCells.add(tileKey(b))
    const wIdx = wallIdxBetween(a, b)
    if (wIdx < 0 || staticMask[wIdx]) continue
    walls[wIdx]  = WALL_NONE
    states[wIdx] = STATE_SOLID
    hp[wIdx]     = 0
    maxHp[wIdx]  = 0
    routeWalls.add(wIdx)
  }
}

// Plot `routeCount` escort routes from VIP doors to safety zone:
//   • Lateral waypoints are spread evenly across the transverse axis (the
//     dimension perpendicular to VIP→safety) so each route covers its own
//     "side" of the maze instead of running side-by-side.
//   • Each waypoint is fed by the door exit at the matching lateral rank
//     (closest available door on that side). If there are fewer doors than
//     waypoints, the extremes recycle.
//   • `branchCount` cross-connections link adjacent waypoints in the central
//     area, giving the routes a branching network where players can switch
//     lanes mid-maze. branchCount is capped at (routeCount − 1).
function plotEscortRoutes(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  vipDoors: number[], vipRoom: { colMin: number; colMax: number; rowMin: number; rowMax: number },
  safetyAnchor: Tile, blockedTiles: Set<number>,
  routeCount: number, branchCount: number,
): RouteCarveResult {
  const routeWalls = new Set<number>()
  const routeCells = new Set<number>()
  const exits = vipDoors
    .map(d => outsideOfVipDoor(d, vipRoom))
    .filter((t): t is Tile => t !== null)
  if (exits.length === 0 || routeCount <= 0) return { routeWalls, routeCells }
  routeCount  = Math.max(1, Math.floor(routeCount))
  branchCount = Math.max(0, Math.min(Math.floor(branchCount), routeCount - 1))

  // Reference point for the principal axis — pick the door exit closest to
  // the safety anchor (most "natural" exit for the journey).
  const ref = exits.reduce((best, t) => {
    const d  = Math.abs(t.col - safetyAnchor.col) + Math.abs(t.row - safetyAnchor.row)
    const bd = Math.abs(best.col - safetyAnchor.col) + Math.abs(best.row - safetyAnchor.row)
    return d < bd ? t : best
  }, exits[0])

  const dCol = safetyAnchor.col - ref.col
  const dRow = safetyAnchor.row - ref.row
  const horizontal = Math.abs(dCol) >= Math.abs(dRow)
  const midCol = ((ref.col + safetyAnchor.col) / 2) | 0
  const midRow = ((ref.row + safetyAnchor.row) / 2) | 0

  // Spread N waypoints evenly along the transverse axis, inset from the
  // arena edge so a route doesn't hug the boundary. With N=1 the waypoint
  // sits at the midline; with N=3 it lands at low / mid / high; etc.
  const INSET = 3
  let waypoints: Tile[] = []
  if (horizontal) {
    const lo = INSET, hi = GRID_ROWS - 1 - INSET
    for (let i = 0; i < routeCount; i++) {
      const t = routeCount === 1 ? 0.5 : i / (routeCount - 1)
      const r = Math.round(lo + (hi - lo) * t) | 0
      waypoints.push({ col: midCol, row: r })
    }
  } else {
    const lo = INSET, hi = GRID_COLS - 1 - INSET
    for (let i = 0; i < routeCount; i++) {
      const t = routeCount === 1 ? 0.5 : i / (routeCount - 1)
      const c = Math.round(lo + (hi - lo) * t) | 0
      waypoints.push({ col: c, row: midRow })
    }
  }
  waypoints = waypoints.map(w => nearestOpenTile(w, blockedTiles))

  // Pair each waypoint with the door exit at the same lateral rank so each
  // route enters the maze from a different side of the VIP room. Fewer doors
  // than waypoints → extremes recycle the closest exit.
  const lateralOf = (t: Tile) => horizontal ? t.row : t.col
  const exitsByLateral     = [...exits].sort((a, b)     => lateralOf(a) - lateralOf(b))
  const waypointsByLateral = [...waypoints].sort((a, b) => lateralOf(a) - lateralOf(b))

  for (let i = 0; i < waypointsByLateral.length; i++) {
    const wp   = waypointsByLateral[i]
    const door = exitsByLateral[Math.min(i, exitsByLateral.length - 1)]
    carveOneRoute(walls, states, hp, maxHp, staticMask,
      door, wp, blockedTiles, routeWalls, routeCells)
    carveOneRoute(walls, states, hp, maxHp, staticMask,
      wp, safetyAnchor, blockedTiles, routeWalls, routeCells)
  }

  // Cross-connections in the central area: link `branchCount` pairs of
  // adjacent waypoints, picked from a shuffled list of adjacent pairs so a
  // smaller branchCount than (routeCount−1) doesn't always pick the same
  // pair.
  const adjacentPairs: Array<[Tile, Tile]> = []
  for (let i = 0; i < waypointsByLateral.length - 1; i++) {
    adjacentPairs.push([waypointsByLateral[i], waypointsByLateral[i + 1]])
  }
  shuffle(adjacentPairs)
  for (let k = 0; k < branchCount && k < adjacentPairs.length; k++) {
    const [a, b] = adjacentPairs[k]
    carveOneRoute(walls, states, hp, maxHp, staticMask,
      a, b, blockedTiles, routeWalls, routeCells)
  }

  return { routeWalls, routeCells }
}

function wallTouchesBlocked(idx: number, blockedTiles: Set<number>): boolean {
  const isH = idx < H_WALL_COUNT
  let aCol: number, aRow: number, bCol: number, bRow: number
  if (isH) {
    const r = (idx / GRID_COLS) | 0, c = idx % GRID_COLS
    aCol = c; aRow = r; bCol = c; bRow = r + 1
  } else {
    const r = ((idx - H_WALL_COUNT) / (GRID_COLS - 1)) | 0
    const c = (idx - H_WALL_COUNT) % (GRID_COLS - 1)
    aCol = c; aRow = r; bCol = c + 1; bRow = r
  }
  return blockedTiles.has(aRow * GRID_COLS + aCol)
      || blockedTiles.has(bRow * GRID_COLS + bCol)
}

// ── DFS carve — classic recursive backtracking ────────────────────────────────
// Pre-fills every non-static wall with CONCRETE, then picks a random unvisited
// neighbour from the current cell, carves the wall between them, and recurses.
// On dead-end → backtrack. Result: every cell reachable; one path between any
// two cells; lots of dead-ends. The visual signature of a "real" maze.

function carveMaze(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  blockedTiles: Set<number>, straightBias: number,
  routeWalls: Set<number>, routeCells: Set<number>
) {
  // Step 1: solid CONCRETE everywhere that isn't already static or part of
  // a pre-carved escort route (those walls must stay open).
  for (let i = 0; i < WALL_COUNT; i++) {
    if (staticMask[i]) continue
    if (routeWalls.has(i)) continue
    walls[i]  = WALL_CONCRETE
    states[i] = STATE_SOLID
    hp[i]     = 0
    maxHp[i]  = 0
  }

  // DFS roots: route cells first (so DFS extends OUTWARD from each route into
  // the rest of the parcel — keeps everything connected), then any remaining
  // open cells as fallback seeds for components the routes never touched.
  const visited = new Set<number>(routeCells)
  const seedList: Tile[] = []
  for (const key of routeCells) {
    seedList.push({ col: key % GRID_COLS, row: (key / GRID_COLS) | 0 })
  }
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const k = r * GRID_COLS + c
      if (blockedTiles.has(k)) continue
      if (routeCells.has(k)) continue
      seedList.push({ col: c, row: r })
    }
  }
  if (seedList.length === 0) return

  for (const seed of seedList) {
    const seedKey = seed.row * GRID_COLS + seed.col
    // Route-cell seeds are already in `visited` and are used purely as DFS
    // roots; non-route seeds get added on first visit.
    if (!routeCells.has(seedKey)) {
      if (visited.has(seedKey)) continue
      visited.add(seedKey)
    }
    const stack: Tile[] = [seed]
    const lastDirs: Array<[number, number] | null> = [null]

    while (stack.length > 0) {
      const cur     = stack[stack.length - 1]
      const lastDir = lastDirs[lastDirs.length - 1]
      const dirs: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]]
      shuffle(dirs)

      // Bias toward continuing in the previous direction → longer corridors.
      let preferred: [number, number] | null = null
      if (lastDir && Math.random() < straightBias) preferred = lastDir

      let advanced = false
      const tryDir = ([dc, dr]: [number, number]): boolean => {
        const nc = cur.col + dc, nr = cur.row + dr
        if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) return false
        const nKey = nr * GRID_COLS + nc
        if (visited.has(nKey)) return false
        if (blockedTiles.has(nKey)) return false
        const wallIdx = wallIdxBetween(cur, { col: nc, row: nr })
        if (wallIdx < 0 || staticMask[wallIdx]) return false
        walls[wallIdx] = WALL_NONE
        visited.add(nKey)
        stack.push({ col: nc, row: nr })
        lastDirs.push([dc, dr])
        return true
      }

      if (preferred && tryDir(preferred)) advanced = true
      else for (const d of dirs) { if (tryDir(d)) { advanced = true; break } }

      if (!advanced) { stack.pop(); lastDirs.pop() }
    }
  }
}

// Braid: open extra random CONCRETE walls so the maze isn't a strict tree.
// Higher prob → more loops / shortcuts → easier navigation.
function braidMaze(
  walls: number[], staticMask: boolean[], blockedTiles: Set<number>, prob: number
) {
  for (let i = 0; i < WALL_COUNT; i++) {
    if (staticMask[i]) continue
    if (walls[i] !== WALL_CONCRETE) continue
    if (wallTouchesBlocked(i, blockedTiles)) continue
    if (Math.random() < prob) walls[i] = WALL_NONE
  }
}

// Re-paint surviving CONCRETE walls per the difficulty's material bias.
function varyMaterials(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  bias: Array<{ type: number; weight: number }>
) {
  for (let i = 0; i < WALL_COUNT; i++) {
    if (staticMask[i]) continue
    if (walls[i] !== WALL_CONCRETE) continue
    const newType = pickWeighted(bias)
    if (newType !== WALL_CONCRETE) {
      walls[i]  = newType
      states[i] = STATE_SOLID
      const def = WALL_HP_DEFAULT[newType] ?? 0
      hp[i]     = def
      maxHp[i]  = def
    }
  }
}

// ── Bridge detection (Tarjan) ─────────────────────────────────────────────────
// Знаходить усі WALL_NONE стіни, які є "мостами" у "завжди-прохідному" графі
// (WALL_NONE + двері розглядаються як прохідні ребра). Закриття моста ділить
// лабіринт на два відсіки. Повертає Map<wallIdx, minSectionSize> де
// minSectionSize = min(розмір лівої частини, розмір правої частини).
function findBridgeSections(
  walls: number[],
  blockedTiles: Set<number>
): Map<number, number> {
  const DIRS: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]]
  const N    = GRID_ROWS * GRID_COLS
  const disc = new Int32Array(N).fill(-1)
  const low  = new Int32Array(N)
  const sz   = new Int32Array(N).fill(1)
  const result = new Map<number, number>()
  let timer = 0

  // Двері рахуються як прохідні — ми шукаємо "структурні" мости, а не
  // блокування за рахунок вже розставлених дверей.
  const isPassable = (wIdx: number): boolean => {
    if (wIdx < 0 || wIdx >= WALL_COUNT) return false
    const t = walls[wIdx]
    return t === WALL_NONE || t === WALL_METAL_DOOR || t === WALL_WOOD_DOOR
  }

  let totalPassable = 0
  for (let u = 0; u < N; u++) {
    if (!blockedTiles.has(u)) totalPassable++
  }

  // Рекурсивний DFS з відстеженням часу входу (disc), low-link і розміру
  // піддерева (sz). parentWall — індекс стіни через яку прийшли (щоб не
  // повертатись назад по тому ж ребру).
  function dfs(u: number, parentWall: number): void {
    const uc = u % GRID_COLS, ur = (u / GRID_COLS) | 0
    disc[u] = low[u] = timer++
    sz[u] = 1
    for (const [dc, dr] of DIRS) {
      const vc = uc + dc, vr = ur + dr
      if (vc < 0 || vc >= GRID_COLS || vr < 0 || vr >= GRID_ROWS) continue
      const v  = vr * GRID_COLS + vc
      if (blockedTiles.has(v)) continue
      const wIdx = wallIdxBetween({ col: uc, row: ur }, { col: vc, row: vr })
      if (!isPassable(wIdx)) continue
      if (disc[v] === -1) {
        dfs(v, wIdx)
        sz[u] += sz[v]
        low[u] = Math.min(low[u], low[v])
        // Міст знайдено, і це WALL_NONE стіна → кандидат для дверей
        if (low[v] > disc[u] && walls[wIdx] === WALL_NONE) {
          const gated = sz[v]
          result.set(wIdx, Math.min(gated, totalPassable - gated))
        }
      } else if (wIdx !== parentWall) {
        low[u] = Math.min(low[u], disc[v])
      }
    }
  }

  for (let u = 0; u < N; u++) {
    if (!blockedTiles.has(u) && disc[u] === -1) dfs(u, -1)
  }
  return result
}

// ── Partition-based door placement ────────────────────────────────────────────
// Замінює випадкове placeCorridorObstacles. Тут двері ставляться тільки на
// стіни-мости: закриття такої стіни реально ДІЛИТЬ лабіринт на два відсіки.
// Це гарантує, що кожна двері є "воротами" до певної частини мапи, а не
// просто перепоною посеред коридору.
//
// Порядок роботи:
//   1. findBridgeSections → Map<wallIdx, minSectionSize> для WALL_NONE мостів
//   2. Відфільтровуємо мости з minSectionSize < MIN_SECTION_SIZE
//      (маленькі тупики вже закриті placeDeadEndDoors)
//   3. Сортуємо за розміром відсіку (від більшого до меншого)
//   4. Стратифікована вибірка: ділимо список на `target` рівних смуг і
//      беремо по одному кандидату з кожної → двері рівномірно по всьому
//      дереву лабіринту, а не лише у найбільших гілках.
function placePartitionDoors(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  blockedTiles: Set<number>,
  countMin: number, countMax: number,
  bias: MazeWeight[]
) {
  // Мінімум 3 плитки у відсіку — тупики розміром 1-2 вже оброблені
  // placeDeadEndDoors і тут не з'являться (їх стіни вже є дверима,
  // а не WALL_NONE, тому findBridgeSections їх ігнорує як кандидатів).
  const MIN_SECTION_SIZE = 3

  const bridgeMap = findBridgeSections(walls, blockedTiles)

  const candidates: Array<{ wallIdx: number; sectionSize: number }> = []
  for (const [wallIdx, sectionSize] of bridgeMap) {
    if (staticMask[wallIdx]) continue
    if (wallTouchesBlocked(wallIdx, blockedTiles)) continue
    if (sectionSize < MIN_SECTION_SIZE) continue
    candidates.push({ wallIdx, sectionSize })
  }
  if (candidates.length === 0) return

  // Сортуємо: більший відсік = більш стратегічно важлива точка
  candidates.sort((a, b) => b.sectionSize - a.sectionSize)

  const target = Math.min(candidates.length, randInt(countMin, countMax))
  if (target <= 0) return

  // Стратифікована вибірка: ділимо відсортований список на `target` смуг і
  // беремо по одному з кожної — так двері розподіляються по всьому лабіринту
  // (від "головних воріт" великих секцій до "маленьких розгалужень").
  const typeSeq = buildBalancedSequence(bias, target)
  const bandSize = candidates.length / target
  for (let i = 0; i < target; i++) {
    const lo = Math.floor(i * bandSize)
    const hi = Math.min(Math.floor((i + 1) * bandSize), candidates.length) - 1
    const pickIdx  = randInt(lo, Math.max(lo, hi))
    const { wallIdx } = candidates[pickIdx]
    const newType  = typeSeq[i]
    walls[wallIdx]  = newType
    states[wallIdx] = STATE_SOLID
    const def = WALL_HP_DEFAULT[newType] ?? 0
    hp[wallIdx]     = def
    maxHp[wallIdx]  = def
  }
}


// ── Dead-end entrance doors ───────────────────────────────────────────────────
// Dead-end terminal = не заблокована плитка з рівно ОДНИМ відкритим проходом
// (WALL_NONE). Ця функція ставить двері на той єдиний вхід, щоб тупик
// залишався доступним, але гатованим: гравці мусять відчинити або зламати двері.
//
// Виконується ПІСЛЯ varyMaterials (структурні стіни вже пофарбовані) і ДО
// placeCorridorObstacles (вхід у тупик вже зайнятий — бюджет перешкод його
// не чіпатиме вдруге).
function placeDeadEndDoors(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  blockedTiles: Set<number>
): void {
  const DIRS: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]]
  // Ліміт тупикових дверей — поєднується з partition doors (~20-35).
  // Разом: ~70 тупикових + ~25 partition = ~95 дверей на 240 плиток.
  const MAX_DEAD_END_DOORS = 70

  // Walk the corridor from a terminal dead-end tile forward (excluding the
  // direction we came from) until we hit a junction or boundary.
  // Returns how many tiles deep the dead-end branch is:
  //   depth 1 = single tile directly off a junction (too shallow to gate)
  //   depth 2 = 1 extra corridor tile before junction
  //   depth 3+ = meaningful branch corridor
  const corridorDepth = (startCol: number, startRow: number): number => {
    let depth = 1
    let curCol = startCol, curRow = startRow
    let prevCol = -1, prevRow = -1
    for (let step = 0; step < 24; step++) {
      const forwards: Array<[number, number]> = []
      for (const [dc, dr] of DIRS) {
        const nc = curCol + dc, nr = curRow + dr
        if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue
        if (nc === prevCol && nr === prevRow) continue  // skip back-direction
        const wIdx = wallIdxBetween({ col: curCol, row: curRow }, { col: nc, row: nr })
        if (wIdx >= 0 && walls[wIdx] === WALL_NONE) forwards.push([dc, dr])
      }
      if (forwards.length !== 1) break  // junction (2+) or trapped (0)
      const [dc, dr] = forwards[0]
      prevCol = curCol; prevRow = curRow
      curCol += dc; curRow += dr
      depth++
    }
    return depth
  }

  // Collect all terminal dead-end entrance walls with their corridor depth.
  interface DeadEndEntry { wallIdx: number; depth: number }
  const candidates: DeadEndEntry[] = []
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (blockedTiles.has(r * GRID_COLS + c)) continue
      const openWalls: number[] = []
      for (const [dc, dr] of DIRS) {
        const nc = c + dc, nr = r + dr
        if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue
        const wIdx = wallIdxBetween({ col: c, row: r }, { col: nc, row: nr })
        if (wIdx >= 0 && walls[wIdx] === WALL_NONE) openWalls.push(wIdx)
      }
      if (openWalls.length !== 1) continue  // not a terminal dead-end
      const idx = openWalls[0]
      if (staticMask[idx]) continue         // VIP room / safety zone boundary
      const d = corridorDepth(c, r)
      if (d < 1) continue  // impossible — kept for clarity
      candidates.push({ wallIdx: idx, depth: d })
    }
  }

  // Prefer deepest dead-ends (most meaningful branches), then cap.
  candidates.sort((a, b) => b.depth - a.depth)
  const toGate = candidates.slice(0, MAX_DEAD_END_DOORS)
  for (const { wallIdx } of toGate) {
    // 55 % wood door (breakable), 45 % metal door (indestructible).
    const doorType = Math.random() < 0.75 ? WALL_WOOD_DOOR : WALL_METAL_DOOR
    walls[wallIdx]  = doorType
    states[wallIdx] = STATE_SOLID
    const def = WALL_HP_DEFAULT[doorType] ?? 0
    hp[wallIdx]     = def
    maxHp[wallIdx]  = def
  }
}



// ── Per-line indestructible blocker enforcement ──────────────────────────────
// For every row and column of tiles in the play area, try to ensure at least
// `minPerLine` walls in that line are CONCRETE or METAL_WALL — i.e. truly
// indestructible. Without this, a player could end up able to walk a full
// 16-tile straight corridor along an edge or middle line.
//
// Critical guard: each speculative conversion is REVERTED if it disconnects
// any cell from the rest of the maze in the eventually-passable view (doors
// → OPEN, destructibles → DESTROYED). This stops the pass from accidentally
// walling off pockets behind a single load-bearing NONE wall. A line that
// has no safe conversion candidates finishes under `minPerLine` — the target
// is a soft goal, never an isolation hazard.
//
// Route walls are also skipped explicitly so the pre-carved escort route stays
// open regardless.
function enforceLineBlockers(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  blockedTiles: Set<number>, routeWalls: Set<number>,
  minPerLine: number
) {
  if (minPerLine <= 0) return
  const isBlocker = (idx: number) =>
    walls[idx] === WALL_CONCRETE || walls[idx] === WALL_METAL_WALL
  const isCandidate = (idx: number) =>
    !staticMask[idx] && !routeWalls.has(idx) &&
    !wallTouchesBlocked(idx, blockedTiles) &&
    (walls[idx] === WALL_HEDGE || walls[idx] === WALL_WOOD_FENCE)


  // Anchor for connectivity BFS — any reachable open cell works; pick the
  // first non-blocked tile in scan order.
  let anchor: Tile | null = null
  for (let r = 0; r < GRID_ROWS && !anchor; r++) {
    for (let c = 0; c < GRID_COLS && !anchor; c++) {
      if (!blockedTiles.has(r * GRID_COLS + c)) anchor = { col: c, row: r }
    }
  }
  if (!anchor) return
  const expectedReachable = GRID_ROWS * GRID_COLS - blockedTiles.size

  // Eventually-passable view of the current wall arrays. Doors → OPEN,
  // destructibles → DESTROYED. Anything CONCRETE / METAL_WALL stays solid.
  // Rebuilt per check because the underlying walls array mutates.
  const buildPassable = (): number[] => {
    const out = states.slice()
    for (let i = 0; i < WALL_COUNT; i++) {
      const t = walls[i]
      if (t === WALL_METAL_DOOR || t === WALL_WOOD_DOOR) out[i] = STATE_OPEN
      else if (t === WALL_HEDGE || t === WALL_WOOD_FENCE) out[i] = STATE_DESTROYED
    }
    return out
  }
  // Returns true if walling `walls[]` as-is would isolate a cell from the
  // anchor. Used after each speculative conversion to decide revert / keep.
  const isolatesAnyCell = (): boolean => {
    const passable = buildPassable()
    const reached = reachableTiles(anchor!, walls, passable)
    let count = 0
    for (const k of reached) if (!blockedTiles.has(k)) count++
    return count < expectedReachable
  }

  const enforce = (lineIdxs: number[]) => {
    let blockers = 0
    for (const i of lineIdxs) if (isBlocker(i)) blockers++
    if (blockers >= minPerLine) return
    const candidates = lineIdxs.filter(isCandidate)
    shuffle(candidates)
    while (blockers < minPerLine && candidates.length > 0) {
      const idx = candidates.pop()!
      // Snapshot for potential revert.
      const prevType  = walls[idx]
      const prevState = states[idx]
      const prevHp    = hp[idx]
      const prevMaxHp = maxHp[idx]
      walls[idx]  = WALL_CONCRETE
      states[idx] = STATE_SOLID
      hp[idx]     = 0
      maxHp[idx]  = 0
      if (isolatesAnyCell()) {
        // Critical bridge — revert and try another candidate.
        walls[idx]  = prevType
        states[idx] = prevState
        hp[idx]     = prevHp
        maxHp[idx]  = prevMaxHp
      } else {
        blockers++
      }
    }
  }

  // ROWS — V-walls between cells in the same row separate cells horizontally.
  for (let r = 0; r < GRID_ROWS; r++) {
    const lineIdxs: number[] = []
    for (let c = 0; c < GRID_COLS - 1; c++) lineIdxs.push(vWallIndex(r, c))
    enforce(lineIdxs)
  }
  // COLUMNS — H-walls between cells in the same column separate cells vertically.
  for (let c = 0; c < GRID_COLS; c++) {
    const lineIdxs: number[] = []
    for (let r = 0; r < GRID_ROWS - 1; r++) lineIdxs.push(hWallIndex(r, c))
    enforce(lineIdxs)
  }
}

// ── VIP-room walls + safety-zone openings ────────────────────────────────────

function placeVipRoomWalls(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  vipRoom: { colMin: number; colMax: number; rowMin: number; rowMax: number },
  doorSide: RegionSide
): number[] {
  // Interior open + interior walls static.
  for (let r = vipRoom.rowMin; r <= vipRoom.rowMax; r++) {
    for (let c = vipRoom.colMin; c <= vipRoom.colMax; c++) {
      if (r < vipRoom.rowMax) {
        const i = hWallIndex(r, c)
        walls[i] = WALL_NONE; states[i] = STATE_SOLID; hp[i] = 0; maxHp[i] = 0
        staticMask[i] = true
      }
      if (c < vipRoom.colMax) {
        const i = vWallIndex(r, c)
        walls[i] = WALL_NONE; states[i] = STATE_SOLID; hp[i] = 0; maxHp[i] = 0
        staticMask[i] = true
      }
    }
  }

  // Perimeter — concrete wall around the VIP room, except for one METAL_DOOR
  // entry on `doorSide`. Skip arena-boundary edges (no internal wall there).
  const N: number[] = [], S: number[] = [], E: number[] = [], W: number[] = []
  if (vipRoom.rowMin > 0)
    for (let c = vipRoom.colMin; c <= vipRoom.colMax; c++) N.push(hWallIndex(vipRoom.rowMin - 1, c))
  if (vipRoom.rowMax < GRID_ROWS - 1)
    for (let c = vipRoom.colMin; c <= vipRoom.colMax; c++) S.push(hWallIndex(vipRoom.rowMax, c))
  if (vipRoom.colMin > 0)
    for (let r = vipRoom.rowMin; r <= vipRoom.rowMax; r++) W.push(vWallIndex(r, vipRoom.colMin - 1))
  if (vipRoom.colMax < GRID_COLS - 1)
    for (let r = vipRoom.rowMin; r <= vipRoom.rowMax; r++) E.push(vWallIndex(r, vipRoom.colMax))

  for (const i of [...N, ...S, ...E, ...W]) {
    walls[i] = WALL_CONCRETE; states[i] = STATE_SOLID; hp[i] = 0; maxHp[i] = 0
    staticMask[i] = true
  }

  // Place one metal door on EVERY available perimeter side (typically 3 —
  // the side opposite the arena edge plus the two perpendicular sides). Each
  // door anchors a distinct escort route from VIP to the safety zone.
  const sidesByName: Record<RegionSide, number[]> = { N, S, E, W }
  const placeDoorOnSide = (side: RegionSide): number => {
    const pool = sidesByName[side]
    if (pool.length === 0) return -1
    const idx = pool[(Math.random() * pool.length) | 0]
    walls[idx]  = WALL_METAL_DOOR
    states[idx] = STATE_SOLID
    hp[idx]     = 0
    maxHp[idx]  = 0
    staticMask[idx] = true
    return idx
  }

  const doors: number[] = []
  const primary = placeDoorOnSide(doorSide)
  if (primary >= 0) doors.push(primary)

  for (const s of (['N', 'S', 'E', 'W'] as RegionSide[])) {
    if (s === doorSide) continue
    if (sidesByName[s].length === 0) continue
    const idx = placeDoorOnSide(s)
    if (idx >= 0) doors.push(idx)
  }
  return doors
}

// Safety zone is a 2×2 enclosed room — interior open, perimeter concrete with
// one entry per accessible side (like the VIP room but without locking doors).
function placeSafetyZoneOpenings(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  safety: { colMin: number; colMax: number; rowMin: number; rowMax: number }
) {
  // ── Interior walls: open so the 2×2 zone is a single walkable room ──────────
  for (let r = safety.rowMin; r <= safety.rowMax; r++) {
    for (let c = safety.colMin; c <= safety.colMax; c++) {
      if (r < safety.rowMax) {
        const i = hWallIndex(r, c)
        walls[i] = WALL_NONE; states[i] = STATE_SOLID; hp[i] = 0; maxHp[i] = 0
        staticMask[i] = true
      }
      if (c < safety.colMax) {
        const i = vWallIndex(r, c)
        walls[i] = WALL_NONE; states[i] = STATE_SOLID; hp[i] = 0; maxHp[i] = 0
        staticMask[i] = true
      }
    }
  }

  // ── Perimeter: concrete walls (like VIP room) to block line-of-sight ────────
  // Keeps the zone from looking like a wide-open clearing visible from the
  // middle of the maze. Exactly ONE wall per accessible side is left open so
  // the VIP and players can enter. All walls are static (DFS / routes won't
  // touch them).
  const N: number[] = [], S: number[] = [], E: number[] = [], W: number[] = []
  if (safety.rowMin > 0)
    for (let c = safety.colMin; c <= safety.colMax; c++) N.push(hWallIndex(safety.rowMin - 1, c))
  if (safety.rowMax < GRID_ROWS - 1)
    for (let c = safety.colMin; c <= safety.colMax; c++) S.push(hWallIndex(safety.rowMax, c))
  if (safety.colMin > 0)
    for (let r = safety.rowMin; r <= safety.rowMax; r++) W.push(vWallIndex(r, safety.colMin - 1))
  if (safety.colMax < GRID_COLS - 1)
    for (let r = safety.rowMin; r <= safety.rowMax; r++) E.push(vWallIndex(r, safety.colMax))

  // Close everything first with concrete + static.
  for (const i of [...N, ...S, ...E, ...W]) {
    walls[i] = WALL_CONCRETE; states[i] = STATE_SOLID; hp[i] = 0; maxHp[i] = 0
    staticMask[i] = true
  }

  // Re-open the LAST wall on each non-empty side (furthest from any corner
  // this zone shares with the arena edge) so the entry faces the interior maze.
  // For a 2-wall side the entry is wall[1]; for a 1-wall side it's wall[0].
  for (const group of [N, S, E, W]) {
    if (group.length === 0) continue
    const entry = group[group.length - 1]   // last = furthest from boundary
    walls[entry] = WALL_NONE
    states[entry] = STATE_SOLID
    // staticMask stays true — entry is permanently open, maze won't modify it
  }
}



// ── Connectivity stitch ──────────────────────────────────────────────────────
// After DFS carving some cells may form disconnected islands — the DFS seed
// loop starts an independent sub-tree from every unvisited non-route cell,
// which can create pockets that the route-seeded DFS never reached. Players
// spawning in such pockets can never escape. This pass fixes that.
//
// Algorithm:
//   1. BFS-flood the maze from an anchor using only WALL_NONE passages.
//   2. For every non-blocked tile that the flood didn't reach, scan its
//      neighbours for a reachable one and open the wall between them.
//   3. Flood-fill from the newly connected tile (picking up any already-open
//      neighbours in that island), then repeat until nothing is unreachable.
//
// The stitch opens at most one wall per isolated tile — just enough to join
// it to the main component. Dead-ends remain dead-ends; they just become
// reachable. The pass is purely structural: it runs before braidMaze and
// enforceLineBlockers so both of those see a fully-connected grid and their
// isolation checks work correctly.
function stitchDisconnectedTiles(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  blockedTiles: Set<number>
): void {
  const DIRS: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]]

  // Anchor: first non-blocked tile in scan order.
  let anchor: Tile | null = null
  anchorSearch: for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!blockedTiles.has(r * GRID_COLS + c)) { anchor = { col: c, row: r }; break anchorSearch }
    }
  }
  if (!anchor) return

  // BFS using only truly-open (WALL_NONE) passages. Doors and destructibles
  // still count as barriers here — structural connectivity only.
  const reachable = new Set<number>()

  const floodFrom = (start: Tile): void => {
    const q: Tile[] = [start]
    reachable.add(start.row * GRID_COLS + start.col)
    while (q.length > 0) {
      const cur = q.shift()!
      for (const [dc, dr] of DIRS) {
        const nc = cur.col + dc, nr = cur.row + dr
        if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue
        const nk = nr * GRID_COLS + nc
        if (reachable.has(nk) || blockedTiles.has(nk)) continue
        const wIdx = wallIdxBetween(cur, { col: nc, row: nr })
        if (wIdx < 0 || walls[wIdx] !== WALL_NONE) continue
        reachable.add(nk)
        q.push({ col: nc, row: nr })
      }
    }
  }

  floodFrom(anchor)

  // Stitch loop: one pass per iteration, repeating until stable.
  let changed = true
  while (changed) {
    changed = false
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const k = r * GRID_COLS + c
        if (blockedTiles.has(k) || reachable.has(k)) continue
        // Find a reachable neighbour to bridge to.
        for (const [dc, dr] of DIRS) {
          const nc = c + dc, nr2 = r + dr
          if (nc < 0 || nc >= GRID_COLS || nr2 < 0 || nr2 >= GRID_ROWS) continue
          const nk = nr2 * GRID_COLS + nc
          if (!reachable.has(nk)) continue
          const wIdx = wallIdxBetween({ col: c, row: r }, { col: nc, row: nr2 })
          if (wIdx < 0 || staticMask[wIdx]) continue
          // Open the bridging wall.
          walls[wIdx]  = WALL_NONE
          states[wIdx] = STATE_SOLID
          hp[wIdx]     = 0
          maxHp[wIdx]  = 0
          // Flood-fill from the newly connected tile to catch any other
          // open passages already inside this isolated island.
          floodFrom({ col: c, row: r })
          changed = true
          break
        }
      }
    }
  }
}

// ── No-sealed-tile guard ─────────────────────────────────────────────────────
// Any tile whose 4 surrounding walls are all indestructible (concrete /
// metal wall / metal door — i.e. walls the player can't break or open) would
// trap a player who spawns there or gets pushed into it. After material
// variation + corridor obstacles, this pass scans every non-blocked tile and
// converts one of its concrete/metal walls to a destructible (HEDGE or
// WOOD_FENCE) so the player can always break out somewhere.

function isPassableEventually(type: number): boolean {
  // NONE = open, doors = openable, hedge/wood fence = destructible.
  return type === WALL_NONE
      || type === WALL_HEDGE
      || type === WALL_WOOD_FENCE
      || type === WALL_WOOD_DOOR
      || type === WALL_METAL_DOOR
}

function ensureNoSealedTiles(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  blockedTiles: Set<number>
) {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (blockedTiles.has(r * GRID_COLS + c)) continue

      // Collect this tile's 4 surrounding wall indices.
      const adj: number[] = []
      for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as Array<[number, number]>) {
        const nc = c + dc, nr = r + dr
        if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue
        const wIdx = wallIdxBetween({ col: c, row: r }, { col: nc, row: nr })
        if (wIdx >= 0) adj.push(wIdx)
      }

      // If at least one is ever-passable, the player can always escape.
      if (adj.some(i => isPassableEventually(walls[i]))) continue

      // All-indestructible — convert one concrete/metal wall to a destructible.
      // Prefer non-static walls; skip arena boundary walls (none in adj already).
      const candidates = adj.filter(i => !staticMask[i] &&
        (walls[i] === WALL_CONCRETE || walls[i] === WALL_METAL_WALL))
      if (candidates.length === 0) continue
      const idx = candidates[(Math.random() * candidates.length) | 0]
      const newType = Math.random() < 0.5 ? WALL_HEDGE : WALL_WOOD_FENCE
      walls[idx]  = newType
      states[idx] = STATE_SOLID
      const def = WALL_HP_DEFAULT[newType] ?? 0
      hp[idx]     = def
      maxHp[idx]  = def
    }
  }
}

// ── Winnable-path guard ──────────────────────────────────────────────────────
// At minimum, VIP must be able to reach the safety zone — treating doors as
// open and destructibles as eventually-passable. If the random material
// distribution produced an unwinnable layout (e.g. concrete walls fully
// blocking a corridor), we open scatter walls one by one until a path exists.

function ensureWinnablePath(
  walls: number[], states: number[], hp: number[], maxHp: number[], staticMask: boolean[],
  vipSpawn: Tile, safetyAnchor: Tile
) {
  const passableStates = states.slice()
  for (let i = 0; i < WALL_COUNT; i++) {
    const t = walls[i]
    if (t === WALL_METAL_DOOR || t === WALL_WOOD_DOOR) passableStates[i] = STATE_OPEN
    else if (t === WALL_HEDGE || t === WALL_WOOD_FENCE) passableStates[i] = STATE_DESTROYED
  }
  if (findPath(vipSpawn, safetyAnchor, walls, passableStates).length > 0) return

  // No path even with all destructibles broken → open random concrete/metal walls.
  const candidates: number[] = []
  for (let i = 0; i < WALL_COUNT; i++) {
    if (staticMask[i]) continue
    if (walls[i] === WALL_CONCRETE || walls[i] === WALL_METAL_WALL) candidates.push(i)
  }
  shuffle(candidates)
  for (const i of candidates) {
    walls[i] = WALL_NONE; states[i] = STATE_SOLID; hp[i] = 0; maxHp[i] = 0
    passableStates[i] = STATE_SOLID
    if (findPath(vipSpawn, safetyAnchor, walls, passableStates).length > 0) return
  }
}

// ── Public factory ───────────────────────────────────────────────────────────

export function generateRandomMaze(opts: MazeOptions = MAZE_OPTIONS): MazeConfig {
  const wallTypes  = new Array<number>(WALL_COUNT).fill(WALL_NONE)
  const wallStates = new Array<number>(WALL_COUNT).fill(STATE_SOLID)
  const wallHP     = new Array<number>(WALL_COUNT).fill(0)
  const wallMaxHP  = new Array<number>(WALL_COUNT).fill(0)
  const staticMask = new Array<boolean>(WALL_COUNT).fill(false)
  // Carve uses "straightBias" — the inverse framing of the user-facing
  // windingness knob (0 windingness = totally straight, 1 = max twisty).
  const straightBias = 1 - Math.max(0, Math.min(1, opts.windingness))

  // Random VIP / safety placement along randomly-chosen opposite edges.
  const placement = placeVipAndSafetyRandom()

  // Place VIP room walls (perimeter + door) + open safety zone interior.
  const vipDoors = placeVipRoomWalls(
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    placement.vipRoom, placement.vipRoomDoor.side
  )
  placeSafetyZoneOpenings(
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    placement.safetyZone
  )

  // Tile sets for "blocked from carving" and for the spawn-pool exclusion.
  const blockedTiles = new Set<number>()
  const vipRoomTiles: Tile[] = []
  for (let r = placement.vipRoom.rowMin; r <= placement.vipRoom.rowMax; r++) {
    for (let c = placement.vipRoom.colMin; c <= placement.vipRoom.colMax; c++) {
      blockedTiles.add(r * GRID_COLS + c)
      vipRoomTiles.push({ col: c, row: r })
    }
  }
  const safetyTiles: Tile[] = []
  for (let r = placement.safetyZone.rowMin; r <= placement.safetyZone.rowMax; r++) {
    for (let c = placement.safetyZone.colMin; c <= placement.safetyZone.colMax; c++) {
      blockedTiles.add(r * GRID_COLS + c)
      safetyTiles.push({ col: c, row: r })
    }
  }

  // 1. Pre-carve one winding escort route — one VIP-room door is paired with
  //    a mid-maze lateral waypoint, then linked to the safety zone. Single
  //    route minimises the open-corridor footprint so the safety zone area
  //    stays dense; the DFS fills the rest organically around it.
  // 2. DFS-carve the rest of the parcel, extending OUTWARD from the route
  //    cells so the surrounding maze stays connected to the escort network.
  // 2. DFS-carve the rest of the parcel, extending OUTWARD from the route
  //    cells so the surrounding maze stays connected to the escort network.
  const routes = plotEscortRoutes(
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    vipDoors, placement.vipRoom, safetyTiles[0], blockedTiles,
    opts.routeCount, opts.branchCount,
  )
  carveMaze(
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    blockedTiles, straightBias,
    routes.routeWalls, routes.routeCells
  )
  // ── Pipeline: carve → stitch → braid → paint walls → gate dead-ends → obstacles
  // 1. Stitch isolated islands (DFS sub-trees не підключені до маршруту)
  stitchDisconnectedTiles(wallTypes, wallStates, wallHP, wallMaxHP, staticMask, blockedTiles)
  // 2. Braid: відкрити декілька зайвих стін як петлі
  braidMaze(wallTypes, staticMask, blockedTiles, opts.braidProb)
  // 3. Vary: перефарбувати структурні стіни (CONCRETE → materialBias types)
  varyMaterials(wallTypes, wallStates, wallHP, wallMaxHP, staticMask, opts.materialBias)
  // 4. Dead-end doors: ставимо двері на вхід у кожен тупик (section_size = 1)
  placeDeadEndDoors(wallTypes, wallStates, wallHP, wallMaxHP, staticMask, blockedTiles)
  // 5. Partition doors: ставимо двері лише на стіни-мости (section_size >= 3),
  //    тобто там де закриття стіни реально відсікає частину лабіринту.
  placePartitionDoors(
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    blockedTiles,
    opts.obstaclesMin, opts.obstaclesMax,
    opts.corridorObstacleBias,
  )

  // Per-line indestructible blocker enforcement: each row/col of tiles must
  // have at least minBlockersPerLine concrete/metal walls, so no straight
  // edge corridor of full grid length can exist.
  enforceLineBlockers(
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    blockedTiles, routes.routeWalls,
    opts.minBlockersPerLine,
  )

  // Anti-trap pass: if any tile ended up surrounded by indestructible walls
  // (concrete / iron / metal door — nothing the player can break or open),
  // convert one of those walls to a destructible so the player can always
  // bash their way out.
  ensureNoSealedTiles(wallTypes, wallStates, wallHP, wallMaxHP, staticMask, blockedTiles)

  // Make sure the match is actually winnable (treating doors as open and
  // destructibles as eventually-passable).
  ensureWinnablePath(
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    placement.vipSpawn, safetyTiles[0]
  )

  // Freeze the layout — every wall is now static for the whole match.
  for (let i = 0; i < WALL_COUNT; i++) staticMask[i] = true

  // Spawn pool: every tile NOT inside the VIP room or safety zone.
  const spawnPool: Tile[] = []
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const k = r * GRID_COLS + c
      if (blockedTiles.has(k)) continue
      spawnPool.push({ col: c, row: r })
    }
  }

  return {
    templateId:   `random-${placement.vipSide}`,
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    vipSpawn:     placement.vipSpawn,
    vipRoomTiles,
    vipRoomDoors: vipDoors,
    safetyTiles,
    spawnPool,
  }
}

// ── Empty-arena mode (for testing) ───────────────────────────────────────────
// Produces a MazeConfig with NO maze walls at all — only the VIP spawn room
// (concrete perimeter + locked metal doors) and the open safety zone remain.
// Player spawn pool covers every tile outside those two regions, so items and
// players have the full 16×16 open field. Toggle via EMPTY_ARENA_MODE in
// constants.ts.
export function generateEmptyArena(): MazeConfig {
  const wallTypes  = new Array<number> (WALL_COUNT).fill(WALL_NONE)
  const wallStates = new Array<number> (WALL_COUNT).fill(STATE_SOLID)
  const wallHP     = new Array<number> (WALL_COUNT).fill(0)
  const wallMaxHP  = new Array<number> (WALL_COUNT).fill(0)
  const staticMask = new Array<boolean>(WALL_COUNT).fill(false)

  const placement = placeVipAndSafetyRandom()

  // Build VIP room perimeter (concrete + metal doors) and open safety zone.
  const vipDoors = placeVipRoomWalls(
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    placement.vipRoom, placement.vipRoomDoor.side
  )
  placeSafetyZoneOpenings(
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    placement.safetyZone
  )

  // ── Demo wall row ─────────────────────────────────────────────────────────
  // One of each wall type placed as a north-south V-wall in the centre of
  // the arena. Columns 4-9 at row 7 are guaranteed to never overlap the
  // VIP room or safety zone (both are always hugged against an arena edge,
  // occupying rows 0-2 or 13-15 and cols 0-2 or 13-15).
  //
  //  col  wall type      HP
  //   4   Concrete        0  (indestructible solid)
  //   5   Hedge         100  (bomb-only at first, then baton, then hand)
  //   6   Metal wall      0  (indestructible transparent)
  //   7   Wood fence     50  (any source, always)
  //   8   Metal door      0  (openable, indestructible)
  //   9   Wood door      80  (openable, destructible)
  const DEMO_ROW   = 7
  const demoWalls: Array<{ col: number; type: number }> = [
    { col: 4, type: WALL_CONCRETE   },
    { col: 5, type: WALL_HEDGE      },
    { col: 6, type: WALL_METAL_WALL },
    { col: 7, type: WALL_WOOD_FENCE },
    { col: 8, type: WALL_METAL_DOOR },
    { col: 9, type: WALL_WOOD_DOOR  },
  ]
  for (const { col, type } of demoWalls) {
    const idx     = vWallIndex(DEMO_ROW, col)
    const hp      = WALL_HP_DEFAULT[type] ?? 0
    wallTypes[idx]  = type
    wallStates[idx] = STATE_SOLID
    wallHP[idx]     = hp
    wallMaxHP[idx]  = hp
    // staticMask will be set to true for the whole array in the freeze below
  }

  // Freeze layout — nothing changes mid-match.
  for (let i = 0; i < WALL_COUNT; i++) staticMask[i] = true

  // Tile catalogues (mirrors generateRandomMaze logic).
  const blockedTiles = new Set<number>()
  const vipRoomTiles: Tile[] = []
  for (let r = placement.vipRoom.rowMin; r <= placement.vipRoom.rowMax; r++) {
    for (let c = placement.vipRoom.colMin; c <= placement.vipRoom.colMax; c++) {
      blockedTiles.add(r * GRID_COLS + c)
      vipRoomTiles.push({ col: c, row: r })
    }
  }
  const safetyTiles: Tile[] = []
  for (let r = placement.safetyZone.rowMin; r <= placement.safetyZone.rowMax; r++) {
    for (let c = placement.safetyZone.colMin; c <= placement.safetyZone.colMax; c++) {
      blockedTiles.add(r * GRID_COLS + c)
      safetyTiles.push({ col: c, row: r })
    }
  }
  const spawnPool: Tile[] = []
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!blockedTiles.has(r * GRID_COLS + c)) spawnPool.push({ col: c, row: r })
    }
  }

  return {
    templateId:   `empty-${placement.vipSide}`,
    wallTypes, wallStates, wallHP, wallMaxHP, staticMask,
    vipSpawn:     placement.vipSpawn,
    vipRoomTiles,
    vipRoomDoors: vipDoors,
    safetyTiles,
    spawnPool,
  }
}
