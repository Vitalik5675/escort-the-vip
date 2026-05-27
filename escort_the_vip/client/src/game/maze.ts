import { engine, Entity, Transform, MeshRenderer, MeshCollider, Material, TextShape, BillboardMode, PointerEvents, PointerEventType, InputAction, VisibilityComponent, ColliderLayer, MaterialTransparencyMode, TextureWrapMode } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4, Color3 } from '@dcl/sdk/math'
import { createEntity, makeClickable, makeHoverable, setEKeyHint, clearEKeyHint, setVisible, removeEntity, removeEntityAndChildren, syncEntityPointerEvents, delay } from '../utils/entityFactory'
import { consumeWallEKey } from './combatInput'
import { playSound, loopSound, stopSound } from '../audio/soundManager'
import { isLocalAdjacentToWall, isLocalNearTile, isLocalOnTile } from '../utils/adjacency'
import { animateWallRise, animateDoorSlide } from '../utils/transformUtils'
import { sendToRoom } from '../colyseus-client'
import { getLocalState, patchLocalState } from '../state/localState'
import { configureSafetyBeacon } from './lightEffects'
import {
  GRID_COLS, GRID_ROWS, TILE_SIZE, GAME_ZONE_Y, WALL_HEIGHT, WALL_THICKNESS,
  WALL_COUNT, H_WALL_COUNT, hWallIndex, vWallIndex, wallSidesTiles,
  hWallWorldPos, vWallWorldPos, H_WALL_SCALE, V_WALL_SCALE,
  ARENA_WIDTH, ARENA_DEPTH, ARENA_CX, ARENA_CZ,
  WALL_NONE, WALL_CONCRETE, WALL_HEDGE, WALL_WOOD_WALL, WALL_WOOD_DOOR,
  STATE_SOLID, STATE_OPEN, STATE_DESTROYED, STATE_BLOCKED,
  tileToWorldX, tileToWorldZ
} from './constants'

// ── Wall materials ────────────────────────────────────────────────────────────
// Distinct, fully matte palette — easy to tell types apart at a glance.
// Concrete = grey, hedge = green, wood wall + wood door = warm browns.

const WALL_COLORS: Record<number, Color4> = {
  [WALL_CONCRETE]:   Color4.create(0.55, 0.55, 0.55, 1),
  [WALL_HEDGE]:      Color4.create(0.18, 0.55, 0.15, 1),
  [WALL_WOOD_WALL]: Color4.create(0.55, 0.36, 0.16, 1),
  [WALL_WOOD_DOOR]:  Color4.create(0.65, 0.45, 0.25, 1),
}

// Stripe colour — matches the VIP beacon calm state (bright gold).
// Applied as a 20 cm horizontal band at mid-height on concrete walls and posts.
const STRIPE_COLOR4  = Color4.create(1.0, 0.85, 0.0, 1)
const STRIPE_COLOR3  = Color3.create(1.0, 0.85, 0.0)
// Max hover/click distance for wall interactions (≈ cardinal-adjacent tile)
const WALL_CLICK_DIST = 2.0

const STRIPE_HEIGHT   = 0.20   // metres tall
const STRIPE_PROTRUDE = 0.01   // 5 mm protrusion per face — prevents z-fighting, imperceptible

// Door accent palette. The emissive layer is the per-team visual indicator
// for the door-claim system:
//   • amber  → default closed door, no claim relevant to this viewer
//   • red    → blocked for this viewer's team (must have ack'd by clicking
//              first, or the door is a system-locked one with no claim)
//   • blue   → claimed by viewer's team, no enemy adjacent on either side
// Open doors are hidden via the slide animation instead of recoloured.
const ACCENT_AMBER  = { emissive: Color3.create(0.60, 0.45, 0.10), intensity: 0.25 }
const ACCENT_RED    = { emissive: Color3.create(0.70, 0.05, 0.05), intensity: 0.50 }
const ACCENT_BLUE   = { emissive: Color3.create(0.10, 0.45, 0.85), intensity: 0.50 }
const ACCENT_NONE   = { emissive: Color3.Black(),                 intensity: 0 }

// Context the client needs to colour a door correctly. Built once per
// onStateChange so the per-door computation stays cheap.
export interface DoorViewContext {
  myTeam:           string                                // 'bodyguard'|'hater'|'none'
  wallStates:       ArrayLike<number>
  wallClaimTeams:   ArrayLike<number>                     // 0/1/2
  wallClaimAck:     ArrayLike<number>                     // bitfield
  // True iff at least one player on the OPPOSING team to `claimTeam` stands
  // on either tile flanking the door. Implemented as a callback so the caller
  // can use whatever spatial index it likes.
  isEnemyAdjacent:  (wallIdx: number, claimTeam: number) => boolean
}

function teamCode(team: string): number {
  if (team === 'bodyguard') return 1
  if (team === 'hater')     return 2
  return 0
}

function doorAccent(type: number, idx: number, ctx: DoorViewContext): { emissive: Color3; intensity: number } {
  if (type !== WALL_WOOD_DOOR) return ACCENT_NONE
  const state      = ctx.wallStates[idx] | 0
  const claimTeam  = ctx.wallClaimTeams[idx] | 0
  const ackBits    = ctx.wallClaimAck[idx] | 0
  const myCode     = teamCode(ctx.myTeam)

  if (claimTeam === 0) {
    // No active claim. STATE_BLOCKED with no claim is an edge-case system lock
    // (e.g. a door blocked by a server mechanic with no team assigned) →
    // show red as a generic "locked" signal. Normal VIP-room doors start
    // STATE_SOLID (amber) so this branch is not triggered for them at game start.
    if (state === STATE_BLOCKED) return ACCENT_RED
    return ACCENT_AMBER
  }

  if (myCode === claimTeam) {
    // Viewer is on the blocking team. Door colour stays neutral until there's
    // an actual reason to flag it — i.e. an enemy stands on the other side
    // and is being held back by the claim. Without that, walking up to a door
    // we already own would needlessly recolour it.
    if (ctx.isEnemyAdjacent(idx, claimTeam)) return ACCENT_BLUE
    return ACCENT_AMBER
  }
  if (myCode !== 0 && myCode !== claimTeam) {
    // Viewer is on the blocked team. Red only after this team has poked the
    // door (ack bit set), so a chaser who hasn't tried yet still sees normal.
    if ((ackBits & myCode) !== 0) return ACCENT_RED
    return ACCENT_AMBER
  }
  // No team (lobby / spectator) — show neutral closed.
  return ACCENT_AMBER
}

