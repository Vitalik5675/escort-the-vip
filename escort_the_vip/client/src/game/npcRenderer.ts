import { engine, Entity, Transform, AvatarShape, ColliderLayer, MeshCollider,
         PlayerIdentityData, AvatarBase, AvatarEquippedData } from '@dcl/sdk/ecs'
import { Vector3, Color4, Color3, Quaternion } from '@dcl/sdk/math'
import { createEntity, setVisible, makeClickable, removeClickable, removeEntity, setEKeyHint, clearEKeyHint } from '../utils/entityFactory'
import { isLocalNearTile, isLocalNearTileDiag } from '../utils/adjacency'
import { GAME_FLOOR_Y, tileToWorldX, tileToWorldZ } from './constants'
import { sendToRoom } from '../colyseus-client'
import { getLocalState } from '../state/localState'
import { tryGateAttack } from './combatState'
import { consumeWallEKey } from './combatInput'

// VIP NPC rendered as an AvatarShape entity.
// Three entities — mirrors the enemy-player hitbox architecture:
//   • vipEntity  — AvatarShape, NO collider (never pushes players)
//   • vipHitBox  — (0.8×2×0.8) CL_POINTER only. Large click target for easy aiming
//                  from the adjacent tile.  No physics — never blocks movement.
//                    Haters     → 'Attack VIP'  (Chebyshev ≤ 1 guard)
//                    Bodyguards → 'Escort VIP'  (cardinal ≤ 1 guard)
//                    Escorting  → collider removed (clicks pass through to enemies)
//   • vipPhysBox — (0.3×2×0.3) CL_PHYSICS only for haters. Narrow enough that a
//                  hater can walk onto VIP's tile (2 m wide) and be deflected only
//                  by the avatar body, not from the tile boundary.  Server teleports
//                  the hater back after their attack resolves (see resolveAttack).
//                    Bodyguards / others → collider removed (walk freely)

let vipEntity:  Entity | null = null   // AvatarShape — visual only, no collider
let vipHitBox:  Entity | null = null   // invisible click box (CL_POINTER, 0.8×2×0.8)
let vipPhysBox: Entity | null = null   // invisible physics body (CL_PHYSICS, 0.3×2×0.3)
let _lastVipCol        = -1            // previous confirmed tile col (-1 = no history)
let _lastVipRow        = -1
let _lastFacingAngle: number | null = null
// Facing angle (degrees) last received from the server via vip.facingYaw.
// Applied to the VIP entity when she is idle (no active tile animation).
let _serverFacingYaw = 0
let _lastAppearanceKey = ''            // tracks current outfit; reapply AvatarShape when it changes

// ── Per-tile animation state ──────────────────────────────────────────────────
// The ECS system processes tiles one at a time from _vipTileQueue.
// This prevents the visual jump that occurred when multiple server updates arrived
// before a single animation completed.

const ANIM_BASE_MS = 850
let _animStartX   = 0, _animStartZ   = 0
let _animEndX     = 0, _animEndZ     = 0
let _animElapsed  = ANIM_BASE_MS     // starts "done" — no spurious animation on load
let _animDuration = ANIM_BASE_MS

// Pending tile positions to animate through sequentially
let _vipTileQueue: Array<{ col: number; row: number }> = []

// ── Live avatar sync (for 'player' appearance mode) ─────────────────────────
// When vip.playerWallet is set, we scan every frame for a player entity with
// that wallet address.  If found, we copy their AvatarBase + AvatarEquippedData
// directly to the VIP — no Catalyst API needed.  The server-fetched
// playerAvatarJson serves as a fallback for when the player is not in the scene.

let _targetWallet    = ''   // wallet to live-sync; '' = disabled
let _lastLiveSyncKey = ''   // change-detection: body + first wearable

