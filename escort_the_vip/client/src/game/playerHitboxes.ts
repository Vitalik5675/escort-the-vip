import { engine, Entity, Transform, ColliderLayer, MaterialTransparencyMode, PlayerIdentityData } from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { createEntity, makeClickable, removeEntity } from '../utils/entityFactory'
import { sendToRoom } from '../colyseus-client'
import { getLocalState } from '../state/localState'
import { isLocalNearTileDiag } from '../utils/adjacency'
import { GAME_FLOOR_Y, tileToWorldX, tileToWorldZ } from './constants'

// Per-enemy presence is split into two invisible colliders:
//
//   physicsBox  — full-tile (2 × 3 × 2) box, CL_PHYSICS only.
//                 Snapped to the server-reported tile. Blocks the local
//                 player from walking ONTO an enemy tile (cardinal movement
//                 in the maze). Not clickable so its large footprint never
//                 steals raycasts from the click cylinder.
//
//                 Only created for ENEMY players (opposite team).
//                 Same-team players get no physics box — allies can share
//                 tiles freely, no collision or pushback between them.
//
//   clickBox    — Cylinder (radius ≈ 0.4 m, height 2.0 m), CL_POINTER only.
//                 Follows the real DCL avatar transform every frame.
//                 Cylinder shape gives a more accurate head-to-toe click target
//                 than a square box — no "fat corner" false positives.
//                 Attack is gated by isLocalNearTileDiag (Chebyshev ≤ 1) so
//                 players can attack from any of the 8 surrounding tiles,
//                 including diagonals. The physics pushback still only blocks
//                 cardinal entry via the physics box above.

const PHYSICS_W = 2.0
const PHYSICS_H = 3.0
// Cylinder scale: DCL unit cylinder has radius 0.5 and height 1.0.
// scale.x/z = 0.8 → radius = 0.4 m (fits inside the avatar silhouette).
// scale.y   = 2.0 → height 2.0 m (full standing height).
const CLICK_W   = 0.8
const CLICK_H   = 2.0

interface EnemyHitbox {
  physicsBox:   Entity
  clickBox:     Entity
  col:          number
  row:          number
  team:         string
  name:         string
  userId:       string
  avatarEntity: Entity | null   // resolved lazily; re-resolved if it disappears
}

const hitboxes = new Map<string, EnemyHitbox>()

function _findAvatarEntityByUserId(userId: string): Entity | null {
  if (!userId) return null
  for (const [entity, ident] of engine.getEntitiesWith(PlayerIdentityData)) {
    if ((ident as { address: string }).address === userId) return entity
  }
  return null
}

// Per-frame: keep the click cylinder pinned over the live DCL avatar.
// If the avatar entity isn't found (joined late, out of streaming range, etc.),
// fall back to the server tile centre so the click cylinder always exists.
engine.addSystem(() => {
  for (const hb of hitboxes.values()) {
    // Re-resolve cached avatar if it disappeared (reloaded / streamed out).
    if (hb.avatarEntity !== null && Transform.getOrNull(hb.avatarEntity) === null) {
      hb.avatarEntity = null
    }
    if (hb.avatarEntity === null && hb.userId) {
      hb.avatarEntity = _findAvatarEntityByUserId(hb.userId)
    }

    const ct = Transform.getMutableOrNull(hb.clickBox)
    if (!ct) continue

    const avatarT = hb.avatarEntity !== null ? Transform.getOrNull(hb.avatarEntity) : null
    if (avatarT) {
      ct.position.x = avatarT.position.x
      ct.position.y = avatarT.position.y + CLICK_H / 2
      ct.position.z = avatarT.position.z
    } else {
      ct.position.x = tileToWorldX(hb.col)
      ct.position.y = GAME_FLOOR_Y + CLICK_H / 2
      ct.position.z = tileToWorldZ(hb.row)
    }
  }
})

function _setPhysicsPos(hb: EnemyHitbox, col: number, row: number) {
  const wx = tileToWorldX(col)
  const wz = tileToWorldZ(row)
  const pt = Transform.getMutableOrNull(hb.physicsBox)
  if (pt) { pt.position.x = wx; pt.position.z = wz }
  hb.col = col
  hb.row = row
}

/** Create or update the physics + click hitboxes for a player.
 *
 * Team rules (CLIENT SIDE):
 *   • Same team as local player → no hitbox at all (allies walk freely).
 *   • Opposite team             → physicsBox (CL_PHYSICS, cardinal pushback)
 *                                 + clickBox cylinder (CL_POINTER, diagonal
 *                                 attack range via isLocalNearTileDiag).
 */