// ── State ─────────────────────────────────────────────────────────────────────

interface WallEntity {
  entity:     Entity
  type:       number
  state:      number
  isH:        boolean
  wRow:       number
  wCol:       number
  finalY:     number
}

const wallEntities    = new Map<number, WallEntity>()   // wallIndex → WallEntity
const junctionEntities = new Map<number, Entity>()        // junctionKey → Entity
const wallStripeEntities     = new Map<number, Entity>()  // wallIndex → stripe Entity (concrete only)
const junctionStripeEntities = new Map<number, Entity>()  // junctionKey → stripe Entity

// Latest door-view context, set by refreshDoorMaterials. syncWall/spawnWall
// fall back to a neutral context when nothing has refreshed yet (e.g. first
// frame after maze_rebuild).
let latestDoorCtx: DoorViewContext | null = null
const NEUTRAL_DOOR_CTX: DoorViewContext = {
  myTeam: 'none',
  wallStates:     { length: 0 } as ArrayLike<number>,
  wallClaimTeams: { length: 0 } as ArrayLike<number>,
  wallClaimAck:   { length: 0 } as ArrayLike<number>,
  isEnemyAdjacent: () => false,
}
let floorEntity: Entity | null = null
let safeZoneEntity: Entity | null = null
// Live snapshot of the current safety tiles — used by anyAllyInSafetyZone()
// so per-frame visibility checks don't have to re-iterate over maze_rebuild data.
let _safetyTileKeys: Set<number> = new Set()
/** Encode (col, row) into a single uint16-ish key for fast Set lookups. */
function safetyKey(col: number, row: number): number { return row * GRID_COLS + col }
/** True if any player of `team` (alive, in-game) currently stands on a safety tile. */
export function anyAllyInSafetyZone(
  team: string,
  players: Iterable<{ team: string; tileCol: number; tileRow: number; isAlive: boolean; zone: string }>,
): boolean {
  if (team !== 'bodyguard' && team !== 'hater') return false
  if (_safetyTileKeys.size === 0) return false
  for (const p of players) {
    if (p.team !== team || !p.isAlive || p.zone !== 'game') continue
    if (_safetyTileKeys.has(safetyKey(p.tileCol, p.tileRow))) return true
  }
  return false
}
let mazeRoot: Entity | null = null
const safeZoneOverlays: Entity[] = []

// ── Maze root visibility ──────────────────────────────────────────────────────

export function setMazeVisible(v: boolean) {
  if (mazeRoot) setVisible(mazeRoot, v)
}

// ── Floor ─────────────────────────────────────────────────────────────────────

export function createGameFloor() {
  if (floorEntity) return
  floorEntity = createEntity({
    position: Vector3.create(ARENA_CX, GAME_ZONE_Y, ARENA_CZ),
    scale:    Vector3.create(ARENA_WIDTH, 0.1, ARENA_DEPTH),
    mesh:     'box',
    material: { color: Color4.create(0.25, 0.25, 0.28, 1), roughness: 1, metallic: 0 },
    collider: 'box',
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
  })
}

// ── Safe-zone overlay ─────────────────────────────────────────────────────────
// The actual safety tiles arrive in maze_rebuild, so we stamp a green visual
// marker on each of them. Removed (and rebuilt) on every layout change.

export function setSafetyTiles(tiles: ReadonlyArray<{ col: number; row: number }>) {
  // Pass tiles to the world-light module so it can position/recycle the green
  // safety-zone beacon (and stash the centre for the visibility rules).
  configureSafetyBeacon(tiles)
  // Stash a flat keyset for per-frame ally-presence checks.
  _safetyTileKeys = new Set(tiles.map((t) => safetyKey(t.col, t.row)))
  for (const e of safeZoneOverlays) removeEntity(e)
  safeZoneOverlays.length = 0
  if (tiles.length === 0) { safeZoneEntity = null; return }

  // Render a SINGLE overlay covering the bounding box of all safety tiles —
  // gaps between adjacent tiles are gone (the area between tile centres
  // stays green) and the patch sits inset from the outer perimeter so it
  // doesn't bleed through the arena walls.
  let minCol = Infinity, maxCol = -Infinity
  let minRow = Infinity, maxRow = -Infinity
  for (const t of tiles) {
    if (t.col < minCol) minCol = t.col
    if (t.col > maxCol) maxCol = t.col
    if (t.row < minRow) minRow = t.row
    if (t.row > maxRow) maxRow = t.row
  }
  // 0.1 m inset from the outer bbox → for a 2×2 (4×4 m) safety zone the
  // overlay ends up exactly 3.8×3.8 m, fully covering the inner area while
  // staying off the perimeter walls.
  const OUTER_INSET = 0.1
  const widthM   = (maxCol - minCol + 1) * TILE_SIZE - OUTER_INSET * 2
  const heightM  = (maxRow - minRow + 1) * TILE_SIZE - OUTER_INSET * 2
  const centerX  = ((minCol + maxCol + 1) / 2) * TILE_SIZE
  const centerZ  = ((minRow + maxRow + 1) / 2) * TILE_SIZE

  const ent = createEntity({
    position: Vector3.create(centerX, GAME_ZONE_Y + 0.05, centerZ),
    scale:    Vector3.create(widthM, 0.05, heightM),
    mesh:     'box',
    material: {
      color: Color4.create(0.1, 0.9, 0.2, 1),
      emissiveColor: Color3.create(0.1, 0.8, 0.15),
      emissiveIntensity: 0.4,
      roughness: 1, metallic: 0
    },
    collider: false
  })
  safeZoneOverlays.push(ent)
  safeZoneEntity = ent
}

// ── Build/rebuild wall entities ────────────────────────────────────────────────