engine.addSystem(() => {
  // Only run when VIP is visible and a target wallet is configured.
  if (!vipEntity || !_targetWallet) return

  // Search all player entities for the one with the matching wallet.
  let targetEntity: Entity | null = null
  for (const [entity, idData] of engine.getEntitiesWith(PlayerIdentityData)) {
    if ((idData.address ?? '').toLowerCase() === _targetWallet) {
      targetEntity = entity
      break
    }
  }
  if (targetEntity === null) return   // player not in this scene

  const base     = AvatarBase.getOrNull(targetEntity)
  const equipped = AvatarEquippedData.getOrNull(targetEntity)
  if (!base || !equipped) return

  // Cheap change-detection — rebuild AvatarShape only when something changed.
  const syncKey = base.bodyShapeUrn + '|' + equipped.wearableUrns.length + '|' +
                  (equipped.wearableUrns[0] ?? '') + '|' +
                  (equipped.wearableUrns[equipped.wearableUrns.length - 1] ?? '')
  if (syncKey === _lastLiveSyncKey) return
  _lastLiveSyncKey = syncKey

  // Apply the live player's exact appearance to the VIP.
  // Note: AvatarBase uses  eyesColor (plural),
  //       AvatarShape needs eyeColor  (singular).
  AvatarShape.createOrReplace(vipEntity, {
    id:        'vip-npc',
    name:      'VIP ⭐',
    bodyShape: base.bodyShapeUrn || 'urn:decentraland:off-chain:base-avatars:BaseFemale',
    skinColor: base.skinColor  ?? Color3.create(0.8, 0.65, 0.5),
    hairColor: base.hairColor  ?? Color3.create(0.3, 0.20, 0.1),
    eyeColor:  base.eyesColor  ?? Color3.create(0.4, 0.35, 0.25),
    wearables: equipped.wearableUrns,
    emotes:    []
  })
})

function easeOutQuad(t: number): number { return 1 - (1 - t) * (1 - t) }

// Start one tile animation. Always called with valid _lastVipCol / _lastVipRow.
function _startVipMove(toCol: number, toRow: number) {
  const wx     = tileToWorldX(toCol)
  const wz     = tileToWorldZ(toRow)
  const fromWx = tileToWorldX(_lastVipCol)
  const fromWz = tileToWorldZ(_lastVipRow)
  const dx = wx - fromWx, dz = wz - fromWz
  if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
    _lastFacingAngle = Math.atan2(dx, dz) * (180 / Math.PI)
    const tr = Transform.getMutableOrNull(vipEntity!)
    if (tr) tr.rotation = Quaternion.fromEulerDegrees(0, _lastFacingAngle, 0)
  }
  // Compress animation when the queue is non-empty so VIP doesn't fall behind
  _animDuration = _vipTileQueue.length >= 1 ? ANIM_BASE_MS / 2 : ANIM_BASE_MS
  _animStartX = fromWx; _animStartZ = fromWz
  _animEndX   = wx;     _animEndZ   = wz
  _animElapsed = 0
  _lastVipCol = toCol; _lastVipRow = toRow
}

engine.addSystem((dt: number) => {
  if (!vipEntity) return

  // When animation completes, start the next queued tile
  if (_animElapsed >= _animDuration) {
    if (_vipTileQueue.length > 0) {
      const next = _vipTileQueue.shift()!
      _startVipMove(next.col, next.row)
    } else {
      // VIP is idle — apply server-provided facing if it changed noticeably
      if (_lastFacingAngle === null || Math.abs(_serverFacingYaw - _lastFacingAngle) > 5) {
        _lastFacingAngle = _serverFacingYaw
        const tr = Transform.getMutableOrNull(vipEntity)
        if (tr) tr.rotation = Quaternion.fromEulerDegrees(0, _lastFacingAngle, 0)
      }
      return
    }
  }

  _animElapsed = Math.min(_animElapsed + dt * 1000, _animDuration)
  const t  = easeOutQuad(_animElapsed / _animDuration)
  const px = _animStartX + (_animEndX - _animStartX) * t
  const pz = _animStartZ + (_animEndZ - _animStartZ) * t
  const tr = Transform.getMutableOrNull(vipEntity)
  if (tr) { tr.position.x = px; tr.position.z = pz }
  if (vipHitBox) {
    const ht = Transform.getMutableOrNull(vipHitBox)
    if (ht) { ht.position.x = px; ht.position.z = pz }
  }
  if (vipPhysBox) {
    const pt = Transform.getMutableOrNull(vipPhysBox)
    if (pt) { pt.position.x = px; pt.position.z = pz }
  }
})

