import {
  engine, Entity, LightSource
} from '@dcl/sdk/ecs'
import { Vector3, Color3, Color4 } from '@dcl/sdk/math'
import { createEntity, removeEntity, setVisible, updateMaterial, setPosition } from '../utils/entityFactory'
import { GAME_FLOOR_Y, tileToWorldX, tileToWorldZ, TILE_SIZE } from './constants'

// World-space light effects:
//   • VIP state light  (calm / hater-near / on-hit, colour driven by HP)
//   • end-game effect  (pulsing red light spawned in the last 15 s)
//
// Per-player on-hit feedback is HUD-only (see index.ts damage tracker +
// ui.tsx bottom-centre panel) so spectators always see the watched player's
// damage in their own UI rather than relying on a tiny world-space halo.

// ─────────────────────────────────────────────────────────────────────────────
// VIP state light — tall cylinder beacon + PointLight
// ─────────────────────────────────────────────────────────────────────────────
//
//   calm     — no hater within VIP_HATER_RADIUS tiles. Warm-white, low intensity.
//   warning  — at least one hater nearby. Pulsing orange (faster with proximity).
//              Stays warning until the last hater leaves the radius.
//   hit      — vip.lastDamageTime increased within VIP_HIT_FLASH_MS. Bright flash
//              coloured by remaining HP fraction (yellow → orange → deep red).
//
// The visible beacon is a 10 m tall translucent cylinder so it pokes above the
// maze walls and is visible from anywhere on the arena.

const VIP_BEACON_HEIGHT_M    = 20
const VIP_BEACON_RADIUS_M    = 0.6
// Lift the bottom of the beacon above the 3 m maze walls so it floats over
// the labyrinth instead of intersecting any wall it stands next to.
const VIP_BEACON_BOTTOM_OFF  = 3
const VIP_HIT_FLASH_MS      = 900
const VIP_HATER_RADIUS      = 2     // tiles (Chebyshev) — used for beacon pulse
const VIP_LIGHT_RANGE       = 6

// Stripe (wall-box / column) alert thresholds — independent from beacon HP colour.
const STRIPE_HIT_MS         = 3_000   // red lasts this long after a VIP hit
const STRIPE_RADIUS_NEAR    = 2       // orange: hater within 2 tiles
const STRIPE_RADIUS_FAR     = 4       // yellow: hater within 4 tiles

// Stripe palette
const _STRIPE_WHITE  = Color3.create(1.0, 1.0, 1.0)
const _STRIPE_YELLOW = Color3.create(1.0, 0.85, 0.0)
const _STRIPE_ORANGE = Color3.create(1.0, 0.40, 0.0)
const _STRIPE_RED    = Color3.create(1.0, 0.05, 0.05)

interface VipLightState {
  beaconEntity: Entity
  lightEntity:  Entity
  lastHitAt:    number
  active:       boolean
}

let vipState: VipLightState | null = null