// ── Stripe colour sync ────────────────────────────────────────────────────────
// Called every frame from the VIP-light ECS system. Updates all concrete-wall
// and junction-post stripe materials only when the colour actually changes
// (state transitions: calm → warning → hit) so material writes are rare.

let _lastStripeKey = ''

export function syncStripeColor(color: Color3 | null): void {
  const c = color ?? STRIPE_COLOR3
  const key = c.r.toFixed(3) + ',' + c.g.toFixed(3) + ',' + c.b.toFixed(3)
  if (key === _lastStripeKey) return
  _lastStripeKey = key

  const c4: { r: number; g: number; b: number; a: number } = { r: c.r, g: c.g, b: c.b, a: 1 }
  const mat = { albedoColor: c4, emissiveColor: c, emissiveIntensity: 2.0, roughness: 1, metallic: 0, castShadows: false }
  for (const e of wallStripeEntities.values())     Material.setPbrMaterial(e, mat)
  for (const e of junctionStripeEntities.values()) Material.setPbrMaterial(e, mat)
}

// ── Wall E-key labels (bomb / baton priority, all destructible wall types) ────

// HP fraction per wall index — updated by syncWallHP().
// Used to gate baton/hand hints on hedges and doors by HP threshold.
const _wallHPFrac = new Map<number, number>()

// Server gating thresholds (must match server/src/game/constants.ts):
//   hedge:     bomb always | baton < 50% | hand < 25%
//   wood-door: bomb/baton always | hand < 50%
//   wood-wall: any source always
function _wallEKeyHint(type: number, hasBomb: boolean, hasBaton: boolean, wallIdx: number): string | null {
  const frac = _wallHPFrac.get(wallIdx) ?? 1   // unknown → assume full HP

  if (hasBomb) {
    if (type === WALL_WOOD_DOOR) return 'Set trap'
    if (type === WALL_WOOD_WALL) return 'Set bomb'
    if (type === WALL_HEDGE)     return 'Set bomb'
  } else if (hasBaton) {
    if (type === WALL_WOOD_DOOR) return 'Destroy door'
    if (type === WALL_WOOD_WALL) return 'Destroy wall'
    if (type === WALL_HEDGE)     return frac < 0.5 ? 'Destroy bush' : null  // baton blocked at full HP
  } else {
    // Bare hands
    if (type === WALL_WOOD_WALL) return 'Attack wall'
    if (type === WALL_HEDGE)     return frac < 0.25 ? 'Attack bush' : null
    if (type === WALL_WOOD_DOOR) return frac < 0.5  ? 'Break door'  : null
  }
  return null
}

/**
 * Creates the E-key callback for a specific wall entity.
 * Handles bomb-on-wall (Priority 2) and baton-wall-attack (Priority 3).
 * Calls consumeWallEKey() so the global combatInput handler is suppressed.
 * Does NOT consume while defending so combatInput can still handle Prio 1.
 */
function makeWallEKeyCallback(wallIdx: number): (entity: Entity) => void {
  return (_entity: Entity) => {
    const s = getLocalState()
    if (s.myDefending) return           // let combatInput handle defend-exit
    consumeWallEKey()
    // Show wall HP panel on E press (only for walls with HP).
    patchLocalState({ wallHpVisible: true, hoveredWallIdx: wallIdx, hoveredWallExpiresAt: Date.now() + 6_000 })
    if (s.myLeftHand === 'bomb') {
      sendToRoom('place_bomb', { wallIdx })
      return
    }
    // Hand or baton — server applies per-wall-type gating rules and
    // sends 'attack_blocked' with a toast if the attack isn't allowed yet.
    if (isLocalAdjacentToWall(wallIdx)) {
      sendToRoom('attack_wall', { wallIdx })
    }
  }
}

/**
 * Refresh E-key hint on ALL destructible walls based on player inventory.
 * Uses setEKeyHint (entityFactory) so both IA_POINTER and IA_PRIMARY events
 * are stored in one PointerEvents array — DCL renders both hints at once.
 * Bomb takes priority over baton.
 */
export function refreshWallEKeyLabels(rightHand: string, leftHand: string): void {
  const hasBomb  = leftHand  === 'bomb'
  const hasBaton = rightHand === 'baton'
  for (const [wallIdx, w] of wallEntities.entries()) {
    const hint = _wallEKeyHint(w.type, hasBomb, hasBaton, wallIdx)
    if (hint) setEKeyHint(w.entity, hint, WALL_CLICK_DIST, makeWallEKeyCallback(wallIdx))
    else       clearEKeyHint(w.entity)
  }
}

export function buildMaze(wallTypes: number[], wallStates: number[]) {
  for (const w of wallEntities.values()) {
    removeEntity(w.entity)
  }
  wallEntities.clear()

  for (const e of junctionEntities.values()) removeEntity(e)
  junctionEntities.clear()

  for (const e of wallStripeEntities.values()) removeEntity(e)
  wallStripeEntities.clear()
  for (const e of junctionStripeEntities.values()) removeEntity(e)
  junctionStripeEntities.clear()

  for (let i = 0; i < WALL_COUNT; i++) {
    const type  = wallTypes[i]
    const state = wallStates[i]
    if (type === WALL_NONE) continue
    if (state === STATE_DESTROYED) continue

    spawnWallEntity(i, type, state, true)
  }

  buildJunctionPosts(wallTypes, wallStates)
}

// ── Sync wall changes from server ─────────────────────────────────────────────

// Doors slide down by their own height to "open" — the mesh disappears
// into the floor instead of just toggling visibility.
const DOOR_SLIDE_MS = 1000
function doorOpenY(closedY: number): number { return closedY - WALL_HEIGHT }