// Configures VIP hitbox collider and click handler based on the local player's team
// and current escort state:
//
//   • Haters               → CL_POINTER | CL_PHYSICS, clickable "Attack VIP".
//   • Bodyguard, escorting → Collider removed entirely so clicks pass through
//                            VIP to enemies standing behind her.
//   • Bodyguard, free      → CL_POINTER only, clickable "Escort VIP".
//                            Click is silently blocked for 15 s after another
//                            BG claims VIP (checked live in the handler).
//   • Lobby/none           → CL_POINTER only, not clickable.
// Configures VIP hitbox collider and click handler based on the local player's team
// and current escort state.
//
// Architecture mirrors enemy playerHitboxes: two separate entities so the physics
// body and the pointer target can have independent sizes.
//
//   vipPhysBox (0.3 × 2 × 0.3, CL_PHYSICS only)
//     • Haters only, unless ALLOW_ALL_TILE_OVERLAP.
//     • Small enough that haters can walk ONTO VIP's tile before being
//       deflected — tile is 2 m wide, 0.3 m body lets hater reach within
//       ~0.45 m of VIP centre, well inside the 1 m tile half-extent.
//     • Bodyguards and spectators: collider removed (walk freely).
//
//   vipHitBox (0.8 × 2 × 0.8, CL_POINTER only)
//     • Always CL_POINTER only — no physics, so it never blocks movement.
//     • Larger surface makes the click target easy to hit from an adjacent tile.
//     • Escorting bodyguard: deleted entirely so clicks pass through VIP to
//       enemies standing behind her.
export function updateVipClickable() {
  if (!vipHitBox || !vipPhysBox) return
  const s = getLocalState()
  const myTeam = s.myTeam

  if (myTeam === 'hater') {
    // ── Physics body ────────────────────────────────────────────────────────
    // ALLOW_ALL_TILE_OVERLAP: remove CL_PHYSICS so haters can walk straight
    // through the VIP hitbox without any collision.
    if (s.allowAllTileOverlap) {
      MeshCollider.deleteFrom(vipPhysBox)
    } else {
      MeshCollider.setBox(vipPhysBox, ColliderLayer.CL_PHYSICS)
    }
    // ── Click target ─────────────────────────────────────────────────────────
    MeshCollider.setBox(vipHitBox, ColliderLayer.CL_POINTER)
    makeClickable(vipHitBox, 'Attack VIP', () => {
      if (!isLocalNearTileDiag(_lastVipCol, _lastVipRow)) return
      if (!tryGateAttack()) return
      sendToRoom('attack_vip', {})
    }, 3.5)
    // Bomb-throw hint for haters — synced to inventory by refreshVipBombHint.
    refreshVipBombHint(s.myLeftHand === 'bomb')

  } else if (myTeam === 'bodyguard') {
    // Bodyguards never have physics against VIP — they walk freely around her.
    MeshCollider.deleteFrom(vipPhysBox)

    const isEscorting = s.vipFollowerId !== '' && s.vipFollowerId === s.mySessionId
    if (isEscorting) {
      // Remove click collider too — clicks pass straight through VIP to
      // whatever is behind her (e.g. an enemy to attack).
      MeshCollider.deleteFrom(vipHitBox)
      removeClickable(vipHitBox)
    } else {
      MeshCollider.setBox(vipHitBox, ColliderLayer.CL_POINTER)
      makeClickable(vipHitBox, 'Escort VIP', () => {
        // Re-read state inside handler so the cooldown check stays live even
        // if updateVipClickable hasn't been re-called since cooldown started.
        const cur = getLocalState()
        if (Date.now() < cur.vipFollowCooldownUntil) return
        if (!isLocalNearTile(_lastVipCol, _lastVipRow)) return
        sendToRoom('follow_vip', {})
      }, 3.5)
    }

  } else {
    // Lobby / spectator / none: no physics, pointer only, no click handler.
    MeshCollider.deleteFrom(vipPhysBox)
    MeshCollider.setBox(vipHitBox, ColliderLayer.CL_POINTER)
    removeClickable(vipHitBox)
    clearEKeyHint(vipHitBox)
  }
}

/**
 * Show or hide the "Throw Bomb [E]" hint on the VIP hitbox (haters only).
 * Call this whenever myLeftHand changes — same sites as refreshWallEKeyLabels.
 */
