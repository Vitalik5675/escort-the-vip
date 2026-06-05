import { GRID_COLS } from './constants'
import { findPath, canMoveBetween } from './Pathfinder'
import { PlayerState, VIPState } from '../rooms/state/GameState'
import { MapSchema } from '@colyseus/schema'

// ── Hater-blocked tiles ───────────────────────────────────────────────────────
// Returns the set of tile keys occupied by alive haters in the game zone.
// An optional excludeKey (e.g. the goal tile) is never added to the set so the
// pathfinder is always able to reach its target even if a hater stands there.

function haterBlockedTiles(players: MapSchema<PlayerState>, excludeKey?: number): Set<number> {
  const blocked = new Set<number>()
  for (const p of players.values()) {
    if (p.team !== 'hater' || p.zone !== 'game' || !p.isAlive) continue
    const k = p.tileRow * GRID_COLS + p.tileCol
    if (k !== excludeKey) blocked.add(k)
  }
  return blocked
}

// ── Target selection (by real path distance, not Manhattan) ───────────────────
// Called periodically by GameRoom to pick the closest reachable bodyguard.

export function findBestBodyguard(
  vip: VIPState,
  players: MapSchema<PlayerState>,
  wallTypes: number[], wallStates: number[]
): { sessionId: string; displayName: string } {
  let bestId   = ''
  let bestName = ''
  let bestDist = Infinity

  for (const [sid, p] of players.entries()) {
    if (p.team !== 'bodyguard' || p.zone !== 'game' || !p.isAlive) continue
    const goalKey = p.tileRow * GRID_COLS + p.tileCol
    const blocked = haterBlockedTiles(players, goalKey)
    const path = findPath(
      { col: vip.tileCol, row: vip.tileRow },
      { col: p.tileCol,   row: p.tileRow   },
      wallTypes, wallStates,
      blocked
    )
    // path.length === 1 means same tile; 0 means unreachable
    const dist = path.length > 1 ? path.length - 1 : (path.length === 1 ? 0 : Infinity)
    if (dist < bestDist) {
      bestDist = dist
      bestId   = sid
      bestName = p.displayName || sid.slice(0, 6)
    }
  }

  return { sessionId: bestId, displayName: bestName }
}

// ── One NPC move step ─────────────────────────────────────────────────────────
// Moves VIP one tile toward the explicitly specified target bodyguard.
// Stops when already adjacent (Manhattan distance ≤ 1) to preserve the 1-tile gap.

export function npcStep(
  vip: VIPState,
  players: MapSchema<PlayerState>,
  wallTypes: number[], wallStates: number[],
  targetId: string
): { moved: boolean; col: number; row: number } {
  if (!vip.active) return { moved: false, col: vip.tileCol, row: vip.tileRow }

  const target = targetId ? players.get(targetId) : null
  if (!target || !target.isAlive || target.zone !== 'game') {
    return { moved: false, col: vip.tileCol, row: vip.tileRow }
  }

  // Stop only when same tile or when adjacent AND the direct passage is open.
  // If there's a wall between VIP and the adjacent bodyguard, keep pathfinding
  // to find an open side — otherwise VIP gets stuck on the wrong side of a wall.
  const manhDist = Math.abs(target.tileCol - vip.tileCol) + Math.abs(target.tileRow - vip.tileRow)
  if (manhDist === 0) return { moved: false, col: vip.tileCol, row: vip.tileRow }
  if (manhDist === 1 && canMoveBetween(vip.tileCol, vip.tileRow, target.tileCol, target.tileRow, wallTypes, wallStates)) {
    return { moved: false, col: vip.tileCol, row: vip.tileRow }
  }

  const targetKey = target.tileRow * GRID_COLS + target.tileCol
  const blocked   = haterBlockedTiles(players, targetKey)
  const path = findPath(
    { col: vip.tileCol, row: vip.tileRow },
    { col: target.tileCol, row: target.tileRow },
    wallTypes, wallStates,
    blocked
  )
  if (path.length < 2) return { moved: false, col: vip.tileCol, row: vip.tileRow }

  const next = path[1]
  // Safety guard: never step onto the target's exact tile
  if (next.col === target.tileCol && next.row === target.tileRow) {
    return { moved: false, col: vip.tileCol, row: vip.tileRow }
  }

  return { moved: true, col: next.col, row: next.row }
}