export function syncWall(idx: number, newType: number, newState: number) {
  const existing = wallEntities.get(idx)

  const shouldExist = newType !== WALL_NONE && newState !== STATE_DESTROYED
  const isDoor      = newType === WALL_WOOD_DOOR
  const doorOpen    = isDoor && newState === STATE_OPEN

  if (!shouldExist && existing) {
    // Remove synchronously — the previous attempts at a "sink" animation could
    // silently never complete (Tween TS_COMPLETED never fired in some cases),
    // leaving the wall visually present forever even after HP=0 on the server.
    wallEntities.delete(idx)
    const stripeEnt = wallStripeEntities.get(idx)
    if (stripeEnt) { removeEntity(stripeEnt); wallStripeEntities.delete(idx) }
    const ls = getLocalState()
    if (ls.hoveredWallIdx === idx) {
      patchLocalState({ hoveredWallIdx: -1, hoveredWallExpiresAt: 0 })
    }
    removeEntity(existing.entity)
    return
  }

  if (shouldExist && !existing) {
    spawnWallEntity(idx, newType, newState, false)
    return
  }

  if (existing) {
    const wasDoor      = existing.type === WALL_WOOD_DOOR
    const wasDoorOpen  = wasDoor && existing.state === STATE_OPEN

    existing.type  = newType
    existing.state = newState
    const ctx = latestDoorCtx ?? NEUTRAL_DOOR_CTX
    const accent = doorAccent(newType, idx, ctx)
    Material.setPbrMaterial(existing.entity, {
      albedoColor:        WALL_COLORS[newType] ?? Color4.Gray(),
      emissiveColor:      accent.emissive,
      emissiveIntensity:  accent.intensity,
      roughness: 1,
      metallic: 0,
      castShadows: !doorOpen
    })

    // Doors stay visible — the slide animation lowers/raises the mesh instead
    // of toggling visibility. Non-door walls just stay visible while present.
    setVisible(existing.entity, true)

    if (isDoor) {
      if (doorOpen && !wasDoorOpen) {
        // Open: drop collider immediately, slide mesh into the floor.
        MeshCollider.deleteFrom(existing.entity)
        PointerEvents.deleteFrom(existing.entity)        // no collider while open → suppress pointer-events warning
        animateDoorSlide(existing.entity, doorOpenY(existing.finalY), DOOR_SLIDE_MS)
        playSound('door_open')
      } else if (!doorOpen && wasDoorOpen) {
        // Close: slide mesh back up; collider returns at the start so a player
        // standing in the doorway gets pushed out as the door rises.
        MeshCollider.setBox(existing.entity, ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER)
        syncEntityPointerEvents(existing.entity)         // collider restored → reinstate click/hover/E-key
        animateDoorSlide(existing.entity, existing.finalY, DOOR_SLIDE_MS)
        playSound('door_close')
      } else if (doorOpen) {
        MeshCollider.deleteFrom(existing.entity)
        PointerEvents.deleteFrom(existing.entity)        // no collider while open → suppress pointer-events warning
      } else {
        MeshCollider.setBox(existing.entity, ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER)
        syncEntityPointerEvents(existing.entity)         // collider present → reinstate click/hover/E-key
      }
    } else {
      MeshCollider.setBox(existing.entity, ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER)
    }
  }
}

// ── Spawn single wall entity ──────────────────────────────────────────────────

function spawnWallEntity(idx: number, type: number, state: number, instant: boolean) {
  const isH   = idx < H_WALL_COUNT
  const wRow  = isH ? (idx / GRID_COLS) | 0 : ((idx - H_WALL_COUNT) / (GRID_COLS - 1)) | 0
  const wCol  = isH ? idx % GRID_COLS : (idx - H_WALL_COUNT) % (GRID_COLS - 1)

  const pos   = isH ? hWallWorldPos(wRow, wCol) : vWallWorldPos(wRow, wCol)
  const scale = isH ? H_WALL_SCALE : V_WALL_SCALE

  const isDoor     = type === WALL_WOOD_DOOR
  const isDoorOpen = isDoor && state === STATE_OPEN
  const color = WALL_COLORS[type] ?? Color4.Gray()
  const accent = doorAccent(type, idx, latestDoorCtx ?? NEUTRAL_DOOR_CTX)

  // Open doors render lowered into the floor (slide-down position) instead of
  // being hidden, so when they later close we can slide them back up smoothly.
  const renderY = isDoorOpen ? doorOpenY(pos.y) : pos.y

  const entity = createEntity({
    position: Vector3.create(pos.x, instant ? renderY : GAME_ZONE_Y - 3, pos.z),
    scale:    Vector3.create(scale.x, scale.y, scale.z),
    mesh:     'box',
    material: {
      color,
      emissiveColor: accent.emissive,
      emissiveIntensity: accent.intensity,
      roughness: 1, metallic: 0,
      castShadows: !isDoorOpen
    },
    collider: isDoorOpen ? false : 'box',
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER,
    visible:  true
  })

  if (!instant) {
    animateWallRise(entity, renderY)
  }

  // ── Pointer interactions ────────────────────────────────────────────────
  // Both LMB ("Open door") and E-key ("Destroy door") hints are stored in a
  // SINGLE PointerEvents component array, so DCL renders them simultaneously.
  // syncPointerEvents() in entityFactory builds that array from the three
  // independent registries: clickRegistry (IA_POINTER), eKeyRegistry
  // (IA_PRIMARY), hoverRegistry (hover enter/leave).
  //
  //   • makeClickable  → IA_POINTER PET_DOWN; polling fires left-click cb
  //   • setEKeyHint    → IA_PRIMARY PET_DOWN; polling fires E-key cb
  //   • makeHoverable  → HOVER_ENTER/LEAVE;   polling fires hover cb
  //
  // refreshWallEKeyLabels() calls setEKeyHint/clearEKeyHint on all walls
  // whenever the player's inventory changes.
  if (type === WALL_WOOD_DOOR) {
    makeClickable(entity, 'Open door', () => {
      if (!isLocalAdjacentToWall(idx)) return
      sendToRoom('interact_door', { wallIdx: idx })
    }, WALL_CLICK_DIST)
    // E-key hint ("Destroy door" / "Set trap") set by refreshWallEKeyLabels
  }
  // WALL_WOOD_WALL and WALL_HEDGE: only E-key (refreshWallEKeyLabels).
  // entityFactory adds a silent IA_POINTER stub automatically when an
  // entity has setEKeyHint but no makeClickable, so DCL treats the entity
  // as interactive and fires hover + IA_PRIMARY events correctly.

  // Clear wall HP panel when cursor leaves the wall.
  if (type === WALL_HEDGE || type === WALL_WOOD_WALL || type === WALL_WOOD_DOOR) {
    makeHoverable(entity, 8, (_e, entered) => {
      if (!entered && getLocalState().hoveredWallIdx === idx) {
        patchLocalState({ hoveredWallIdx: -1, hoveredWallExpiresAt: 0, wallHpVisible: false })
      }
    })
  }

  // Open doors spawned with no collider — suppress pointer events to avoid
  // DCL "Missing MeshCollider" warnings. Registries stay populated so
  // syncEntityPointerEvents() restores everything when the door closes.
  if (isDoorOpen) {
    PointerEvents.deleteFrom(entity)
  }


  wallEntities.set(idx, { entity, type, state, isH, wRow, wCol, finalY: pos.y })

  // Gold stripe on concrete walls — a 20 cm band at mid-height, slightly
  // thicker than the wall so it's visible from both faces.
  if (type === WALL_CONCRETE) {
    const stripeY = GAME_ZONE_Y + WALL_HEIGHT / 2
    const sx = isH ? scale.x                     : scale.x + STRIPE_PROTRUDE
    const sz = isH ? scale.z + STRIPE_PROTRUDE   : scale.z
    const stripeEnt = createEntity({
      position: Vector3.create(pos.x, stripeY, pos.z),
      scale:    Vector3.create(sx, STRIPE_HEIGHT, sz),
      mesh:     'box',
      material: {
        color:             STRIPE_COLOR4,
        emissiveColor:     STRIPE_COLOR3,
        emissiveIntensity: 2.0,
        roughness:         1,
        metallic:          0,
        castShadows:       false
      },
      collider: false,
      visible:  true
    })
    wallStripeEntities.set(idx, stripeEnt)
  }
}