export function refreshVipBombHint(hasBomb: boolean): void {
  if (!vipHitBox) return
  const s = getLocalState()
  if (s.myTeam !== 'hater') { clearEKeyHint(vipHitBox); return }
  if (hasBomb) {
    setEKeyHint(vipHitBox, 'Throw Bomb at VIP', 3.5, () => {
      const ls = getLocalState()
      if (ls.myLeftHand !== 'bomb') return
      if (!isLocalNearTileDiag(_lastVipCol, _lastVipRow)) return
      consumeWallEKey()   // suppress global place_bomb handler
      sendToRoom('throw_bomb', { targetId: '__vip__' })
    })
  } else {
    clearEKeyHint(vipHitBox)
  }
}

export function upsertVip(
  tileCol: number, tileRow: number,
  active: boolean,
  appearance?: { female: boolean; outfitIndex: number; skinIndex: number; hairIndex: number; eyeIndex: number },
  playerAvatarJson?: string,
  playerWallet?: string
) {
  const wx = tileToWorldX(tileCol)
  const wz = tileToWorldZ(tileRow)

  if (!active) {
    if (vipEntity)  setVisible(vipEntity,  false)
    if (vipHitBox)  setVisible(vipHitBox,  false)
    if (vipPhysBox) setVisible(vipPhysBox, false)
    _lastVipCol = -1; _lastVipRow = -1; _lastFacingAngle = null
    _vipTileQueue = []; _animElapsed = ANIM_BASE_MS
    _targetWallet = ''; _lastLiveSyncKey = ''
    return
  }

  // Compute the appearance key once so we can decide whether to reapply
  // AvatarShape (new match started with a different outfit / new VIP entity).
  const ap  = appearance ?? { female: false, outfitIndex: 0, skinIndex: 0, hairIndex: 0, eyeIndex: 0 }
  const avatarJson = playerAvatarJson ?? ''
  const wallet     = (playerWallet ?? '').toLowerCase()

  // Update the live-sync target wallet.  Reset the change-detection key so the
  // ECS system immediately re-applies the appearance when the wallet changes.
  if (wallet !== _targetWallet) {
    _targetWallet    = wallet
    _lastLiveSyncKey = ''
  }

  // If the server supplied a full avatar JSON, use its hash as the key so a
  // config change (e.g. wallet swap between matches) triggers a re-render.
  // In 'player' mode with a live player in the scene, the ECS system overrides
  // this with fresh data on the next frame regardless of the key.
  const appearanceKey = avatarJson
    ? 'json:' + avatarJson.slice(0, 60)
    : (ap.female ? 'F' : 'M') + '-' + ap.outfitIndex + '-' + ap.skinIndex + '-' + ap.hairIndex + '-' + ap.eyeIndex

  if (!vipEntity) {
    // Avatar entity — AvatarShape, NO collider so VIP never pushes players
    vipEntity = createEntity({
      position: Vector3.create(wx, GAME_FLOOR_Y, wz),
      collider: false
    })
    if (avatarJson) {
      applyAvatarJsonToVip(vipEntity, avatarJson)
    } else {
      const outfit = outfitFromIndices(ap)
      AvatarShape.createOrReplace(vipEntity, {
        id:        'vip-npc',
        name:      'VIP ⭐',
        bodyShape: outfit.bodyShape,
        skinColor: outfit.skinColor,
        hairColor: outfit.hairColor,
        eyeColor:  outfit.eyeColor,
        wearables: outfit.wearables,
        emotes:    []
      })
    }
    _lastAppearanceKey = appearanceKey

    // Click target — large (0.8 × 2 × 0.8) so it is easy to aim at from an
    // adjacent tile.  CL_POINTER only — no physics so it never blocks movement.
    // updateVipClickable() may delete this collider for escorting bodyguards so
    // clicks pass through VIP to enemies standing behind her.
    vipHitBox = createEntity({
      position:      Vector3.create(wx, GAME_FLOOR_Y + 1.0, wz),
      scale:         Vector3.create(0.8, 2.0, 0.8),
      collider:      'box',
      colliderLayer: ColliderLayer.CL_POINTER
    })

    // Physics body — 0.6 × 2 × 0.6 gives a noticeable physical contact when
    // the hater walks into VIP, while still letting them reach VIP's tile.
    // With TILE_SIZE=2 m and a typical DCL player capsule radius of ~0.4 m:
    //   hater stops at  0.30 + 0.40 = 0.70 m from VIP centre
    //   tile half-extent = 1.0 m  →  hater IS on VIP's tile server-side ✓
    // The server then evicts the hater each NPC tick (evictHatersFromVipTile).
    // CL_PHYSICS for haters, removed for bodyguards — managed by updateVipClickable().
    vipPhysBox = createEntity({
      position:      Vector3.create(wx, GAME_FLOOR_Y + 1.0, wz),
      scale:         Vector3.create(0.6, 2.0, 0.6),
      collider:      'box',
      colliderLayer: ColliderLayer.CL_PHYSICS
    })

    updateVipClickable()

    // Snap to start position — no animation on first creation
    _lastVipCol = tileCol; _lastVipRow = tileRow
    _vipTileQueue = []; _animElapsed = ANIM_BASE_MS; _animDuration = ANIM_BASE_MS
    _lastFacingAngle = null

  } else {
    setVisible(vipEntity, true)
    if (vipHitBox) setVisible(vipHitBox, true)

    // Reapply AvatarShape if the server picked a new appearance for this match
    // (e.g. fresh game after the previous one ended). The entity is reused
    // across matches so we have to push the new outfit onto it manually.
    if (appearanceKey !== _lastAppearanceKey) {
      if (avatarJson) {
        applyAvatarJsonToVip(vipEntity, avatarJson)
      } else {
        const outfit = outfitFromIndices(ap)
        AvatarShape.createOrReplace(vipEntity, {
          id:        'vip-npc',
          name:      'VIP ⭐',
          bodyShape: outfit.bodyShape,
          skinColor: outfit.skinColor,
          hairColor: outfit.hairColor,
          eyeColor:  outfit.eyeColor,
          wearables: outfit.wearables,
          emotes:    []
        })
      }
      _lastAppearanceKey = appearanceKey
    }

    const moved = tileCol !== _lastVipCol || tileRow !== _lastVipRow
    if (moved) {
      if (_lastVipCol >= 0) {
        // If the new tile is more than one cardinal step away from the last
        // known tile, the client missed intermediate state updates (network
        // lag, frame drop). Linearly interpolating across that gap would
        // visually drag the VIP through walls. Snap to the latest authoritative
        // position instead — server-side pathfinding already guarantees that
        // every confirmed tile is wall-legal.
        const manh = Math.abs(tileCol - _lastVipCol) + Math.abs(tileRow - _lastVipRow)
        if (manh > 1) {
          const tr = Transform.getMutableOrNull(vipEntity)
          if (tr) {
            tr.position.x = wx
            tr.position.z = wz
            // Recompute facing direction based on the snap vector so VIP
            // doesn't point the wrong way after skipping intermediate tiles.
            const fromWx = tileToWorldX(_lastVipCol), fromWz = tileToWorldZ(_lastVipRow)
            const dx = wx - fromWx, dz = wz - fromWz
            if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
              _lastFacingAngle = Math.atan2(dx, dz) * (180 / Math.PI)
              tr.rotation = Quaternion.fromEulerDegrees(0, _lastFacingAngle, 0)
            }
          }
          if (vipHitBox) {
            const ht = Transform.getMutableOrNull(vipHitBox)
            if (ht) { ht.position.x = wx; ht.position.y = GAME_FLOOR_Y + 1.0; ht.position.z = wz }
          }
          if (vipPhysBox) {
            const pt = Transform.getMutableOrNull(vipPhysBox)
            if (pt) { pt.position.x = wx; pt.position.y = GAME_FLOOR_Y + 1.0; pt.position.z = wz }
          }
          _lastVipCol = tileCol; _lastVipRow = tileRow
          _vipTileQueue = []; _animElapsed = ANIM_BASE_MS; _animDuration = ANIM_BASE_MS
        } else if (_animElapsed >= _animDuration) {
          // No animation in progress: start immediately (single-tile step)
          _startVipMove(tileCol, tileRow)
        } else {
          // Animation running: enqueue (cap at 3 to prevent unbounded lag)
          if (_vipTileQueue.length < 3) {
            _vipTileQueue.push({ col: tileCol, row: tileRow })
          } else {
            // Too far behind: discard intermediates, jump straight to latest confirmed position
            _vipTileQueue = [{ col: tileCol, row: tileRow }]
          }
        }
      } else {
        // Fresh activation after !active: snap immediately, no animation
        const tr = Transform.getMutableOrNull(vipEntity)
        if (tr) tr.position = Vector3.create(wx, GAME_FLOOR_Y, wz)
        if (vipHitBox) {
          const ht = Transform.getMutableOrNull(vipHitBox)
          if (ht) { ht.position.x = wx; ht.position.y = GAME_FLOOR_Y + 1.0; ht.position.z = wz }
        }
        if (vipPhysBox) {
          const pt = Transform.getMutableOrNull(vipPhysBox)
          if (pt) { pt.position.x = wx; pt.position.y = GAME_FLOOR_Y + 1.0; pt.position.z = wz }
        }
        _lastVipCol = tileCol; _lastVipRow = tileRow
        _vipTileQueue = []; _animElapsed = ANIM_BASE_MS; _animDuration = ANIM_BASE_MS
      }
    }
  }

}

