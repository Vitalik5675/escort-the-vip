import {
  GRID_COLS, GRID_ROWS,
  hWallIndex, vWallIndex,
  WALL_NONE, WALL_WOOD_DOOR, WALL_WOOD_WALL, WALL_HEDGE,
  STATE_OPEN, STATE_DESTROYED
} from './constants'

export interface Tile { col: number; row: number }

// ── Wall passability ──────────────────────────────────────────────────────────
// Doors: open / destroyed → passable. STATE_BLOCKED is treated as solid (the
// door physically can't move because a hostile player stands on the far side).
// Destructible solids (wood wall, hedge): passable only after destruction.
// Indestructible solids (concrete): never passable.
//
// Note: WALL_HEDGE is destructible (HP=100, susceptible to bombs and — at HP
// thresholds — baton/everything). It stays solid in the pathfinder until its
// state flips to STATE_DESTROYED.

export function isPassable(type: number, state: number): boolean {
  if (type === WALL_NONE) return true
  if (type === WALL_WOOD_DOOR) {
    return state === STATE_OPEN || state === STATE_DESTROYED
  }
  if (type === WALL_WOOD_WALL || type === WALL_HEDGE) {
    return state === STATE_DESTROYED
  }
  return false  // concrete — always solid
}

// Wall index between two cardinal-adjacent tiles. Returns -1 if not adjacent.
// Shared utility — MazeGenerator and GameRoom both need this.
export function wallIdxBetween(a: Tile, b: Tile): number {
  if (a.col === b.col) {
    if (a.row + 1 === b.row) return hWallIndex(a.row, a.col)
    if (b.row + 1 === a.row) return hWallIndex(b.row, a.col)
  }
  if (a.row === b.row) {
    if (a.col + 1 === b.col) return vWallIndex(a.row, a.col)
    if (b.col + 1 === a.col) return vWallIndex(a.row, b.col)
  }
  return -1
}

export function canMoveBetween(
  fromCol: number, fromRow: number,
  toCol:   number, toRow:   number,
  wallTypes: number[], wallStates: number[]
): boolean {
  const dc = toCol - fromCol
  const dr = toRow - fromRow
  if (Math.abs(dc) + Math.abs(dr) !== 1) return false

  let idx: number
  if (dr === 1)       idx = hWallIndex(fromRow, fromCol)
  else if (dr === -1) idx = hWallIndex(toRow,   fromCol)
  else if (dc === 1)  idx = vWallIndex(fromRow, fromCol)
  else                idx = vWallIndex(fromRow, toCol)

  return isPassable(wallTypes[idx], wallStates[idx])
}

// ── A* pathfinder ─────────────────────────────────────────────────────────────

interface Node {
  col: number; row: number
  g: number; h: number; f: number
  parent: Node | null
}

function heuristic(a: Tile, b: Tile): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row)
}

export function findPath(
  start: Tile, goal: Tile,
  wallTypes: number[], wallStates: number[],
  blockedTiles?: Set<number>   // extra impassable tiles (e.g. hater positions)
): Tile[] {
  const key = (c: number, r: number) => r * GRID_COLS + c
  const goalKey = key(goal.col, goal.row)   // goal tile is never treated as blocked
  const open = new Map<number, Node>()
  const closed = new Set<number>()

  const startNode: Node = { ...start, g: 0, h: heuristic(start, goal), f: heuristic(start, goal), parent: null }
  open.set(key(start.col, start.row), startNode)

  const DIRS: Tile[] = [
    { col:  0, row:  1 },
    { col:  0, row: -1 },
    { col:  1, row:  0 },
    { col: -1, row:  0 },
  ]

  while (open.size > 0) {
    // Pick node with lowest f
    let current: Node | null = null
    for (const node of open.values()) {
      if (current === null || node.f < current.f) current = node
    }
    if (!current) break

    if (current.col === goal.col && current.row === goal.row) {
      // Reconstruct path
      const path: Tile[] = []
      let n: Node | null = current
      while (n) { path.unshift({ col: n.col, row: n.row }); n = n.parent }
      return path
    }

    open.delete(key(current.col, current.row))
    closed.add(key(current.col, current.row))

    for (const d of DIRS) {
      const nc = current.col + d.col
      const nr = current.row + d.row
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue
      const nk = key(nc, nr)
      if (closed.has(nk)) continue
      if (!canMoveBetween(current.col, current.row, nc, nr, wallTypes, wallStates)) continue
      if (blockedTiles && nk !== goalKey && blockedTiles.has(nk)) continue

      const g = current.g + 1
      const h = heuristic({ col: nc, row: nr }, goal)
      const existing = open.get(nk)
      if (!existing || g < existing.g) {
        open.set(nk, { col: nc, row: nr, g, h, f: g + h, parent: current })
      }
    }
  }

  return []  // no path found
}

// ── Connectivity check ────────────────────────────────────────────────────────

/** True if `from` can reach `to` at all (BFS). */
export function isConnected(
  from: Tile, to: Tile,
  wallTypes: number[], wallStates: number[]
): boolean {
  return findPath(from, to, wallTypes, wallStates).length > 0
}

/** Find all tiles reachable from `start`. */
export function reachableTiles(
  start: Tile,
  wallTypes: number[], wallStates: number[]
): Set<number> {
  const key = (t: Tile) => t.row * GRID_COLS + t.col
  const visited = new Set<number>([key(start)])
  const queue: Tile[] = [start]
  const DIRS: Tile[] = [{ col: 0, row: 1 }, { col: 0, row: -1 }, { col: 1, row: 0 }, { col: -1, row: 0 }]

  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const d of DIRS) {
      const nc = cur.col + d.col, nr = cur.row + d.row
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue
      const nk = nr * GRID_COLS + nc
      if (visited.has(nk)) continue
      if (!canMoveBetween(cur.col, cur.row, nc, nr, wallTypes, wallStates)) continue
      visited.add(nk)
      queue.push({ col: nc, row: nr })
    }
  }

  return visited
}
