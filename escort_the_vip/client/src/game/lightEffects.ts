import {
  engine, Entity, LightSource, MaterialTransparencyMode, BillboardMode
} from '@dcl/sdk/ecs'
import { Vector3, Color3, Color4 } from '@dcl/sdk/math'
import { createEntity, removeEntity, setVisible, updateMaterial, setPosition } from '../utils/entityFactory'
import { GAME_FLOOR_Y, tileToWorldX, tileToWorldZ, TILE_SIZE } from './constants'

// World-space light effects:
//   • per-player on-hit halo  (emissive sphere above each player, fades in 700 ms)
//   • VIP state light          (calm / hater-near / on-hit colour driven by HP)
//   • end-game effect          (pulsing red light spawned in the last 15 s)
//
// Halos are cached per session so repeated hits reuse the same entity rather
// than churning entities every swing. The VIP light is a single shared entity
// reconfigured each frame. The end-game light is created lazily on the first
// tick that crosses the 15-s threshold and torn down when the phase resets.

// ─────────────────────────────────────────────────────────────────────────────
// Per-player on-hit halo
// ─────────────────────────────────────────────────────────────────────────────

const HALO_FADE_MS         = 700
const HALO_BASE_COLOR      = Color3.create(1, 0.25, 0.25)
const HALO_PEAK_INTENSITY  = 6

interface HaloEntry {
  entity:      Entity
  remainingMs: number      // 0 = fully faded, halo invisible
  col:         number
  row:         number
}

const haloes = new Map<string, HaloEntry>()

export function triggerPlayerHitHalo(sessionId: string, col: number, row: number, damage: number): void {
  let h = haloes.get(sessionId)
  if (!h) {
    h = _createHalo(col, row)
    haloes.set(sessionId, h)
  }
  h.col = col
  h.row = row
  h.remainingMs = HALO_FADE_MS
  setVisible(h.entity, true)
  // Peak brightness scaled by hit magnitude (range 0.6×–1.4×).
  const scale = Math.max(0.6, Math.min(1.4, damage / 25))
  _updateHaloMaterial(h.entity, HALO_BASE_COLOR, HALO_PEAK_INTENSITY * scale)
  setPosition(h.entity, Vector3.create(tileToWorldX(col), GAME_FLOOR_Y + 2.4, tileToWorldZ(row)))
}

export function removePlayerHalo(sessionId: string): void {
  const h = haloes.get(sessionId)
  if (!h) return
  removeEntity(h.entity)
  haloes.delete(sessionId)
}

export function removeAllPlayerHaloes(): void {
  for (const sid of [...haloes.keys()]) removePlayerHalo(sid)
}

function _createHalo(col: number, row: number): HaloEntry {
  const entity = createEntity({
    position:  Vector3.create(tileToWorldX(col), GAME_FLOOR_Y + 2.4, tileToWorldZ(row)),
    scale:     Vector3.create(0.85, 0.85, 0.85),
    mesh:      'sphere',
    material: {
      color:             Color4.create(1, 0.4, 0.4, 0.45),
      emissiveColor:     HALO_BASE_COLOR,
      emissiveIntensity: 0,
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows:       false
    },
    collider:  false,
    billboard: BillboardMode.BM_ALL,
    visible:   false
  })
  return { entity, remainingMs: 0, col, row }
}