export function upsertEnemyHitbox(
  sessionId:   string,
  tileCol:     number,
  tileRow:     number,
  team:        string,
  displayName: string,
  alive:       boolean,
  userId:      string = ''
) {
  const localTeam = getLocalState().myTeam
  const isEnemy   = localTeam !== 'none' && team !== 'none' && team !== localTeam

  if (!isEnemy || !alive) {
    removeEnemyHitbox(sessionId)
    return
  }

  let hb = hitboxes.get(sessionId)

  if (!hb) {
    const wx = tileToWorldX(tileCol)
    const wz = tileToWorldZ(tileRow)

    // ── Physics presence ─────────────────────────────────────────────────────
    // Box shape (not clickable), CL_PHYSICS only. Covers the full tile so the
    // local player cannot walk onto an enemy tile from a cardinal direction.
    // Diagonal approach is structurally blocked by maze walls — the physics
    // box doesn't need to cover diagonal paths.
    const physicsBox = createEntity({
      position:      Vector3.create(wx, GAME_FLOOR_Y + PHYSICS_H / 2, wz),
      scale:         Vector3.create(PHYSICS_W, PHYSICS_H, PHYSICS_W),
      mesh:          'box',
      material:      { color: Color4.create(0, 0, 0, 0), transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND },
      collider:      'box',
      colliderLayer: ColliderLayer.CL_PHYSICS   // physics only — no click
    })

    // ── Click target (cylinder) ──────────────────────────────────────────────
    // Cylinder collider + renderer, CL_POINTER only. More accurate player
    // silhouette than a box; no corner false-positives when strafing past.
    // Pinned to the live avatar position every frame by the system above.
    // Attack is gated by isLocalNearTileDiag so diagonal tiles are valid.
    const clickBox = createEntity({
      position:      Vector3.create(wx, GAME_FLOOR_Y + CLICK_H / 2, wz),
      scale:         Vector3.create(CLICK_W, CLICK_H, CLICK_W),
      mesh:          'cylinder',
      material:      { color: Color4.create(0, 0, 0, 0), transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND },
      collider:      'box',
      colliderLayer: ColliderLayer.CL_POINTER
    })
    makeClickable(clickBox, `Attack ${displayName || 'Player'}`, () => {
      const target = hitboxes.get(sessionId)
      if (!target) return
      // Allow attacks from any of the 8 surrounding tiles (including diagonals).
      // Pushback (physicsBox CL_PHYSICS) still only blocks cardinal movement.
      if (!isLocalNearTileDiag(target.col, target.row)) return
      sendToRoom('attack', { targetId: sessionId })
    }, 3.5)

    hitboxes.set(sessionId, {
      physicsBox,
      clickBox,
      col:  tileCol,
      row:  tileRow,
      team,
      name: displayName,
      userId,
      avatarEntity: null
    })
    return
  }

  // Refresh hover text if display name changed.
  if (displayName && displayName !== hb.name) {
    hb.name = displayName
    makeClickable(hb.clickBox, `Attack ${displayName}`, () => {
      const target = hitboxes.get(sessionId)
      if (!target) return
      if (!isLocalNearTileDiag(target.col, target.row)) return
      sendToRoom('attack', { targetId: sessionId })
    }, 3.5)
  }

  // userId may arrive later (initial tick had it as '' before identify).
  if (userId && userId !== hb.userId) {
    hb.userId       = userId
    hb.avatarEntity = null   // force re-lookup against the new userId
  }

  // Authoritative physics-box snap to the server's tile.
  if (tileCol !== hb.col || tileRow !== hb.row) {
    _setPhysicsPos(hb, tileCol, tileRow)
  }
  hb.team = team
}

/** Remove a single player's hitbox. */
export function removeEnemyHitbox(sessionId: string) {
  const hb = hitboxes.get(sessionId)
  if (!hb) return
  removeEntity(hb.physicsBox)
  removeEntity(hb.clickBox)
  hitboxes.delete(sessionId)
}

/** Remove every enemy hitbox (e.g. on game end or disconnect). */
export function removeAllEnemyHitboxes() {
  for (const sid of [...hitboxes.keys()]) removeEnemyHitbox(sid)
}

/** Re-evaluate all hitboxes after local team changes. */
export function syncEnemyHitboxTeams() {
  const localTeam = getLocalState().myTeam
  for (const [sid, hb] of [...hitboxes.entries()]) {
    if (localTeam === 'none' || hb.team === localTeam) {
      removeEnemyHitbox(sid)
    }
  }
}
