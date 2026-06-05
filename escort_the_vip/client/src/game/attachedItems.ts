import { engine, Entity, AvatarAttach, AvatarAnchorPointType, MaterialTransparencyMode, TextureWrapMode } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { createEntity, removeEntity, removeEntityAndChildren } from '../utils/entityFactory'
import { getLocalState } from '../state/localState'

// Per-player held-item visuals attached to the avatar's hands via AvatarAttach.
//
// Entity hierarchy per held item:
//   anchor  — AvatarAttach, SDK drives its position (no readable Transform)
//   visual  — container child of anchor; holds position/rotation/scale; no mesh
//     ├── base     — solid thematic color mesh; fills the full mesh surface
//     └── overlay  — texture mesh, 0.3% larger to avoid Z-fighting;
//                    MTM_ALPHA_BLEND so transparent PNG areas reveal base below
//   (shield adds a second base+overlay pair rotated 180°Y for the back face)
//
// This "base + overlay" pattern eliminates the transparent-padding halo that
// appears when using only a texture with MTM_ALPHA_BLEND: transparent PNG
// pixels show the base color instead of empty space.

export type HandSlot = 'right' | 'left'
export type HandItem = 'none' | 'baton' | 'shield' | 'bomb'

interface HandPair {
  right?: { anchor: Entity; visual: Entity; item: HandItem }
  left?:  { anchor: Entity; visual: Entity; item: HandItem }
}

const heldByPlayer = new Map<string, HandPair>()

const ITEM_TEXTURE: Record<Exclude<HandItem, 'none'>, string> = {
  baton:  'assets/scene/Images/Truncheon_clean_PNG.png',
  shield: 'assets/scene/Images/Shield_clean_PNG.png',
  bomb:   'assets/scene/Images/TNT_clean_PNG.png',
}

// Налаштування текстур предметів
const ITEM_ROLL: Record<Exclude<HandItem, 'none'>, Quaternion> = {
  baton:  Quaternion.fromEulerDegrees(0,   0, 90),
  shield: Quaternion.fromEulerDegrees(0,   0,  0),
  bomb:   Quaternion.fromEulerDegrees(0, 180,  0),
}
const ITEM_TILING: Record<Exclude<HandItem, 'none'>, {x:number; y:number}> = {
  baton:  { x: 0.94, y: 0.18 },
  shield: { x: 1,    y: 0.89 },
  bomb:   { x: 0.7,  y: 0.7  },
}
const ITEM_OFFSET: Record<Exclude<HandItem, 'none'>, {x:number; y:number}> = {
  baton:  { x: 0.03, y: 0.41 },
  shield: { x: 0,    y: 0.06 },
  bomb:   { x: 0.15, y: 0.15 },
}

// ── Transform of visual container relative to the hand bone ──────────────────
// ВАЖЛИВО: в hand anchor DCL → Z+ = до ліктя, Z- = до пальців/долоні.
// Всі предмети позиціонуються в від'ємному Z щоб опинитись у долоні.
function visualTransform(slot: HandSlot, item: Exclude<HandItem, 'none'>) {
  if (item === 'baton') {
    // scale(1,1,1) — розміри задаються явно в spawnVisualMesh (sx/sy per face)
    return {
      position: Vector3.create(0.04, 0.12, 0.25),
      rotation: Quaternion.fromEulerDegrees(90, 0, 0),
      scale:    Vector3.One(),
    }
  }
  if (item === 'shield') {
    return {
      position: Vector3.create(slot === 'left' ? -0.05 : 0.05, -0.02, -0.08),
      rotation: Quaternion.fromEulerDegrees(0, 270, 180),
      scale:    Vector3.One(),
    }
  }
  // bomb
  return {
    position: Vector3.create(0, 0.08, -0.12),
    rotation: Quaternion.Identity(),
    scale:    Vector3.One(),
  }
}