function _updateHaloMaterial(entity: Entity, color: Color3, intensity: number): void {
  updateMaterial(entity, {
    color:             Color4.create(color.r, color.g, color.b, 0.45),
    emissiveColor:     color,
    emissiveIntensity: intensity,
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    castShadows:       false
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// VIP state light
// ─────────────────────────────────────────────────────────────────────────────
//
// One persistent halo entity + one PointLight that hover over the VIP.
// State machine driven each frame from updateVipLight():
//
//   calm     — no hater within 2 tiles. Soft warm-white halo, low intensity.
//   warning  — at least one hater within 2 tiles. Pulsing orange halo,
//              intensity rises with hater proximity.
//   hit      — vip.lastDamageTime increased recently (within HIT_FLASH_MS).
//              Bright flash whose colour reflects VIP's remaining HP:
//                >66 % → yellow,  33–66 % → orange,  <33 % → deep red.

const VIP_HALO_Y_OFFSET   = 2.6
const VIP_HIT_FLASH_MS    = 900
const VIP_HATER_RADIUS    = 2   // tiles
const VIP_LIGHT_RANGE     = 6   // metres

interface VipLightState {
  haloEntity:  Entity
  lightEntity: Entity
  lastHitAt:   number
  active:      boolean
}

let vipState: VipLightState | null = null

function _ensureVipLight(): VipLightState {
  if (vipState) return vipState
  const haloEntity = createEntity({
    position:  Vector3.create(0, GAME_FLOOR_Y + VIP_HALO_Y_OFFSET, 0),
    scale:     Vector3.create(1.4, 1.4, 1.4),
    mesh:      'sphere',
    material: {
      color:             Color4.create(1, 1, 1, 0.35),
      emissiveColor:     Color3.White(),
      emissiveIntensity: 1.5,
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows:       false
    },
    collider:  false,
    billboard: BillboardMode.BM_ALL,
    visible:   false
  })
  const lightEntity = createEntity({
    position: Vector3.create(0, GAME_FLOOR_Y + VIP_HALO_Y_OFFSET, 0),
    visible:  false
  })
  LightSource.createOrReplace(lightEntity, {
    active:    true,
    color:     Color3.White(),
    intensity: 4000,
    range:     VIP_LIGHT_RANGE,
    shadow:    false,
    type:      { $case: 'point', point: {} }
  })
  vipState = { haloEntity, lightEntity, lastHitAt: 0, active: false }
  return vipState
}

export function notifyVipHit(): void {
  const s = _ensureVipLight()
  s.lastHitAt = Date.now()
}

export function clearVipLight(): void {
  if (!vipState) return
  removeEntity(vipState.haloEntity)
  removeEntity(vipState.lightEntity)
  vipState = null
}

interface VipUpdateInput {
  active:           boolean
  col:              number
  row:              number
  hpFrac:           number       // 0..1
  haterTilesNearby: number       // count of haters within VIP_HATER_RADIUS Chebyshev tiles
}

export function updateVipLight(inp: VipUpdateInput): void {
  if (!inp.active) {
    if (vipState && vipState.active) {
      setVisible(vipState.haloEntity, false)
      setVisible(vipState.lightEntity, false)
      vipState.active = false
    }
    return
  }
  const s = _ensureVipLight()
  s.active = true
  setVisible(s.haloEntity, true)
  setVisible(s.lightEntity, true)

  const x = tileToWorldX(inp.col)
  const z = tileToWorldZ(inp.row)
  setPosition(s.haloEntity,  Vector3.create(x, GAME_FLOOR_Y + VIP_HALO_Y_OFFSET, z))
  setPosition(s.lightEntity, Vector3.create(x, GAME_FLOOR_Y + VIP_HALO_Y_OFFSET, z))

  const now      = Date.now()
  const hitAgeMs = now - s.lastHitAt
  const inHit    = hitAgeMs < VIP_HIT_FLASH_MS

  let color: Color3
  let haloIntensity: number
  let lightIntensity: number

  if (inHit) {
    // Bright flash, colour by remaining HP.
    color = _hpFlashColor(inp.hpFrac)
    const t = 1 - hitAgeMs / VIP_HIT_FLASH_MS     // 1 → 0 across flash window
    haloIntensity  = 2.5 + 6 * t
    lightIntensity = 6000 + 14000 * t
  } else if (inp.haterTilesNearby > 0) {
    // Warning: orange pulse. Pulse rate rises with proximity (more haters → faster).
    color = Color3.create(1.0, 0.45, 0.15)
    const pulse = 0.5 + 0.5 * Math.sin(now / 250)
    haloIntensity  = 2.0 + 2.0 * pulse * Math.min(1, inp.haterTilesNearby * 0.6)
    lightIntensity = 5000 + 4000 * pulse
  } else {
    // Calm: subtle warm-white glow.
    color = Color3.create(1.0, 0.9, 0.7)
    haloIntensity  = 1.2
    lightIntensity = 2500
  }

  updateMaterial(s.haloEntity, {
    color:             Color4.create(color.r, color.g, color.b, 0.35),
    emissiveColor:     color,
    emissiveIntensity: haloIntensity,
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    castShadows:       false
  })
  const light = LightSource.getMutableOrNull(s.lightEntity)
  if (light) {
    light.color     = color
    light.intensity = lightIntensity
  }
}

function _hpFlashColor(hpFrac: number): Color3 {
  if (hpFrac > 0.66) return Color3.create(1.0, 0.95, 0.3)   // yellow
  if (hpFrac > 0.33) return Color3.create(1.0, 0.5,  0.15)  // orange
  return Color3.create(1.0, 0.15, 0.15)                     // deep red
}

// ─────────────────────────────────────────────────────────────────────────────
// End-game effect (last 15 s)
// ─────────────────────────────────────────────────────────────────────────────
//
// Pulsing red point light placed at the centre of the game arena while the
// timer is in the final 15 s of the playing phase. Created lazily, torn down
// when the phase changes back to anything else.

const END_LIGHT_THRESHOLD_S = 15
const END_LIGHT_RANGE       = 32
const ARENA_CENTRE_TILE     = 8
const END_LIGHT_Y           = GAME_FLOOR_Y + 5

let endLightEntity: Entity | null = null

export function updateEndGameLight(timeRemaining: number, phase: string): void {
  const active = phase === 'playing' && timeRemaining > 0 && timeRemaining <= END_LIGHT_THRESHOLD_S
  if (!active) {
    if (endLightEntity) {
      removeEntity(endLightEntity)
      endLightEntity = null
    }
    return
  }
  if (!endLightEntity) {
    endLightEntity = createEntity({
      position: Vector3.create(
        ARENA_CENTRE_TILE * TILE_SIZE,
        END_LIGHT_Y,
        ARENA_CENTRE_TILE * TILE_SIZE
      )
    })
    LightSource.createOrReplace(endLightEntity, {
      active:    true,
      color:     Color3.create(1, 0.2, 0.15),
      intensity: 8000,
      range:     END_LIGHT_RANGE,
      shadow:    false,
      type:      { $case: 'point', point: {} }
    })
  }
  // Pulse faster as the clock runs down (1.5 Hz at 15 s → 4 Hz at 0 s).
  const urgency = 1 - timeRemaining / END_LIGHT_THRESHOLD_S
  const rate    = 1.5 + urgency * 2.5
  const t       = 0.5 + 0.5 * Math.sin(Date.now() / 1000 * rate * Math.PI)
  const light   = LightSource.getMutableOrNull(endLightEntity)
  if (light) light.intensity = 4000 + 16000 * t
}

// ─────────────────────────────────────────────────────────────────────────────
// Halo fade tick
// ─────────────────────────────────────────────────────────────────────────────

engine.addSystem((dt: number) => {
  const dms = dt * 1000
  for (const h of haloes.values()) {
    if (h.remainingMs <= 0) continue
    h.remainingMs = Math.max(0, h.remainingMs - dms)
    if (h.remainingMs === 0) {
      setVisible(h.entity, false)
      continue
    }
    const t = h.remainingMs / HALO_FADE_MS    // 1 → 0
    _updateHaloMaterial(h.entity, HALO_BASE_COLOR, HALO_PEAK_INTENSITY * t * t)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers exposed for callers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count haters within VIP_HATER_RADIUS Chebyshev tiles of (vipCol, vipRow).
 * Reads the Colyseus player map passed in by the caller (so we don't depend
 * on a specific room reference here).
 */
export function countNearbyHaters(
  vipCol: number, vipRow: number,
  players: Iterable<{ team: string; tileCol: number; tileRow: number; isAlive: boolean; zone: string }>
): number {
  let n = 0
  for (const p of players) {
    if (p.team !== 'hater' || !p.isAlive || p.zone !== 'game') continue
    const dc = Math.abs(p.tileCol - vipCol)
    const dr = Math.abs(p.tileRow - vipRow)
    if (Math.max(dc, dr) <= VIP_HATER_RADIUS) n++
  }
  return n
}

// Force-disable VIP light + clear all haloes (e.g. on game reset).
export function resetAllLightEffects(): void {
  if (vipState) {
    setVisible(vipState.haloEntity, false)
    setVisible(vipState.lightEntity, false)
    vipState.active = false
  }
  removeAllPlayerHaloes()
  if (endLightEntity) {
    removeEntity(endLightEntity)
    endLightEntity = null
  }
}

