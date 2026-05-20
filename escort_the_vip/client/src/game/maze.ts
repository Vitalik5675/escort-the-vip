import { engine, Entity, Transform, MeshRenderer, MeshCollider, Material, TextShape, BillboardMode, PointerEvents, PointerEventType, InputAction, VisibilityComponent, ColliderLayer, MaterialTransparencyMode, TextureWrapMode } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4, Color3 } from '@dcl/sdk/math'
import { createEntity, makeClickable, makeHoverable, setVisible, removeEntity, removeEntityAndChildren, syncEntityPointerEvents, delay } from '../utils/entityFactory'
import { playSound, loopSound, stopSound } from '../audio/soundManager'
import { isLocalAdjacentToWall, isLocalNearTile, isLocalOnTile } from '../utils/adjacency'
import { animateWallRise, animateDoorSlide } from '../utils/transformUtils'
import { sendToRoom } from '../colyseus-client'
import { getLocalState, patchLocalState } from '../state/localState'
import {
  GRID_COLS, GRID_ROWS, TILE_SIZE, GAME_ZONE_Y, WALL_HEIGHT, WALL_THICKNESS,
  WALL_COUNT, H_WALL_COUNT, hWallIndex, vWallIndex, wallSidesTiles,
  hWallWorldPos, vWallWorldPos, H_WALL_SCALE, V_WALL_SCALE,
  WALL_NONE, WALL_CONCRETE, WALL_HEDGE, WALL_METAL_WALL, WALL_WOOD_FENCE,
  WALL_METAL_DOOR, WALL_WOOD_DOOR,
  STATE_SOLID, STATE_OPEN, STATE_DESTROYED, STATE_BLOCKED,
  tileToWorldX, tileToWorldZ
} from './constants'

// ── Wall materials ────────────────────────────────────────────────────────────
// Distinct, fully matte palette — easy to tell types apart at a glance.
// Concrete = grey, hedge = green, metal wall = bluish steel, wood = warm browns,
// metal door = darker steel-blue, wood door = lighter ochre.

const WALL_COLORS: Record<number, Color4> = {
  [WALL_CONCRETE]:   Color4.create(0.55, 0.55, 0.55, 1),
  [WALL_HEDGE]:      Color4.create(0.18, 0.55, 0.15, 1),
  [WALL_METAL_WALL]: Color4.create(0.40, 0.42, 0.45, 1),
  [WALL_WOOD_FENCE]: Color4.create(0.55, 0.36, 0.16, 1),
  [WALL_METAL_DOOR]: Color4.create(0.30, 0.50, 0.70, 1),
  [WALL_WOOD_DOOR]:  Color4.create(0.65, 0.45, 0.25, 1),
}

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
  if (type !== WALL_METAL_DOOR && type !== WALL_WOOD_DOOR) return ACCENT_NONE
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
    position: Vector3.create(16, GAME_ZONE_Y, 16),
    scale:    Vector3.create(32, 0.1, 32),
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