export function removeVip() {
  if (vipEntity)  { removeEntity(vipEntity);  vipEntity  = null }
  if (vipHitBox)  { removeEntity(vipHitBox);  vipHitBox  = null }
  if (vipPhysBox) { removeEntity(vipPhysBox); vipPhysBox = null }
  _vipTileQueue = []
}

export function setVipVisible(v: boolean) {
  if (vipEntity)  setVisible(vipEntity,  v)
  if (vipHitBox)  setVisible(vipHitBox,  v)
  if (vipPhysBox) setVisible(vipPhysBox, v)
}

export function getVipEntity(): Entity | null { return vipEntity }


/** Current VIP tile position. col/row = -1 when VIP is not active. */
/** Update the server-authoritative facing angle used when VIP is idle. */
export function setVipFacingYaw(yawDegrees: number): void {
  _serverFacingYaw = yawDegrees
}

export function getVipTile(): { col: number; row: number } {
  return { col: _lastVipCol, row: _lastVipRow }
}

// ── Server-supplied avatar JSON ───────────────────────────────────────────────
// Parses the JSON blob produced by the server (Catalyst fetch + overrides) and
// applies it directly to an AvatarShape.  All colour values arrive as {r,g,b}
// plain objects (0–1 range) matching the Catalyst API format.