// Wall HP / required-tools is now displayed in the bottom-center UI panel
// (see ui.tsx) when the player hovers a destructible wall — no more floating
// labels in the world. These two stubs are kept so existing callers compile
// without changes; they intentionally do nothing.
/**
 * Update the client-side HP fraction for a wall and refresh its E-key hint
 * if the new fraction crosses a gating threshold (hedge/door only).
 * Called from index.ts whenever state.wallHP changes.
 */
export function syncWallHP(idx: number, type: number, hp: number, maxHp: number): void {
  const frac = maxHp > 0 ? hp / maxHp : 1
  const prev = _wallHPFrac.get(idx) ?? 1
  _wallHPFrac.set(idx, frac)

  // Only hedge and wood-door have HP-conditional hints; skip concrete / none.
  if (type !== WALL_HEDGE && type !== WALL_WOOD_DOOR) return

  // Re-check whether the hint changed (e.g. crossed the 50% threshold).
  const w = wallEntities.get(idx)
  if (!w) return
  const s      = getLocalState()
  const hasBomb  = s.myLeftHand  === 'bomb'
  const hasBaton = s.myRightHand === 'baton'
  // Only update hints when HP crosses a gating threshold (0.5 for baton on
  // hedge/door, 0.25 for bare hands on hedge). Skip the update otherwise
  // to avoid redundant PointerEvents writes every tick.
  const crossedThreshold = (prev >= 0.5  && frac < 0.5)  || (prev < 0.5  && frac >= 0.5)
                        || (prev >= 0.25 && frac < 0.25) || (prev < 0.25 && frac >= 0.25)
  if (!crossedThreshold) return

  const hint = _wallEKeyHint(type, hasBomb, hasBaton, idx)
  if (hint) setEKeyHint(w.entity, hint, WALL_CLICK_DIST, makeWallEKeyCallback(idx))
  else      clearEKeyHint(w.entity)
}
export function clearWallHPOverlays() { /* no-op */ }

// Re-tint every door entity based on the latest viewer context. Cheap: walks
// only the door entities (a small subset of `wallEntities`) and updates their
// PBR material — meshes / colliders are untouched. Caller is expected to
// supply `isEnemyAdjacent` already keyed against the latest player snapshot.
export function refreshDoorMaterials(ctx: DoorViewContext) {
  latestDoorCtx = ctx
  for (const [idx, w] of wallEntities) {
    if (w.type !== WALL_WOOD_DOOR) continue
    const baseColor = WALL_COLORS[w.type] ?? Color4.Gray()
    const accent    = doorAccent(w.type, idx, ctx)
    const isOpen    = w.state === STATE_OPEN
    Material.setPbrMaterial(w.entity, {
      albedoColor:       baseColor,
      emissiveColor:     accent.emissive,
      emissiveIntensity: accent.intensity,
      roughness: 1, metallic: 0,
      castShadows: !isOpen,
    })
  }
}

// ── Bomb world overlays ───────────────────────────────────────────────────────
// Mesh + countdown text rendered on the bomb's tile until detonation.

interface BombOverlay {
  entity:    Entity
  textEntity: Entity
  fuseEndsAt: number
  armed:      boolean   // false = door-trap; tickBombOverlays skips text updates for traps
}
const bombOverlays = new Map<string, BombOverlay>()