export function buildMaze(wallTypes: number[], wallStates: number[]) {
  for (const w of wallEntities.values()) {
    removeEntity(w.entity)
  }
  wallEntities.clear()

  for (const e of junctionEntities.values()) removeEntity(e)
  junctionEntities.clear()

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
  const isDoor      = newType === WALL_METAL_DOOR || newType === WALL_WOOD_DOOR
  const doorOpen    = isDoor && newState === STATE_OPEN

  if (!shouldExist && existing) {
    // Remove synchronously — the previous attempts at a "sink" animation could
    // silently never complete (Tween TS_COMPLETED never fired in some cases),
    // leaving the wall visually present forever even after HP=0 on the server.
    wallEntities.delete(idx)
    const ls = getLocalState()
    if (ls.hoveredWallIdx === idx) {
      patchLocalState({ hoveredWallIdx: -1, hoveredWallExpiresAt: 0 })
    }
    if (ls.bombTargetWallIdx === idx) {
      patchLocalState({ bombTargetWallIdx: -1 })
    }
    removeEntity(existing.entity)
    return
  }

  if (shouldExist && !existing) {
    spawnWallEntity(idx, newType, newState, false)
    return
  }

  if (existing) {
    const wasDoor      = existing.type === WALL_METAL_DOOR || existing.type === WALL_WOOD_DOOR
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
        syncEntityPointerEvents(existing.entity)         // collider restored → reinstate click/hover
        animateDoorSlide(existing.entity, existing.finalY, DOOR_SLIDE_MS)
        playSound('door_close')
      } else if (doorOpen) {
        MeshCollider.deleteFrom(existing.entity)
        PointerEvents.deleteFrom(existing.entity)        // no collider while open → suppress pointer-events warning
      } else {
        MeshCollider.setBox(existing.entity, ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER)
        syncEntityPointerEvents(existing.entity)         // collider present → reinstate click/hover
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

  const isDoor     = type === WALL_METAL_DOOR || type === WALL_WOOD_DOOR
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

  // Door / fence / hedge interactions. Every click on a destructible wall
  // also pins it into the bottom-centre HUD panel so the player sees its HP
  // and which tools work.
  //   • METAL_DOOR  → click always toggles (indestructible, no HUD panel)
  //   • WOOD_DOOR   → click attacks if player holds a baton, else toggles
  //   • WOOD_FENCE  → click attacks (any source)
  //   • HEDGE       → click attacks (server gates by HP threshold)
  const showInfo = () => {
    patchLocalState({ hoveredWallIdx: idx, hoveredWallExpiresAt: Date.now() + 6_000 })
  }
  // maxDistance ≈ Manhattan-1 distance from a tile centre to the wall mesh
  // (wall sits at the boundary of two tiles, ~1.41 m from each cardinal-
  // adjacent tile centre, ~2.45 m from a diagonal). 2.0 m lets the SDK show
  // the hover label only from a cardinal-adjacent tile.
  const WALL_CLICK_DIST = 2.0
  if (type === WALL_METAL_DOOR) {
    makeClickable(entity, 'Toggle door', () => {
      if (!isLocalAdjacentToWall(idx)) return
      sendToRoom('interact_door', { wallIdx: idx })
    }, WALL_CLICK_DIST)
  } else if (type === WALL_WOOD_DOOR) {
    makeClickable(entity, 'Use door', () => {
      if (!isLocalAdjacentToWall(idx)) return
      const s = getLocalState()
      if (s.myRightHand === 'baton') {
        // Baton equipped → click attacks → show the HP / break-with HUD panel.
        showInfo()
        sendToRoom('attack_wall', { wallIdx: idx })
      } else {
        // Bare hands → click toggles open/close. No info panel — that's only
        // useful when the player can actually try to break the door.
        sendToRoom('interact_door', { wallIdx: idx })
      }
    }, WALL_CLICK_DIST)
  } else if (type === WALL_WOOD_FENCE || type === WALL_HEDGE) {
    makeClickable(entity, 'Attack', () => {
      if (!isLocalAdjacentToWall(idx)) return
      showInfo()
      sendToRoom('attack_wall', { wallIdx: idx })
    }, WALL_CLICK_DIST)
  }

  // Hover tracking — used by combatInput.ts when E is pressed with a bomb.
  // For destructible walls + doors, the bomb is placed targeting THIS wall:
  //   • Hedge / wood-fence / wood-door  → countdown bomb on player's tile
  //   • Wood-door / metal-door          → unarmed door-trap (server picks the
  //     branch by checking wall type). Hover is registered on all of them so
  //     the player has a consistent "aim with cursor + press E" UX.
  if (type === WALL_HEDGE || type === WALL_WOOD_FENCE ||
      type === WALL_WOOD_DOOR || type === WALL_METAL_DOOR) {
    makeHoverable(entity, 8, (_e, entered) => {
      const s = getLocalState()
      if (entered) {
        patchLocalState({ bombTargetWallIdx: idx })
      } else if (s.bombTargetWallIdx === idx) {
        patchLocalState({ bombTargetWallIdx: -1 })
      }
    })
  }

  // Двері spawned у відчиненому стані: collider = false → PointerEvents потрібно
  // видалити інакше движок DCL кидає "Missing MeshCollider" попередження.
  // Реєстри click/hover залишаються заповненими → syncEntityPointerEvents
  // відновить їх коли двері закриються.
  if (isDoorOpen) {
    PointerEvents.deleteFrom(entity)
  }


  wallEntities.set(idx, { entity, type, state, isH, wRow, wCol, finalY: pos.y })
}

// Wall HP / required-tools is now displayed in the bottom-center UI panel
// (see ui.tsx) when the player hovers a destructible wall — no more floating
// labels in the world. These two stubs are kept so existing callers compile
// without changes; they intentionally do nothing.
export function syncWallHP(_idx: number, _type: number, _hp: number, _maxHp: number) { /* no-op */ }
export function clearWallHPOverlays() { /* no-op */ }

// Re-tint every door entity based on the latest viewer context. Cheap: walks
// only the door entities (a small subset of `wallEntities`) and updates their
// PBR material — meshes / colliders are untouched. Caller is expected to
// supply `isEnemyAdjacent` already keyed against the latest player snapshot.
export function refreshDoorMaterials(ctx: DoorViewContext) {
  latestDoorCtx = ctx
  for (const [idx, w] of wallEntities) {
    if (w.type !== WALL_METAL_DOOR && w.type !== WALL_WOOD_DOOR) continue
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

  const textEntity = createEntity({
    position: Vector3.create(wx, GAME_ZONE_Y + 1.3, wz),
    text:     {
      // Armed: show initial fuse (10 s); tickBombOverlays updates each frame.
      // Unarmed (door-trap): show 'TRAP' permanently — fuseEndsAt is 0 so
      // the tick system must NOT overwrite this with '0'.
      value:        armed ? '10' : 'TRAP',
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
  if (armed && armedCountBefore === 0) loopSound('bomb_countdown')
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
  if ((type === WALL_METAL_DOOR || type === WALL_WOOD_DOOR) && state === STATE_OPEN) return false
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
      // окремий child з правильним scale для cylinder-колайдера
      colliderEnt = createEntity({
        parent:        ent,
        scale:         Vector3.create(W, H, D),
        collider:      'cylinder',
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
      const S = 0.25
      ent = createEntity({
        position: Vector3.create(wx, GAME_ZONE_Y + 0.7, wz),
        collider: false,
      })
      colliderEnt = createEntity({
        parent:        ent,
        scale:         Vector3.create(S, S, S),
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
  if (t !== WALL_METAL_DOOR && t !== WALL_WOOD_DOOR) return
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