// Бокс із 6 площин (або 2 площини для щита) у LOCAL просторі visual-контейнера.
// parent має scale(1,1,1) → позиції дітей без спотворення.
// Кожна грань: явний scale(sx, sy, 1): sx=H, sy=W або D.
function spawnVisualMesh(parent: Entity, type: Exclude<HandItem, 'none'>): void {
  const tex    = ITEM_TEXTURE[type]
  const roll   = ITEM_ROLL[type]
  const tiling = ITEM_TILING[type]
  const offset = ITEM_OFFSET[type]
  const mat = {
    texture: tex, textureWrapMode: TextureWrapMode.TWM_CLAMP,
    textureTiling: tiling, textureOffset: offset,
    color: Color4.White(), roughness: 1, metallic: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
  }
  const Qm = (dir: Quaternion) => Quaternion.multiply(dir, roll)
  const Qe = Quaternion.fromEulerDegrees
  const V  = Vector3.create
  const f  = (pos: Vector3, rot: Quaternion, sx: number, sy: number) =>
    createEntity({ parent, position: pos, rotation: rot, scale: V(sx, sy, 1), mesh: 'plane', collider: false, material: mat })

  if (type === 'shield') {
    const SW = 0.75, SH = 1.0
    f(V(0, 0, +0.001), Qm(Qe(0, 180, 0)), SW, SH)  // front — Y=180 виправляє дзеркалення через Qe(0,270,180) контейнера
    f(V(0, 0, -0.001), roll,               SW, SH)  // back
  } else if (type === 'baton') {
    const W = 0.05, H = 0.6, D = 0.05
    f(V(    0,     0,    0  ), Qm(Qe(  0, 180, 0)), H, W)  // лицьова
    f(V(    0,     0,   -D  ), Qm(Qe(  0,   0, 0)), H, W)  // задня
    f(V( -W/2,     0,  -D/2 ), Qm(Qe(  0, -90, 0)), H, D)  // ліва
    f(V(  W/2,     0,  -D/2 ), Qm(Qe(  0,  90, 0)), H, D)  // права
    f(V(    0,   H/2,  -D/2 ), Qm(Qe(-90,   0, 0)), W, D)  // верх
    f(V(    0,  -H/2,  -D/2 ), Qm(Qe( 90,   0, 0)), W, D)  // низ
  } else {
    // bomb
    const S = 0.25
    f(V(    0,     0,    0  ), Qm(Qe(  0, 180, 0)), S, S)  // лицьова
    f(V(    0,     0,   -S  ), Qm(Qe(  0,   0, 0)), S, S)  // задня
    f(V( -S/2,     0,  -S/2 ), Qm(Qe(  0, -90, 0)), S, S)  // ліва
    f(V(  S/2,     0,  -S/2 ), Qm(Qe(  0,  90, 0)), S, S)  // права
    f(V(    0,   S/2,  -S/2 ), Qm(Qe(-90,   0, 0)), S, S)  // верх
    f(V(    0,  -S/2,  -S/2 ), Qm(Qe( 90,   0, 0)), S, S)  // низ
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function setHeldItem(
  sessionId: string,
  userId:    string,
  slot:      HandSlot,
  item:      HandItem,
) {
  // Власні предмети гравець не бачить на своєму аватарі — тільки інші гравці
  if (sessionId === getLocalState().mySessionId) return

  const pair = heldByPlayer.get(sessionId) ?? {}
  const cur  = pair[slot]

  if (cur && cur.item === item) return

  if (item === 'none') {
    if (cur) {
      removeEntityAndChildren(cur.visual)
      removeEntity(cur.anchor)
      delete pair[slot]
      if (!pair.right && !pair.left) heldByPlayer.delete(sessionId)
      else heldByPlayer.set(sessionId, pair)
    }
    return
  }

  if (cur) {
    removeEntityAndChildren(cur.visual)
    removeEntity(cur.anchor)
    delete pair[slot]
  }

  const anchor = engine.addEntity()
  AvatarAttach.create(anchor, {
    ...(userId ? { avatarId: userId } : {}),
    anchorPointId: slot === 'right'
      ? AvatarAnchorPointType.AAPT_RIGHT_HAND
      : AvatarAnchorPointType.AAPT_LEFT_HAND,
  })

  const tx     = visualTransform(slot, item)
  // Container — holds transform only; all meshes are children
  const visual = createEntity({
    parent: anchor, position: tx.position, rotation: tx.rotation,
    scale: tx.scale, collider: false,
  })

  spawnVisualMesh(visual, item)

  pair[slot] = { anchor, visual, item }
  heldByPlayer.set(sessionId, pair)
}

export function clearPlayerHands(sessionId: string) {
  const pair = heldByPlayer.get(sessionId)
  if (!pair) return
  if (pair.right) {
    removeEntityAndChildren(pair.right.visual)
    removeEntity(pair.right.anchor)
  }
  if (pair.left) {
    removeEntityAndChildren(pair.left.visual)
    removeEntity(pair.left.anchor)
  }
  heldByPlayer.delete(sessionId)
}

export function clearAllHands() {
  for (const sid of [...heldByPlayer.keys()]) clearPlayerHands(sid)
}

// NOTE: setItemTexture / clearItemTexture are no longer functional after the
// base+overlay refactor (visual is now a container entity, not a mesh entity).
// Textures are set at creation time via ITEM_TEXTURE. To change a texture,
// call setHeldItem('none') then setHeldItem(newItem) to respawn.
export function setItemTexture(_sessionId: string, _slot: HandSlot, _texturePath: string): void {}
export function clearItemTexture(_sessionId: string, _slot: HandSlot): void {}