function _ensureVipLight(): VipLightState {
  if (vipState) return vipState
  // The cylinder is anchored at the VIP tile, raised so its base sits just above
  // the floor and the column stretches VIP_BEACON_HEIGHT_M metres straight up.
  // DCL's unit cylinder mesh is 1 m tall — scale.y maps directly to metres.
  const beaconEntity = createEntity({
    position: Vector3.create(0, GAME_FLOOR_Y + VIP_BEACON_BOTTOM_OFF + VIP_BEACON_HEIGHT_M / 2, 0),
    scale:    Vector3.create(VIP_BEACON_RADIUS_M * 2, VIP_BEACON_HEIGHT_M, VIP_BEACON_RADIUS_M * 2),
    mesh:     'cylinder',
    material: {
      color:             Color4.create(1, 0.85, 0, 1),
      emissiveColor:     Color3.create(1, 0.85, 0),
      emissiveIntensity: 2.5,
      castShadows:       false
    },
    collider: false,
    visible:  false
  })
  const lightEntity = createEntity({
    position: Vector3.create(0, GAME_FLOOR_Y + 2.6, 0),
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
  vipState = { beaconEntity, lightEntity, lastHitAt: 0, active: false }
  return vipState
}

export function notifyVipHit(): void {
  const s = _ensureVipLight()
  s.lastHitAt = Date.now()
}

export function clearVipLight(): void {
  if (!vipState) return
  removeEntity(vipState.beaconEntity)
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

/** Update VIP light effects. Returns the current beacon colour (for stripe sync), or null when inactive. */
export function updateVipLight(inp: VipUpdateInput): Color3 | null {
  if (!inp.active) {
    if (vipState && vipState.active) {
      setVisible(vipState.beaconEntity, false)
      setVisible(vipState.lightEntity,  false)
      vipState.active = false
    }
    return null
  }
  const s = _ensureVipLight()
  s.active = true
  setVisible(s.beaconEntity, true)
  setVisible(s.lightEntity,  true)

  const x = tileToWorldX(inp.col)
  const z = tileToWorldZ(inp.row)
  setPosition(s.beaconEntity, Vector3.create(x, GAME_FLOOR_Y + VIP_BEACON_BOTTOM_OFF + VIP_BEACON_HEIGHT_M / 2, z))
  setPosition(s.lightEntity,  Vector3.create(x, GAME_FLOOR_Y + 2.6, z))

  const now      = Date.now()
  const hitAgeMs = now - s.lastHitAt
  const inHit    = hitAgeMs < VIP_HIT_FLASH_MS

  // HP-based colour is always the baseline: yellow (full) → orange → red (critical)
  const hpColor = _hpFlashColor(inp.hpFrac)
  let color: Color3
  let lightIntensity: number

  if (inHit) {
    // Bright flash of the HP colour on hit
    color = hpColor
    const t = 1 - hitAgeMs / VIP_HIT_FLASH_MS
    lightIntensity = 8000 + 16000 * t
  } else if (inp.haterTilesNearby > 0) {
    // HP colour pulsing — hater nearby
    color = hpColor
    const pulse = 0.5 + 0.5 * Math.sin(now / (200 - inp.haterTilesNearby * 30))
    lightIntensity = 6000 + 6000 * pulse
  } else {
    // HP colour calm
    color = hpColor
    lightIntensity = 3500
  }

  updateMaterial(s.beaconEntity, {
    color:             Color4.create(color.r, color.g, color.b, 1),
    emissiveColor:     color,
    emissiveIntensity: inHit ? 6.0 : (inp.haterTilesNearby > 0 ? 4.0 : 2.5),
    castShadows:       false
  })

  const light = LightSource.getMutableOrNull(s.lightEntity)
  if (light) {
    light.color     = color
    light.intensity = lightIntensity
  }
  return color
}

function _hpFlashColor(hpFrac: number): Color3 {
  if (hpFrac > 0.66) return Color3.create(1.0, 0.95, 0.0)   // bright yellow
  if (hpFrac > 0.33) return Color3.create(1.0, 0.35, 0.0)   // vivid orange
  return Color3.create(1.0, 0.05, 0.05)                     // bright red
}

// ─────────────────────────────────────────────────────────────────────────────
// End-game effect (last 15 s)
// ─────────────────────────────────────────────────────────────────────────────

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

// Avoid an unused-import warning on engine — referenced once below.
void engine

// ─────────────────────────────────────────────────────────────────────────────
// Hater proximity helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count haters within VIP_HATER_RADIUS Chebyshev tiles of (vipCol, vipRow).
 * Caller passes the Colyseus player iterable so we don't depend on a specific
 * room reference here.
 */
export function countNearbyHaters(
  vipCol: number, vipRow: number,
  players: Iterable<{ team: string; tileCol: number; tileRow: number; isAlive: boolean; zone: string }>,
  radius: number = VIP_HATER_RADIUS
): number {
  let n = 0
  for (const p of players) {
    if (p.team !== 'hater' || !p.isAlive || p.zone !== 'game') continue
    const dc = Math.abs(p.tileCol - vipCol)
    const dr = Math.abs(p.tileRow - vipRow)
    if (Math.max(dc, dr) <= radius) n++
  }
  return n
}

/**
 * Compute the stripe colour for concrete walls and junction columns.
 * Priority (high → low):
 *   red    — VIP was hit within the last STRIPE_HIT_MS ms
 *   orange — at least one hater within STRIPE_RADIUS_NEAR (2) tiles of VIP
 *   yellow — at least one hater within STRIPE_RADIUS_FAR  (4) tiles of VIP
 *   white  — calm (no nearby haters)
 * Returns null when VIP is not active.
 */
export function getStripeColor(
  vipActive: boolean,
  hatersNear: number,    // within STRIPE_RADIUS_NEAR (2)
  hatersFar:  number     // within STRIPE_RADIUS_FAR  (4)
): Color3 | null {
  if (!vipActive) return null
  const s = vipState
  if (s && Date.now() - s.lastHitAt < STRIPE_HIT_MS) return _STRIPE_RED
  if (hatersNear > 0) return _STRIPE_ORANGE
  if (hatersFar  > 0) return _STRIPE_YELLOW
  return _STRIPE_WHITE
}

export function resetAllLightEffects(): void {
  if (vipState) {
    setVisible(vipState.beaconEntity, false)
    setVisible(vipState.lightEntity,  false)
    vipState.active = false
  }
  if (endLightEntity) {
    removeEntity(endLightEntity)
    endLightEntity = null
  }
  if (safetyBeaconEntity) {
    setVisible(safetyBeaconEntity, false)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety-zone beacon — green column over the safety zone
// ─────────────────────────────────────────────────────────────────────────────
//
// Visible only to the local player; rules layered (any one is enough):
//   1. timeRemaining ≤ SAFETY_BEACON_ALL_S  → visible to EVERYONE
//   2. someone of my team is on a safety tile → visible to MY TEAM
//   3. I'm the bodyguard escorting VIP AND timeRemaining ≤ SAFETY_BEACON_BG_S
//      → visible to me only
//
// Outside of 'playing' phase the beacon is always hidden.
//
// Sized to match VIP_BEACON_HEIGHT_M but coloured green and slightly thicker
// so it reads as "safe destination" instead of "track this thing".

const SAFETY_BEACON_HEIGHT_M     = VIP_BEACON_HEIGHT_M
const SAFETY_BEACON_BOTTOM_OFF   = VIP_BEACON_BOTTOM_OFF
const SAFETY_BEACON_RADIUS_M     = 1.4
const SAFETY_BEACON_ALL_S        = 120   // 2 minutes — visible to all
const SAFETY_BEACON_BG_S         = 180   // 3 minutes — visible to escorting BG

let safetyBeaconEntity: Entity | null = null
let safetyBeaconCenterX = 0
let safetyBeaconCenterZ = 0
let safetyBeaconConfigured = false

/**
 * Position the safety beacon over the centre of the safety zone. Called from
 * maze.ts whenever safety tiles change (maze_rebuild). When tiles is empty,
 * the beacon is hidden until the next valid set arrives.
 */
export function configureSafetyBeacon(tiles: ReadonlyArray<{ col: number; row: number }>): void {
  if (tiles.length === 0) {
    safetyBeaconConfigured = false
    if (safetyBeaconEntity) setVisible(safetyBeaconEntity, false)
    return
  }
  let minCol = Infinity, maxCol = -Infinity
  let minRow = Infinity, maxRow = -Infinity
  for (const t of tiles) {
    if (t.col < minCol) minCol = t.col
    if (t.col > maxCol) maxCol = t.col
    if (t.row < minRow) minRow = t.row
    if (t.row > maxRow) maxRow = t.row
  }
  safetyBeaconCenterX = ((minCol + maxCol + 1) / 2) * TILE_SIZE
  safetyBeaconCenterZ = ((minRow + maxRow + 1) / 2) * TILE_SIZE

  if (!safetyBeaconEntity) {
    safetyBeaconEntity = createEntity({
      position: Vector3.create(
        safetyBeaconCenterX,
        GAME_FLOOR_Y + SAFETY_BEACON_BOTTOM_OFF + SAFETY_BEACON_HEIGHT_M / 2,
        safetyBeaconCenterZ,
      ),
      scale: Vector3.create(
        SAFETY_BEACON_RADIUS_M * 2,
        SAFETY_BEACON_HEIGHT_M,
        SAFETY_BEACON_RADIUS_M * 2,
      ),
      mesh: 'box',
      material: {
        color:             Color4.create(0.1, 0.9, 0.15, 1),
        emissiveColor:     Color3.create(0.1, 0.85, 0.15),
        emissiveIntensity: 1.5,
        castShadows:       false,
      },
      collider: false,
      visible:  false,
    })
  } else {
    setPosition(safetyBeaconEntity, Vector3.create(
      safetyBeaconCenterX,
      GAME_FLOOR_Y + SAFETY_BEACON_BOTTOM_OFF + SAFETY_BEACON_HEIGHT_M / 2,
      safetyBeaconCenterZ,
    ))
  }
  safetyBeaconConfigured = true
}

export interface SafetyBeaconInput {
  phase:           string
  timeRemaining:   number
  myTeam:          string
  mySessionId:     string
  vipFollowerId:   string
  /** Sessions whose team matches `myTeam` AND who are currently on a safety tile. */
  alliesInSafety:  boolean
}

/**
 * Update visibility of the safety-zone beacon for the local player.
 * Called every frame from the world-light ECS system in index.ts.
 */
export function updateSafetyBeacon(inp: SafetyBeaconInput): void {
  if (!safetyBeaconEntity || !safetyBeaconConfigured) return

  // Hide entirely outside the active match.
  if (inp.phase !== 'playing') {
    setVisible(safetyBeaconEntity, false)
    return
  }

  // Rule 1: everyone sees it under SAFETY_BEACON_ALL_S.
  let visible = inp.timeRemaining > 0 && inp.timeRemaining <= SAFETY_BEACON_ALL_S

  // Rule 2: my team sees it whenever someone of my team is on a safety tile.
  if (!visible && (inp.myTeam === 'bodyguard' || inp.myTeam === 'hater') && inp.alliesInSafety) {
    visible = true
  }

  // Rule 3: the escorting bodyguard sees it under SAFETY_BEACON_BG_S.
  if (!visible
      && inp.myTeam === 'bodyguard'
      && inp.mySessionId !== ''
      && inp.mySessionId === inp.vipFollowerId
      && inp.timeRemaining > 0
      && inp.timeRemaining <= SAFETY_BEACON_BG_S) {
    visible = true
  }

  setVisible(safetyBeaconEntity, visible)
}

export function clearSafetyBeacon(): void {
  if (safetyBeaconEntity) {
    removeEntity(safetyBeaconEntity)
    safetyBeaconEntity = null
  }
  safetyBeaconConfigured = false
}
