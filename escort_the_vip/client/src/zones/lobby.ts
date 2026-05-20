import { Entity, ColliderLayer } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { createEntity } from '../utils/entityFactory'

// ── Lobby zone (ground level, 32×5×32 m) ─────────────────────────────────────
// Lobby occupies Y = 0..5 m, full X-Z footprint.
// Trigger zone is an invisible box covering the lobby; zone detection is done
// client-side using the player's tile position (Y < GAME_ZONE_Y).

export let lobbyRoot: Entity

/**
 * Вертикальна площина на правій стіні лобі (X≈32).
 * Щоб змінити зображення пізніше:
 *   import { lobbyImagePlane } from './zones/lobby'
 *   import { updateMaterial } from './utils/entityFactory'
 *   updateMaterial(lobbyImagePlane, { texture: 'images/newImage.jpg' })
 */
export let lobbyImagePlane: Entity

export function buildLobby() {
  lobbyRoot = createEntity({
    position: Vector3.create(0, 0, 0),
    collider: false
  })

  // Ground plane
  createEntity({
    parent:   lobbyRoot,
    position: Vector3.create(16, 0.05, 16),
    scale:    Vector3.create(32, 0.1, 32),
    mesh:     'box',
    material: { color: Color4.create(0.30, 0.30, 0.32, 1), roughness: 1, metallic: 0 },
    collider: 'box',
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
  })

  // Lobby lighting pillars (visual decor)
  for (const [px, pz] of [[4, 4], [28, 4], [4, 28], [28, 28]]) {
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

  // ── Right-wall image plane ────────────────────────────────────────────────
  // Тонкий box 10 м (Z) × 4 м (Y) × 0.05 м (X) на правій стіні лобі.
  // Box не потребує ротації — текстура на лицевій стороні (-X) автоматично
  // дивиться всередину лобі.
  // Щоб змінити зображення:
  //   updateMaterial(lobbyImagePlane, { texture: 'assets/scene/Images/newImage.jpg' })
  lobbyImagePlane = createEntity({
    parent:   lobbyRoot,
    position: Vector3.create(27.79, 5.5, 16),
    rotation: Quaternion.fromEulerDegrees(0, 90, 0), // нормаль -X → дивиться всередину лобі
    scale:    Vector3.create(24, 11, 1),               // 16 м (Z-ширина) × 4 м (висота)
    mesh:     'plane',
    material: { texture: 'assets/scene/Images/New_PB_Celeres_Pixel_Security_horizontal.jpg', roughness: 1, metallic: 0 },
    collider: 'plane',
    colliderLayer: ColliderLayer.CL_PHYSICS
  })

  // Lobby ambient sound is controlled by the zone-tracking system in index.ts
  // via loopSound('lobby_ambient') / stopSound('lobby_ambient').
  // It is NOT created here — soundManager.ts owns all audio entities.

  console.log('[Lobby] Built')
}