export function spawnBombOverlay(key: string, col: number, row: number, fuseEndsAt: number, armed = true) {
  if (bombOverlays.has(key)) return
  // Лічимо armed бомби ДО додавання: якщо це перша → запускаємо loop
  const armedCountBefore = armed
    ? [...bombOverlays.values()].filter(o => o.armed).length
    : 0
  const wx = tileToWorldX(col), wz = tileToWorldZ(row)

  // Root entity — no mesh, no collider. All visuals are child plane entities
  // created by spawnTilePlaneBox so the bomb looks identical to a floor bomb.
  const entity = createEntity({
    position: Vector3.create(wx, GAME_ZONE_Y + 0.5, wz),
    collider: false,
  })

  // Textured 6-plane box (same rendering approach as floor items).
  // S=0.35 matches the floor-item bomb size so players recognise it instantly.
  const S = 0.35
  spawnTilePlaneBox(entity, S, S, S, 'bomb')

  // Trap (unarmed) bombs: small box hitbox — same approach as floor item pickups.
  // CL_POINTER only (no CL_PHYSICS). Small scale (0.5) avoids blocking player
  // movement — DCL's engine blocks movement with large CL_POINTER colliders
  // when they match the player capsule dimensions.
  if (!armed) {
    const pickupHitbox = createEntity({
      parent:        entity,
      position:      Vector3.create(0, 0.0, 0),
      scale:         Vector3.create(0.5, 0.5, 0.5),
      collider:      'box',
      colliderLayer: ColliderLayer.CL_POINTER,
    })
    makeClickable(pickupHitbox, 'Pick up bomb', () => {
      if (!isLocalOnTile(col, row)) return
      sendToRoom('pickup_bomb', { key })
    }, 2.0)
  }

  // Обчислюємо залишок відразу з реального fuseEndsAt, а не хардкодимо '5'.
  // Важливо для реконнекту: бомба могла бути закладена 3 с тому — тоді
  // перший кадр показав би '5' замість '2' до виправлення tickBombOverlays.
  const initialText = armed
    ? String(Math.max(0, Math.ceil((fuseEndsAt - Date.now()) / 1000)))
    : 'TRAP'

  const textEntity = createEntity({
    position: Vector3.create(wx, GAME_ZONE_Y + 1.3, wz),
    text:     {
      // Armed: реальний залишок у секундах; tickBombOverlays оновлює щокадру.
      // Unarmed (door-trap): 'TRAP' — fuseEndsAt=0, тік не перезаписує.
      value:        initialText,
      fontSize:     1.8,
      color:        armed ? Color4.create(1, 0.5, 0.2, 1) : Color4.create(0.85, 0.3, 1, 1),
      outlineColor: Color4.Black(),
      outlineWidth: 0.18,
    },
    billboard: BillboardMode.BM_Y,
    collider: false,
  })
  bombOverlays.set(key, { entity, textEntity, fuseEndsAt, armed })

  // Запускаємо тікання тільки для першої armed бомби.
  // Якщо вже є інші armed бомби — loop вже грає, не перезапускаємо.
  if (armed && armedCountBefore === 0) loopSound('bomb_countdown', undefined, 2.0)
}

export function removeBombOverlay(key: string) {
  const o = bombOverlays.get(key)
  if (!o) return
  // removeEntityAndChildren instead of removeEntity — the root entity now has
  // child plane entities (6 textured faces from spawnTilePlaneBox) and possibly
  // a pickup-hitbox child. engine.removeEntityWithChildren cleans all of them.
  // The click/hover registries for any registered descendants are also purged.
  removeEntityAndChildren(o.entity)
  removeEntity(o.textEntity)
  const wasArmed = o.armed
  bombOverlays.delete(key)

  // Якщо прибрали armed бомбу і більше жодної armed нема → зупиняємо тікання
  if (wasArmed) {
    const remainingArmed = [...bombOverlays.values()].filter(b => b.armed).length
    if (remainingArmed === 0) stopSound('bomb_countdown')
  }
}

// Per-frame countdown refresh, called from index.ts game system.
// Only armed (countdown) bombs are updated — door-trap (armed=false) bombs
// display a static 'TRAP' label and have fuseEndsAt=0, so updating their
// text would incorrectly overwrite 'TRAP' with '0'.
export function tickBombOverlays(now: number) {
  for (const [_key, o] of bombOverlays) {
    if (!o.armed) continue   // door-trap: keep 'TRAP' label, never overwrite
    const remainingS = Math.max(0, Math.ceil((o.fuseEndsAt - now) / 1000))
    const ts = TextShape.getMutableOrNull(o.textEntity)
    if (ts) ts.text = String(remainingS)
  }
}

export function clearAllBombOverlays() {
  for (const k of [...bombOverlays.keys()]) removeBombOverlay(k)
  // removeBombOverlay вже зупиняє loop коли не лишилось armed бомб,
  // але якщо Map пуста одразу — зупиняємо явно для надійності
  stopSound('bomb_countdown')
}

// ── Explosion visual effect ───────────────────────────────────────────────────
// Емісивна сфера на тайлі вибуху: розширюється і згасає за ~0.7 секунди.
// Викликається з index.ts при отриманні повідомлення 'bomb_explode'.

const EXPLOSION_DURATION = 0.7   // seconds
const EXPLOSION_MAX_SCALE = 3.2  // metres (≈ 1.6 tiles radius, менше ніж реальний радіус 2 тайли)

export function spawnExplosionEffect(col: number, row: number): void {
  const wx = tileToWorldX(col)
  const wz = tileToWorldZ(row)

  const sphere = createEntity({
    position: Vector3.create(wx, GAME_ZONE_Y + 0.9, wz),
    scale:    Vector3.create(0.4, 0.4, 0.4),
    mesh:     'sphere',
    material: {
      color:             Color4.create(1, 0.65, 0, 1),
      emissiveColor:     Color3.create(1, 0.5, 0),
      emissiveIntensity: 5.0,
      roughness:         1,
      metallic:          0,
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    },
    collider: false,
  })

  let elapsed = 0
  const tick = (dt: number) => {
    elapsed += dt
    const t = Math.min(elapsed / EXPLOSION_DURATION, 1)
    const s = 0.4 + t * (EXPLOSION_MAX_SCALE - 0.4)
    const alpha = 1 - t

    const tr = Transform.getMutableOrNull(sphere)
    if (tr) tr.scale = Vector3.create(s, s, s)

    Material.setPbrMaterial(sphere, {
      albedoColor:       Color4.create(1, 0.65 - t * 0.4, 0, alpha),
      emissiveColor:     Color3.create(1, 0.5 * (1 - t), 0),
      emissiveIntensity: 5.0 * (1 - t),
      roughness:         1,
      metallic:          0,
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })

    if (t >= 1) {
      engine.removeSystem(tick)
      removeEntity(sphere)
    }
  }
  engine.addSystem(tick)
}

// ── Junction posts ────────────────────────────────────────────────────────────

function buildJunctionPosts(wallTypes: number[], wallStates: number[]) {
  for (let r = 0; r < GRID_ROWS - 1; r++) {
    for (let c = 0; c < GRID_COLS - 1; c++) {
      syncJunction(r, c, wallTypes, wallStates)
    }
  }
}

