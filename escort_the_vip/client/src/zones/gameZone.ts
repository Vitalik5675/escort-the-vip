import { ColliderLayer, AvatarModifierType, CameraType, MeshCollider, CameraModeArea, Entity } from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import {
  createEntity, createModifierArea
} from '../utils/entityFactory'
import {
  GAME_ZONE_Y, WALL_HEIGHT,
  ARENA_WIDTH, ARENA_DEPTH, ARENA_CX, ARENA_CZ
} from '../game/constants'

// Perimeter, floor under-platform, roof and trigger areas scale with the grid
// (ARENA_WIDTH / ARENA_DEPTH = GRID_COLS/ROWS × TILE_SIZE). Change those and
// everything below resizes; the scene.json parcels still need to cover the
// resulting footprint.

const ZONE_H = WALL_HEIGHT
const ZONE_Y = GAME_ZONE_Y

// Side perimeter wall thickness, and inset of the under-platform so its faces
// don't coincide with the perimeter walls.
const PERIM_T = 0.1

// Refs kept for applySceneConfig (called after server sends 'scene_config').
let _roofEntity:         Entity | null = null
let _cameraAreaEntity:   Entity | null = null

/**
 * Applies camera and roof-physics settings received from the server.
 * Called from index.ts on the 'scene_config' message — including every
 * hot-reload of server/config.json in any phase (lobby / countdown / playing /
 * ended). Both operations are safe to call repeatedly mid-match.
 */
export function applySceneConfig(firstPerson: boolean, roofPhysics: boolean): void {
  if (_roofEntity !== null) {
    MeshCollider.setBox(
      _roofEntity,
      roofPhysics
        ? ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
        : ColliderLayer.CL_POINTER
    )
  }

  // Add/remove the CameraModeArea component directly. The entity stays alive
  // (we attached a Transform in buildGameZone); only the component toggles.
  // SDK pattern: deleteFrom() is a no-op when the component isn't attached.
  if (_cameraAreaEntity !== null) {
    if (firstPerson) {
      CameraModeArea.createOrReplace(_cameraAreaEntity, {
        area: Vector3.create(ARENA_WIDTH, ZONE_H + 2, ARENA_DEPTH),
        mode: CameraType.CT_FIRST_PERSON,
      })
    } else {
      CameraModeArea.deleteFrom(_cameraAreaEntity)
    }
  }

  console.log(`[GameZone] scene_config — firstPerson=${firstPerson} roofPhysics=${roofPhysics}`)
}

export function buildGameZone() {
  const root = createEntity({ position: Vector3.create(0, 0, 0), collider: false })

  // Under-platform — inset PERIM_T on every side; top sits just below game floor.
  createEntity({
    parent:   root,
    position: Vector3.create(ARENA_CX, ZONE_Y - 2, ARENA_CZ),
    scale:    Vector3.create(ARENA_WIDTH - PERIM_T * 2, 3.9, ARENA_DEPTH - PERIM_T * 2),
    mesh:     'box',
    material: { color: Color4.create(0.18, 0.18, 0.22, 1), roughness: 1, metallic: 0 },
    collider: 'box',
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
  })

  const midY = ZONE_Y + ZONE_H / 2
  const wallOpts = {
    mesh:          'box'   as const,
    collider:      'box'   as const,
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER as ColliderLayer,
    material:      { color: Color4.create(0.15, 0.17, 0.22, 1), roughness: 1, metallic: 0 }
  }
  // South / North span full arena width; East / West are shortened by PERIM_T at
  // both ends so corners don't overlap.
  createEntity({ parent: root, ...wallOpts, position: Vector3.create(ARENA_CX, midY, PERIM_T / 2),                scale: Vector3.create(ARENA_WIDTH, ZONE_H, PERIM_T) })
  createEntity({ parent: root, ...wallOpts, position: Vector3.create(ARENA_CX, midY, ARENA_DEPTH - PERIM_T / 2),  scale: Vector3.create(ARENA_WIDTH, ZONE_H, PERIM_T) })
  createEntity({ parent: root, ...wallOpts, position: Vector3.create(PERIM_T / 2, midY, ARENA_CZ),                scale: Vector3.create(PERIM_T, ZONE_H, ARENA_DEPTH - PERIM_T * 2) })
  createEntity({ parent: root, ...wallOpts, position: Vector3.create(ARENA_WIDTH - PERIM_T / 2, midY, ARENA_CZ),  scale: Vector3.create(PERIM_T, ZONE_H, ARENA_DEPTH - PERIM_T * 2) })

  // Invisible roof collider — created with CL_POINTER only until the server's
  // 'scene_config' message arrives; applySceneConfig() adds CL_PHYSICS if enabled.
  _roofEntity = createEntity({
    parent:   root,
    position: Vector3.create(ARENA_CX, ZONE_Y + ZONE_H + 11, ARENA_CZ),
    scale:    Vector3.create(ARENA_WIDTH, 22, ARENA_DEPTH),
    collider: 'box',
    colliderLayer: ColliderLayer.CL_POINTER,
    mesh:     'box',
    material: { color: Color4.create(0, 0, 0, 0), transparencyMode: 1 },
    visible:  false
  })

  // Modifier area — 2 m wider than the arena on every side so edge cases still trigger.
  createModifierArea(
    root,
    Vector3.create(ARENA_CX, midY, ARENA_CZ),
    Vector3.create(ARENA_WIDTH + 2, ZONE_H + 5, ARENA_DEPTH + 2),
    [AvatarModifierType.AMT_DISABLE_PASSPORTS]
  )

  // First-person CameraModeArea host — entity is created with a Transform
  // positioned over the arena. The CameraModeArea component itself is added /
  // removed by applySceneConfig() based on server config (no component until
  // the server confirms firstPerson=true).
  _cameraAreaEntity = createEntity({
    parent:   root,
    position: Vector3.create(ARENA_CX, midY, ARENA_CZ),
    collider: false,
  })

  console.log('[GameZone] Built')
}
