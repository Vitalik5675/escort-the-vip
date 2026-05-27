import { Entity, ColliderLayer } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { createEntity, makeClickable } from '../utils/entityFactory'
import { patchLocalState, getLocalState } from '../state/localState'
import { ARENA_WIDTH, ARENA_DEPTH, ARENA_CX, ARENA_CZ } from '../game/constants'

// ── Lobby zone (ground level, full arena footprint × 5 m tall) ───────────────
// Lobby occupies Y = 0..5 m, full X-Z footprint.
// Trigger zone is an invisible box covering the lobby; zone detection is done
// client-side using the player's tile position (Y < GAME_ZONE_Y).

export let lobbyRoot: Entity

/**
 * Вертикальна площина на правій стіні лобі.
 * Щоб змінити зображення пізніше:
 *   import { lobbyImagePlane } from './zones/lobby'
 *   import { updateMaterial } from './utils/entityFactory'
 *   updateMaterial(lobbyImagePlane, { texture: 'images/newImage.jpg' })
 */
export let lobbyImagePlane: Entity

/**
 * Чотири площини на лівій (захід) стіні лобі — для зображень/банерів.
 * Розташовані рівномірно по Z (7, 13, 19, 25 м) між кутовими колонами на Z=4 і Z=28.
 * Обернені на схід (нормаль +X → в лобі), кожна клікабельна — клік відкриває
 * full-screen UI-модалку з цим зображенням; повторний клік (або по backdrop)
 * закриває (state.lobbyImageModalUrl керує).
 */
export let lobbyLeftPlane1: Entity
export let lobbyLeftPlane2: Entity
export let lobbyLeftPlane3: Entity
export let lobbyLeftPlane4: Entity

// Decorative pillar inset from each arena corner.
const PILLAR_INSET = 4

/** Open the UI image-modal with `texture`, or close it if it's already showing this texture. */
function toggleLobbyImage(texture: string): void {
  const cur = getLocalState().lobbyImageModalUrl
  patchLocalState({ lobbyImageModalUrl: cur === texture ? '' : texture })
}

export function buildLobby() {
  lobbyRoot = createEntity({
    position: Vector3.create(0, 0, 0),
    collider: false
  })

  // Ground plane — matches arena footprint.
  createEntity({
    parent:   lobbyRoot,
    position: Vector3.create(ARENA_CX, 0.05, ARENA_CZ),
    scale:    Vector3.create(ARENA_WIDTH, 0.1, ARENA_DEPTH),
    mesh:     'box',
    material: { color: Color4.create(0.30, 0.30, 0.32, 1), roughness: 1, metallic: 0 },
    collider: 'box',
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
  })

  // Lobby lighting pillars — one per corner, PILLAR_INSET m from each edge.
  const corners: Array<[number, number]> = [
    [PILLAR_INSET,                PILLAR_INSET],
    [ARENA_WIDTH - PILLAR_INSET,  PILLAR_INSET],
    [PILLAR_INSET,                ARENA_DEPTH - PILLAR_INSET],
    [ARENA_WIDTH - PILLAR_INSET,  ARENA_DEPTH - PILLAR_INSET],
  ]
  for (const [px, pz] of corners) {
    createEntity({
      parent:   lobbyRoot,
      position: Vector3.create(px, 5.5, pz),
      scale:    Vector3.create(0.4, 11, 0.4),
      mesh:     'box',
      material: { color: Color4.create(0.5, 0.5, 0.55, 1), roughness: 1, metallic: 0 },
      collider: 'box',
      colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
    })
  }

  // Right-wall image plane — anchored to the east edge of the arena.
  lobbyImagePlane = createEntity({
    parent:   lobbyRoot,
    position: Vector3.create(ARENA_WIDTH - 4.21, 5.5, ARENA_CZ),
    rotation: Quaternion.fromEulerDegrees(0, 90, 0), // normal -X → faces into lobby
    scale:    Vector3.create(24, 11, 1),
    mesh:     'plane',
    material: { texture: 'assets/scene/Images/New_PB_ETV_The_game_horizontal.jpg', roughness: 1, metallic: 0 },
    collider: 'plane',
    colliderLayer: ColliderLayer.CL_PHYSICS
  })

  // ── Left-wall image planes — four panels on the west edge (X ≈ 4) ─────────
  // 4 × 6 м = 24 м перекриває увесь діапазон Z=4..28 між кутовими колонами.
  // Центри по Z: 7, 13, 19, 25 (each plane edge-to-edge).
  // Нормаль +X (Quaternion.fromEulerDegrees(0, -90, 0)) → дивиться в лобі.
  // colliderLayer додає CL_POINTER щоб raycast міг ловити клік (CL_PHYSICS
  // лишається для блокування рухів аватаром, не критично для площин-банерів).
  const LEFT_PLANE_X     = 4
  const LEFT_PLANE_Y     = 2
  const LEFT_PLANE_ROT   = Quaternion.fromEulerDegrees(0, -90, 0)
  const LEFT_PLANE_SCALE = Vector3.create(5, 3, 1)
  const LEFT_PLANE_LAYER = ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER

  // Dark backing board behind the four image planes — same material as the
  // spectator box walls (Color4(0.1, 0.12, 0.16, 1)). Slightly larger than the
  // four planes combined so it frames them: 24 m wide (Z = 4..28) × 4 m tall,
  // 0.1 m thin, positioned 0.1 m behind the planes (X = 3.9 so its +X face
  // hugs the planes' -X face at X = 4).
  createEntity({
    parent:   lobbyRoot,
    position: Vector3.create(3.9, LEFT_PLANE_Y, ARENA_DEPTH / 2),
    scale:    Vector3.create(0.1, 4, 24),
    mesh:     'box',
    material: { color: Color4.create(0.1, 0.12, 0.16, 1), roughness: 1, metallic: 0 },
    collider: 'box',
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER,
  })

  const leftPanels: Array<{ z: number; texture: string; setter: (e: Entity) => void }> = [
    { z: 7,  texture: 'assets/scene/Images/1_ETV_rules_1.jpg', setter: (e) => { lobbyLeftPlane1 = e } },
    { z: 13, texture: 'assets/scene/Images/2_ETV_rules_2.jpg', setter: (e) => { lobbyLeftPlane2 = e } },
    { z: 19, texture: 'assets/scene/Images/3_ETV_rules_3.jpg', setter: (e) => { lobbyLeftPlane3 = e } },
    { z: 25, texture: 'assets/scene/Images/4_ETV_rules_4.jpg', setter: (e) => { lobbyLeftPlane4 = e } },
  ]

  for (const panel of leftPanels) {
    const e = createEntity({
      parent:   lobbyRoot,
      position: Vector3.create(LEFT_PLANE_X, LEFT_PLANE_Y, panel.z),
      rotation: LEFT_PLANE_ROT,
      scale:    LEFT_PLANE_SCALE,
      mesh:     'plane',
      material: { texture: panel.texture, roughness: 1, metallic: 0 },
      collider: 'plane',
      colliderLayer: LEFT_PLANE_LAYER,
    })
    makeClickable(e, 'Click to view', () => toggleLobbyImage(panel.texture), 12)
    panel.setter(e)
  }

  // Lobby ambient sound is controlled by the zone-tracking system in index.ts
  // via loopSound('lobby_ambient') / stopSound('lobby_ambient').
  // It is NOT created here — soundManager.ts owns all audio entities.

  console.log('[Lobby] Built')
}