// "Visually active" = wall mesh is currently rendered in the scene. Mirrors
// the `shouldExist && !doorOpen` check inside syncWall so a junction never
// hangs in the air next to a destroyed wall, an open door, or a NONE slot.
function isWallVisuallyActive(type: number, state: number): boolean {
  if (type === WALL_NONE) return false
  if (state === STATE_DESTROYED) return false
  if (type === WALL_WOOD_DOOR && state === STATE_OPEN) return false
  return true
}

// Spawn / remove a single junction post based on whether any of its 4 adjacent
// walls are still active. Called from buildJunctionPosts (full rebuild) and
// from refreshJunctionsAroundWall (per-wall change during gameplay).
function syncJunction(r: number, c: number, wallTypes: number[], wallStates: number[]) {
  if (r < 0 || r >= GRID_ROWS - 1 || c < 0 || c >= GRID_COLS - 1) return

  const key = r * GRID_COLS + c
  const adjIdxs = [
    hWallIndex(r, c),
    hWallIndex(r, c + 1),
    vWallIndex(r, c),
    vWallIndex(r + 1, c),
  ]
  const hasActiveAdjacent = adjIdxs.some(i =>
    i >= 0 && i < WALL_COUNT && isWallVisuallyActive(wallTypes[i], wallStates[i])
  )

  const existing = junctionEntities.get(key)
  if (!hasActiveAdjacent) {
    if (existing) { removeEntity(existing); junctionEntities.delete(key) }
    const existingStripe = junctionStripeEntities.get(key)
    if (existingStripe) { removeEntity(existingStripe); junctionStripeEntities.delete(key) }
    return
  }
  if (existing) return   // junction already there, nothing to do

  const junctionY    = GAME_ZONE_Y + WALL_HEIGHT / 2
  const concreteColor = WALL_COLORS[WALL_CONCRETE] ?? Color4.Gray()
  const wx = (c + 1) * TILE_SIZE
  const wz = (r + 1) * TILE_SIZE
  const ent = createEntity({
    position: Vector3.create(wx, junctionY, wz),
    scale:    Vector3.create(WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS),
    mesh:     'box',
    material: { color: concreteColor, roughness: 1, metallic: 0 },
    collider: 'box',
    colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
  })
  junctionEntities.set(key, ent)

  // Gold stripe on the column — same style as concrete wall stripes.
  const postStripe = WALL_THICKNESS + STRIPE_PROTRUDE
  const stripeEnt = createEntity({
    position: Vector3.create(wx, junctionY, wz),
    scale:    Vector3.create(postStripe, STRIPE_HEIGHT, postStripe),
    mesh:     'box',
    material: {
      color:             STRIPE_COLOR4,
      emissiveColor:     STRIPE_COLOR3,
      emissiveIntensity: 2.0,
      roughness:         1,
      metallic:          0,
      castShadows:       false
    },
    collider: false,
    visible:  true
  })
  junctionStripeEntities.set(key, stripeEnt)
}

// Update the (up to 2) junction posts that touch this wall. Call after a wall
// changes type / state so destroyed walls leave dangling concrete columns
// behind only if some other adjacent wall is still active.
export function refreshJunctionsAroundWall(wallIdx: number, wallTypes: number[], wallStates: number[]) {
  if (wallIdx < 0 || wallIdx >= WALL_COUNT) return
  const isH = wallIdx < H_WALL_COUNT
  if (isH) {
    const r = (wallIdx / GRID_COLS) | 0
    const c = wallIdx % GRID_COLS
    // h-wall at (r,c): junctions are at the two corners of its left/right edges
    syncJunction(r, c - 1, wallTypes, wallStates)
    syncJunction(r, c,     wallTypes, wallStates)
  } else {
    const r = ((wallIdx - H_WALL_COUNT) / (GRID_COLS - 1)) | 0
    const c = (wallIdx - H_WALL_COUNT) % (GRID_COLS - 1)
    // v-wall at (r,c): junctions at the two corners of its top/bottom edges
    syncJunction(r - 1, c, wallTypes, wallStates)
    syncJunction(r,     c, wallTypes, wallStates)
  }
}

// ── Item entities ─────────────────────────────────────────────────────────────

const itemEntities = new Map<string, Entity>()  // "col_row" → entity

const ITEM_TEXTURES: Record<string, string> = {
  baton:  'assets/scene/Images/Truncheon_clean_PNG.png',
  shield: 'assets/scene/Images/Shield_clean_PNG.png',
  bomb:   'assets/scene/Images/TNT_clean_PNG.png',
}

// Налаштування текстур предметів
const ITEM_ROLL: Record<string, Quaternion> = {
  baton:  Quaternion.fromEulerDegrees(0,   0, 90),
  shield: Quaternion.fromEulerDegrees(0,   0,  0),
  bomb:   Quaternion.fromEulerDegrees(0, 180,  0),
}
const ITEM_TILING: Record<string, {x:number; y:number}> = {
  baton:  { x: 0.94, y: 0.18 },
  shield: { x: 1,    y: 0.89 },
  bomb:   { x: 0.7,  y: 0.7  },
}
const ITEM_OFFSET: Record<string, {x:number; y:number}> = {
  baton:  { x: 0.03, y: 0.41 },
  shield: { x: 0,    y: 0.06 },
  bomb:   { x: 0.15, y: 0.15 },
}