function applyAvatarJsonToVip(entity: Entity, json: string) {
  try {
    const d = JSON.parse(json)
    AvatarShape.createOrReplace(entity, {
      id:        'vip-npc',
      name:      'VIP ⭐',
      bodyShape: d.bodyShape,
      skinColor: Color3.create(d.skinColor?.r ?? 0.8, d.skinColor?.g ?? 0.65, d.skinColor?.b ?? 0.5),
      hairColor: Color3.create(d.hairColor?.r ?? 0.3, d.hairColor?.g ?? 0.20, d.hairColor?.b ?? 0.1),
      eyeColor:  Color3.create(d.eyeColor?.r  ?? 0.4, d.eyeColor?.g  ?? 0.35, d.eyeColor?.b  ?? 0.25),
      wearables: Array.isArray(d.wearables) ? d.wearables : [],
      emotes:    []
    })
  } catch (e) {
    console.error('[npcRenderer] applyAvatarJsonToVip parse error:', e)
  }
}

// ── Random outfit factory ─────────────────────────────────────────────────────
// Picks a body shape + a coordinated set of base-avatar wearables so the VIP
// looks dressed instead of standing in the default nude T-pose.

const BASE = 'urn:decentraland:off-chain:base-avatars:'

const MALE_OUTFITS: string[][] = [
  // Eyes / brows / mouth come from the base set; we just pick clothing/hair.
  [BASE + 'eyes_00',     BASE + 'eyebrows_00',  BASE + 'mouth_00',
   BASE + 'casual_hair_01',  BASE + 'm_sweater',          BASE + 'soccer_pants',     BASE + 'sneakers'],
  [BASE + 'eyes_02',     BASE + 'eyebrows_02',  BASE + 'mouth_05',
   BASE + 'cool_hair',       BASE + 'sport_jacket',       BASE + 'oxford_pants',     BASE + 'classic_shoes'],
  [BASE + 'eyes_05',     BASE + 'eyebrows_05',  BASE + 'mouth_03',
   BASE + 'punk',            BASE + 'green_hoodie',       BASE + 'brown_pants',      BASE + 'bun_shoes'],
  [BASE + 'eyes_08',     BASE + 'eyebrows_07',  BASE + 'mouth_08',
   BASE + 'short_hair',      BASE + 'striped_pijama',     BASE + 'pijama_pants',     BASE + 'crocs'],
]

