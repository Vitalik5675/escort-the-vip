// Adjacency helpers used to gate click handlers on game-zone entities.
//
// Two flavours:
//   isLocalNearTile     — cardinal only (dx+dy ≤ 1). Used for wall/door
//                         interactions and bodyguard-VIP escort range.
//   isLocalNearTileDiag — Chebyshev ≤ 1 (max(dx,dy) ≤ 1). Includes all 8
//                         neighbours. Used for attack range — you can swing
//                         at a diagonal enemy even though the maze grid only
//                         allows cardinal movement. The CL_PHYSICS pushback
//                         box remains on the enemy's tile (blocks cardinal
//                         entry), so diagonal attacks don't bypass the physics.

import { getLocalState } from '../state/localState'
import { wallSidesTiles } from '../game/constants'

/** True if local player is on the given tile or one cardinal step away. */
export function isLocalNearTile(col: number, row: number): boolean {
  const s = getLocalState()
  if (s.zone !== 'game') return false
  const dx = Math.abs((s.myTileCol | 0) - (col | 0))
  const dy = Math.abs((s.myTileRow | 0) - (row | 0))
  return dx + dy <= 1
}

/**
 * True if local player is on the given tile or any of the 8 surrounding
 * tiles (diagonal neighbours included — Chebyshev distance ≤ 1).
 * Use this for ATTACK range checks so players can hit diagonal enemies.
 * Physics pushback (CL_PHYSICS box on enemy tiles) still only blocks
 * cardinal movement — diagonal attacks don't require entering the tile.
 */
export function isLocalNearTileDiag(col: number, row: number): boolean {
  const s = getLocalState()
  if (s.zone !== 'game') return false
  const dx = Math.abs((s.myTileCol | 0) - (col | 0))
  const dy = Math.abs((s.myTileRow | 0) - (row | 0))
  return Math.max(dx, dy) <= 1
}

/** True if local player stands EXACTLY on the given tile. */
export function isLocalOnTile(col: number, row: number): boolean {
  const s = getLocalState()
  if (s.zone !== 'game') return false
  return (s.myTileCol | 0) === (col | 0) && (s.myTileRow | 0) === (row | 0)
}

/** True if local player stands on either of the two tiles flanking `wallIdx`. */
export function isLocalAdjacentToWall(wallIdx: number): boolean {
  const s = getLocalState()
  if (s.zone !== 'game') return false
  const sides = wallSidesTiles(wallIdx)
  const c = s.myTileCol | 0, r = s.myTileRow | 0
  return (c === sides.a.col && r === sides.a.row) ||
         (c === sides.b.col && r === sides.b.row)
}