// Бокс із 6 площин для floor-предмета.
// parent має scale(1,1,1) → позиції дітей = world-офсети без спотворення.
// Кожна грань отримує ЯВНИЙ scale(sx, sy, 1): sx=H (висока вісь), sy=W або D (вузька).
// Це єдиний спосіб гарантувати однакову орієнтацію текстури на всіх гранях.
// Позиції граней: лицьова at (0,0,0), задня at (0,0,-D), бокові at (±W/2, 0, -D/2), caps at (0,±H/2,-D/2).
function spawnTilePlaneBox(parent: Entity, W: number, H: number, D: number, type: string): void {
  const tex = ITEM_TEXTURES[type]
  if (!tex) return
  const roll   = ITEM_ROLL[type]   ?? Quaternion.fromEulerDegrees(0, 0, 0)
  const tiling = ITEM_TILING[type] ?? { x: 1, y: 1 }
  const offset = ITEM_OFFSET[type] ?? { x: 0, y: 0 }
  const mat = {
    texture: tex, textureWrapMode: TextureWrapMode.TWM_CLAMP,
    textureTiling: tiling, textureOffset: offset,
    color: Color4.White(), roughness: 1, metallic: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
  }
  const Qm = (dir: Quaternion) => Quaternion.multiply(dir, roll)
  const Qe = Quaternion.fromEulerDegrees
  const V  = Vector3.create
  // f: позиція в LOCAL просторі батька (scale=1), rotation, sx=H, sy=W/D
  const f = (pos: Vector3, rot: Quaternion, sx: number, sy: number) =>
    createEntity({ parent, position: pos, rotation: rot, scale: V(sx, sy, 1), mesh: 'plane', collider: false, material: mat })

  f(V(    0,      0,    0   ), Qm(Qe(  0, 180, 0)), H, W)  // лицьова (faces -Z, south)
  f(V(    0,      0,   -D   ), Qm(Qe(  0,   0, 0)), H, W)  // задня   (faces +Z, north)
  f(V( -W/2,      0,  -D/2  ), Qm(Qe(  0, -90, 0)), H, D)  // ліва
  f(V(  W/2,      0,  -D/2  ), Qm(Qe(  0,  90, 0)), H, D)  // права
  f(V(    0,    H/2,  -D/2  ), Qm(Qe(-90,   0, 0)), W, D)  // верх  (мала)
  f(V(    0,   -H/2,  -D/2  ), Qm(Qe( 90,   0, 0)), W, D)  // низ   (мала)
}

export function syncItems(
  serverItems: Map<string, { tileCol: number; tileRow: number; type: string; active: boolean }>
) {
  for (const [key, ent] of itemEntities) {
    if (!serverItems.has(key)) { removeEntityAndChildren(ent); itemEntities.delete(key) }
  }

  for (const [key, item] of serverItems) {
    if (!item.active) {
      const e = itemEntities.get(key)
      if (e) { removeEntityAndChildren(e); itemEntities.delete(key) }
      continue
    }
    if (itemEntities.has(key)) continue

    const wx = tileToWorldX(item.tileCol)
    const wz = tileToWorldZ(item.tileRow)
    let ent: Entity
    let colliderEnt: Entity | null = null   // entity що має колайдер + приймає кліки

    if (item.type === 'baton') {
      const W = 0.05, H = 0.6, D = 0.05
      // root без scale(1,1,1) → позиції площин = world-офсети, без спотворення
      ent = createEntity({
        position: Vector3.create(wx, GAME_ZONE_Y + 1.0, wz),
        collider: false,
      })
      // Box-колайдер (CL_POINTER only) — циліндр в DCL може випадково блокувати рух
      // навіть без CL_PHYSICS. Box ширший за візуал для зручного кліку.
      colliderEnt = createEntity({
        parent:        ent,
        scale:         Vector3.create(0.45, H, 0.45),
        collider:      'box',
        colliderLayer: ColliderLayer.CL_POINTER,
      })
      spawnTilePlaneBox(ent, W, H, D, item.type)

    } else if (item.type === 'shield') {
      // Billboard plane: sx=0.75 (ширина), sy=1.0 (висота)
      ent = createEntity({
        position:      Vector3.create(wx, GAME_ZONE_Y + 1.0, wz),
        scale:         Vector3.create(0.75, 1, 1),
        billboard:     BillboardMode.BM_Y,
        mesh:          'plane',
        material: {
          texture:          ITEM_TEXTURES['shield'],
          textureWrapMode:  TextureWrapMode.TWM_CLAMP,
          textureTiling:    ITEM_TILING['shield'],
          textureOffset:    ITEM_OFFSET['shield'],
          color:            Color4.White(),
          roughness: 1, metallic: 0,
          transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
        },
        collider:      'plane',
        colliderLayer: ColliderLayer.CL_POINTER,
      })

    } else {
      // bomb (та будь-який майбутній тип)
      const S = 0.25
      ent = createEntity({
        position: Vector3.create(wx, GAME_ZONE_Y + 0.7, wz),
        collider: false,
      })
      // spawnTilePlaneBox будує бокс із Z=[0..-S], тому центр за Z = -S/2.
      // Колайдер центруємо там само і робимо більшим за візуал щоб зручно клікати.
      colliderEnt = createEntity({
        parent:        ent,
        position:      Vector3.create(0, 0, -S / 2),
        scale:         Vector3.create(0.6, 0.6, 0.6),
        collider:      'box',
        colliderLayer: ColliderLayer.CL_POINTER,
      })
      spawnTilePlaneBox(ent, S, S, S, item.type)
    }

    makeClickable(colliderEnt ?? ent, `Pick up ${item.type}`, () => {
      if (!isLocalNearTile(item.tileCol, item.tileRow)) return
      sendToRoom('pickup_item', { key })
    }, 2.5)
    itemEntities.set(key, ent)
  }
}

// ── VIP door-cross flash ──────────────────────────────────────────────────────
// Called from index.ts when the server broadcasts 'vip_door_crossed'.
// Plays a brief open→close animation so players see the VIP phasing through
// a closed door. Only fires for SOLID→BLOCKED (closed door VIP crossed);
// OPEN→BLOCKED (already-open door VIP crossed) uses the normal close animation.

const FLASH_MS = DOOR_SLIDE_MS / 2   // 500 ms open + 500 ms close

export function flashVipDoorCross(wallIdx: number) {
  const existing = wallEntities.get(wallIdx)
  if (!existing) return
  const t = existing.type
  if (t !== WALL_WOOD_DOOR) return
  MeshCollider.deleteFrom(existing.entity)
  PointerEvents.deleteFrom(existing.entity)
  animateDoorSlide(existing.entity, doorOpenY(existing.finalY), FLASH_MS)
  playSound('door_open')
  delay(FLASH_MS, () => {
    MeshCollider.setBox(existing.entity, ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER)
    syncEntityPointerEvents(existing.entity)
    animateDoorSlide(existing.entity, existing.finalY, FLASH_MS)
    playSound('door_close')
  })
}
