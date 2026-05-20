import { engine, Entity, Transform, AvatarShape, ColliderLayer, MeshCollider } from '@dcl/sdk/ecs'
import { Vector3, Color4, Color3, Quaternion } from '@dcl/sdk/math'
import { createEntity, setVisible, makeClickable, removeClickable, removeEntity } from '../utils/entityFactory'
import { isLocalNearTile, isLocalNearTileDiag } from '../utils/adjacency'
import { GAME_FLOOR_Y, tileToWorldX, tileToWorldZ } from './constants'
import { sendToRoom } from '../colyseus-client'
import { getLocalState } from '../state/localState'

// VIP NPC rendered as an AvatarShape entity.
// Two entities:
//   • vipEntity  — AvatarShape, NO collider (never pushes players)
//   • vipHitBox  — small (0.8×2×0.8) invisible box. Handles both clicking and
//                  a soft physical presence for haters:
//                    Haters     → CL_POINTER | CL_PHYSICS (click to attack + pushback)
//                    Bodyguards → CL_POINTER only (click to escort, walk freely)
//                    Others     → CL_POINTER only, not clickable

let vipEntity:  Entity | null = null   // AvatarShape — visual only, no collider
let vipHitBox:  Entity | null = null   // invisible click + soft-physics box
let _lastVipCol        = -1            // previous confirmed tile col (-1 = no history)
let _lastVipRow        = -1
let _lastFacingAngle: number | null = null
let _lastAppearanceKey = ''            // tracks current outfit; reapply AvatarShape when it changes

// ── Per-tile animation state ──────────────────────────────────────────────────
// The ECS system processes tiles one at a time from _vipTileQueue.
// This prevents the visual jump that occurred when multiple server updates arrived
// before a single animation completed.

const ANIM_BASE_MS = 600
let _animStartX   = 0, _animStartZ   = 0
let _animEndX     = 0, _animEndZ     = 0
let _animElapsed  = ANIM_BASE_MS     // starts "done" — no spurious animation on load
let _animDuration = ANIM_BASE_MS

// Pending tile positions to animate through sequentially
let _vipTileQueue: Array<{ col: number; row: number }> = []

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
export function updateVipClickable() {
  if (!vipHitBox) return
  const s = getLocalState()
  const myTeam = s.myTeam

  if (myTeam === 'hater') {
    MeshCollider.setBox(vipHitBox, ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS)
    makeClickable(vipHitBox, 'Attack VIP', () => {
      if (!isLocalNearTileDiag(_lastVipCol, _lastVipRow)) return
      sendToRoom('attack_vip', {})
    }, 3.5)

  } else if (myTeam === 'bodyguard') {
    const isEscorting = s.vipFollowerId !== '' && s.vipFollowerId === s.mySessionId
    if (isEscorting) {
      // Remove collider + pointer events entirely — clicks pass straight through
      // VIP to whatever is behind her (e.g. an enemy to attack).
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
    MeshCollider.setBox(vipHitBox, ColliderLayer.CL_POINTER)
    removeClickable(vipHitBox)
  }
}

export function upsertVip(
  tileCol: number, tileRow: number,
  active: boolean,
  appearance?: { female: boolean; outfitIndex: number; skinIndex: number; hairIndex: number; eyeIndex: number }
) {
  const wx = tileToWorldX(tileCol)
  const wz = tileToWorldZ(tileRow)

  if (!active) {
    if (vipEntity)  setVisible(vipEntity,  false)
    if (vipHitBox)  setVisible(vipHitBox,  false)
    _lastVipCol = -1; _lastVipRow = -1; _lastFacingAngle = null
    _vipTileQueue = []; _animElapsed = ANIM_BASE_MS
    return
  }

  // Compute the appearance key once so we can decide whether to reapply
  // AvatarShape (new match started with a different outfit / new VIP entity).
  const ap = appearance ?? { female: false, outfitIndex: 0, skinIndex: 0, hairIndex: 0, eyeIndex: 0 }
  const appearanceKey = `${ap.female ? 'F' : 'M'}-${ap.outfitIndex}-${ap.skinIndex}-${ap.hairIndex}-${ap.eyeIndex}`

  if (!vipEntity) {
    // Avatar entity — AvatarShape, NO collider so VIP never pushes players
    vipEntity = createEntity({
      position: Vector3.create(wx, GAME_FLOOR_Y, wz),
      collider: false
    })
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
    _lastAppearanceKey = appearanceKey

    // Transparent interaction hitbox. Default is CL_POINTER only — collider layer
    // is replaced by updateVipClickable() based on the local player's team:
    // haters get CL_POINTER | CL_PHYSICS (clickable attack + pushback);
    // bodyguards keep CL_POINTER (clickable escort, no physics).
    vipHitBox = createEntity({
      position:      Vector3.create(wx, GAME_FLOOR_Y + 1.0, wz),
      scale:         Vector3.create(0.8, 2.0, 0.8),
      collider:      'box',
      colliderLayer: ColliderLayer.CL_POINTER
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
        _lastVipCol = tileCol; _lastVipRow = tileRow
        _vipTileQueue = []; _animElapsed = ANIM_BASE_MS; _animDuration = ANIM_BASE_MS
      }
    }
  }

}

export function removeVip() {
  if (vipEntity)  { removeEntity(vipEntity);  vipEntity  = null }
  if (vipHitBox)  { removeEntity(vipHitBox);  vipHitBox  = null }
  _vipTileQueue = []
}

export function setVipVisible(v: boolean) {
  if (vipEntity)  setVisible(vipEntity,  v)
  if (vipHitBox)  setVisible(vipHitBox,  v)
}

export function getVipEntity(): Entity | null { return vipEntity }

/** Current VIP tile position. col/row = -1 when VIP is not active. */
export function getVipTile(): { col: number; row: number } {
  return { col: _lastVipCol, row: _lastVipRow }
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