const FEMALE_OUTFITS: string[][] = [
  [BASE + 'f_eyes_00',   BASE + 'f_eyebrows_00', BASE + 'f_mouth_00',
   BASE + 'standard_hair',   BASE + 'f_sweater',          BASE + 'f_jeans',          BASE + 'bun_shoes'],
  [BASE + 'f_eyes_01',   BASE + 'f_eyebrows_03', BASE + 'f_mouth_03',
   BASE + 'hair_anime_01',   BASE + 'f_red_simple_tshirt',BASE + 'f_brown_skirt',    BASE + 'classic_shoes'],
  [BASE + 'f_eyes_05',   BASE + 'f_eyebrows_07', BASE + 'f_mouth_05',
   BASE + 'pony_tail',       BASE + 'f_blue_jacket',      BASE + 'f_diamond_leggings', BASE + 'sneakers'],
  [BASE + 'f_eyes_07',   BASE + 'f_eyebrows_05', BASE + 'f_mouth_06',
   BASE + 'modern_hair',     BASE + 'f_pink_simple_tshirt',BASE + 'f_short_blue_jeans', BASE + 'crocs'],
]

const SKIN_TONES: Color3[] = [
  Color3.create(0.95, 0.80, 0.55),
  Color3.create(0.83, 0.65, 0.50),
  Color3.create(0.62, 0.45, 0.35),
  Color3.create(0.45, 0.30, 0.22),
  Color3.create(1.00, 0.88, 0.75),
]
const HAIR_COLORS: Color3[] = [
  Color3.create(0.10, 0.07, 0.05),  // black
  Color3.create(0.32, 0.20, 0.10),  // dark brown
  Color3.create(0.55, 0.35, 0.18),  // brown
  Color3.create(0.85, 0.60, 0.20),  // blond
  Color3.create(0.90, 0.10, 0.15),  // red
  Color3.create(0.60, 0.60, 0.65),  // grey
]
const EYE_COLORS: Color3[] = [
  Color3.create(0.30, 0.20, 0.10),  // brown
  Color3.create(0.20, 0.45, 0.65),  // blue
  Color3.create(0.30, 0.55, 0.30),  // green
  Color3.create(0.50, 0.40, 0.20),  // hazel
  Color3.create(0.15, 0.15, 0.18),  // near-black
]

interface VipOutfit {
  bodyShape: string
  skinColor: Color3
  hairColor: Color3
  eyeColor:  Color3
  wearables: string[]
}

// Deterministic lookup — every client receives the same indices from the
// server's VIPState and resolves them to the same outfit so all players see
// the same VIP for the duration of a match. Indices are clamped so a stale or
// out-of-range value never crashes the avatar.
function outfitFromIndices(idx: {
  female: boolean; outfitIndex: number; skinIndex: number; hairIndex: number; eyeIndex: number
}): VipOutfit {
  const outfits = idx.female ? FEMALE_OUTFITS : MALE_OUTFITS
  const safe = (i: number, max: number) => Math.max(0, Math.min(max - 1, i | 0))
  return {
    bodyShape: BASE + (idx.female ? 'BaseFemale' : 'BaseMale'),
    skinColor: SKIN_TONES[safe(idx.skinIndex,   SKIN_TONES.length)],
    hairColor: HAIR_COLORS[safe(idx.hairIndex,  HAIR_COLORS.length)],
    eyeColor:  EYE_COLORS[safe(idx.eyeIndex,    EYE_COLORS.length)],
    wearables: outfits[safe(idx.outfitIndex,    outfits.length)]
  }
}
