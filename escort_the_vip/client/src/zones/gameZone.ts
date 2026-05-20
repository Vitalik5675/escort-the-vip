import { ColliderLayer, AvatarModifierType, CameraType } from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import {
  createEntity, createModifierArea, createCameraArea, setVisible
} from '../utils/entityFactory'
import { GAME_ZONE_Y, WALL_HEIGHT } from '../game/constants'

// ── Game zone (31.8×3×31.8 m at Y=15..18, centred in 32×32 m parcel) ─────────
// Also creates:
//   - Under-platform (32×4×32 m, Y=11..15)
//   - Side walls (0.1×3×32 m ×4)
//   - Invisible roof collider (32×22×32 m, Y=18..40)
//   - AvatarModifierArea for slow-walk + passport disable inside zone
//   - CameraModeArea for first-person inside zone

const ZONE_H = WALL_HEIGHT    // 3 m
const ZONE_Y = GAME_ZONE_Y    // 15 m

export function buildGameZone() {
  const root = createEntity({ position: Vector3.create(0, 0, 0), collider: false })

  // ── Under-platform: 31.8×3.9×31.8 m ──────────────────────────────────────
  // Inset 0.1 m on all sides to avoid face coincidence with perimeter walls;
  // top at Y≈14.95, just under game floor (actual floor handled by maze.ts).
  createEntity({
    parent:   root,
    position: Vector3.create(16, 13, 16),
    scale:    Vector3.create(31.8, 3.9, 31.8),
    mesh:     'box',
    material: { color: Color4.create(0.18, 0.18, 0.22, 1), roughness: 1, metallic: 0 },
    collider: 'box',
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
  })

  // ── Side perimeter walls (0.1×3×32 m each) ────────────────────────────────
  const midY     = ZONE_Y + ZONE_H / 2   // 16.5
  const wallOpts = {
    mesh:          'box'   as const,
    collider:      'box'   as const,
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER as ColliderLayer,
    material:      { color: Color4.create(0.15, 0.17, 0.22, 1), roughness: 1, metallic: 0 }
  }
  // South (Z = 0)
  createEntity({ parent: root, ...wallOpts, position: Vector3.create(16, midY, 0.05),   scale: Vector3.create(32, ZONE_H, 0.1) })
  // North (Z = 32)
  createEntity({ parent: root, ...wallOpts, position: Vector3.create(16, midY, 31.95),  scale: Vector3.create(32, ZONE_H, 0.1) })
  // West (X = 0) — shortened in Z by 0.1 m each end to avoid corner overlap with S/N walls
  createEntity({ parent: root, ...wallOpts, position: Vector3.create(0.05, midY, 16),   scale: Vector3.create(0.1, ZONE_H, 31.8) })
  // East (X = 32)
  createEntity({ parent: root, ...wallOpts, position: Vector3.create(31.95, midY, 16),  scale: Vector3.create(0.1, ZONE_H, 31.8) })

  // ── Invisible roof collider (Y=18..40) ────────────────────────────────────
  createEntity({
    parent:   root,
    position: Vector3.create(16, 29, 16),
    scale:    Vector3.create(32, 22, 32),
    collider: 'box',
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER,
    mesh:     'box',
    material: { color: Color4.create(0, 0, 0, 0), transparencyMode: 1 },
    visible:  false
  })

  // ── Avatar modifier — disable passports inside game zone ──────────────────
  // Generous bounds (34×8×34) so players on the edge or top of a wall still
  // trigger the modifier. Centred at the game-zone midpoint.
  createModifierArea(
    root,
    Vector3.create(16, ZONE_Y + ZONE_H / 2, 16),
    Vector3.create(34, ZONE_H + 5, 34),
    [AvatarModifierType.AMT_DISABLE_PASSPORTS]
  )

  // ── Camera: first-person inside game zone ─────────────────────────────────
  createCameraArea(
    root,
    Vector3.create(16, ZONE_Y + ZONE_H / 2, 16),
    Vector3.create(32, ZONE_H + 2, 32),
    CameraType.CT_FIRST_PERSON
  )

  console.log('[GameZone] Built')
}
