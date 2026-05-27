// Hot-reloadable server config.
//
// Reads server/config.json on startup, then re-reads on every file save (debounced).
// Other modules read `cfg.GAME_DURATION_S` (NOT `const { GAME_DURATION_S } = cfg`) —
// destructuring captures the value at that moment, defeating live updates.
//
// On parse error or validation failure the old values are kept and an error is
// logged. The server never crashes from a bad edit.

import * as fs from 'fs'
import * as path from 'path'
import {
  WALL_HEDGE, WALL_WOOD_WALL, WALL_WOOD_DOOR,
  WALL_CONCRETE,
  randInt,
} from './constants'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MazeWeight { type: number; weight: number }
export interface MazeOptions {
  windingness:           number
  braidProb:             number
  widenProb:             number
  corridorDoorProb:      number
  obstaclesMin:          number
  obstaclesMax:          number
  minBlockersPerLine:    number
  routeCount:            number
  branchCount:           number
  materialBias:          MazeWeight[]
  corridorObstacleBias:  MazeWeight[]
}

export interface VipOverrides {
  bodyShape:       string | null
  wearables:       string[] | null
  addWearables:    string[]
  removeWearables: string[]
  skinColor:       { r: number; g: number; b: number } | null
  hairColor:       { r: number; g: number; b: number } | null
  eyeColor:        { r: number; g: number; b: number } | null
}

export interface VipConfig {
  mode:         'random' | 'female' | 'male' | 'player'
  playerWallet: string
  overrides:    VipOverrides
}

export interface GameConfig {
  GAME_DURATION_S: number
  COUNTDOWN_S: number
  END_LINGER_S: number
  MIN_PLAYERS_START: number
  MAX_PLAYERS: number
  VIP_ROOM_LOCK_S: number
  EMPTY_ARENA_MODE: boolean

  PLAYER_MAX_HP: number
  VIP_MAX_HP: number
  ATTACK_DAMAGE_MIN: number
  ATTACK_DAMAGE_MAX: number
  ATTACK_COOLDOWN_MS: number
  ATTACK_RESOLVE_DELAY_MS: number
  DEFENDING_DAMAGE_MULT: number
  BATON_BONUS_MIN: number
  BATON_BONUS_MAX: number
  BOMB_DAMAGE_MIN: number
  BOMB_DAMAGE_MAX: number
  BOMB_SELF_DAMAGE: number
  BOMB_FUSE_MS: number

  SHIELD_MAX_HP_MIN: number
  SHIELD_MAX_HP_MAX: number
  SHIELD_HIT_BY_HAND: number
  SHIELD_HIT_BY_BATON: number
  SHIELD_HIT_BY_BOMB: number

  WALL_DMG_HAND_MIN: number
  WALL_DMG_HAND_MAX: number
  WALL_DMG_BATON_MIN: number
  WALL_DMG_BATON_MAX: number
  WALL_DMG_BOMB_MIN: number
  WALL_DMG_BOMB_MAX: number

  // Map "hedge"/"woodWall"/"woodDoor" → [min, max]
  WALL_HP_RANGES: Record<string, [number, number]>

  ITEM_SPAWN_INTERVAL_MS: number
  ITEM_MAX: number
  ITEM_INITIAL_COUNT: number
  BATON_MAX_TOTAL: number
  SHIELD_MAX_TOTAL: number
  ITEM_SPAWN_WEIGHTS: Record<string, number>

  NPC_MOVE_INTERVAL_MS: number
  VIP_BYPASS_TILES: number
  VIP_FLEE_TILES: number
  NPC_FOLLOW_RADIUS: number

  DISCONNECT_DEATH_MS: number
  DISCONNECT_PURGE_MS: number

  ENABLE_GAME_ZONE_FIRST_PERSON: boolean
  ENABLE_ROOF_PHYSICS_COLLIDER: boolean
  // When true, ANY player can stand on ANY other player's tile (incl. VIP).
  // Server skips the overlap rejection in player_tile; client drops physics
  // colliders from enemy + VIP hitboxes so movement isn't blocked locally.
  ALLOW_ALL_TILE_OVERLAP: boolean

  // ── Admin controls (edge-triggered or live) ────────────────────────────
  FORCE_START_GAME: boolean   // edge-trigger false→true: force-start match (auto-queue all lobby players)
  FORCE_END_GAME:   boolean   // edge-trigger false→true: force-end current match (draw / admin_end)
  ADD_TIME_S:       number    // value-change while playing: add this many seconds to timeRemaining; 0 = no-op
  IMMORTALITY_MODE: boolean   // live: players/VIP at HP<=0 teleport+heal instead of dying

  MAZE_OPTIONS: MazeOptions

  vipConfig: VipConfig
}

// ── Wall type-name → numeric ID resolution ──────────────────────────────────
// JSON uses readable names ("CONCRETE", "HEDGE", "WOOD_DOOR") so config files
// stay editable without remembering numeric IDs. Mapped to constants here.

const WALL_TYPE_BY_NAME: Record<string, number> = {
  CONCRETE:  WALL_CONCRETE,
  HEDGE:     WALL_HEDGE,
  WOOD_WALL: WALL_WOOD_WALL,
  WOOD_DOOR: WALL_WOOD_DOOR,
}

function resolveMazeWeights(arr: Array<{ type: string | number; weight: number }>): MazeWeight[] {
  return arr.map((w) => ({
    type: typeof w.type === 'number' ? w.type : WALL_TYPE_BY_NAME[w.type] ?? WALL_CONCRETE,
    weight: w.weight,
  }))
}

// ── Path resolution ─────────────────────────────────────────────────────────
// CONFIG_PATH env var lets tests / docker overrides point elsewhere. Default
// is <server>/config.json (one level above the build/ output and src/).

const CONFIG_PATH = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : path.resolve(__dirname, '../../config.json')

// ── Validation ──────────────────────────────────────────────────────────────
// Light sanity checks. Anything that would crash the server later (NaN HP,
// negative cooldowns, empty weight arrays) is rejected with a descriptive
// error and the existing config is preserved.

function validate(raw: any): GameConfig {
  if (!raw || typeof raw !== 'object') throw new Error('config root is not an object')

  const num = (k: string): number => {
    const v = raw[k]
    if (typeof v !== 'number' || !isFinite(v)) throw new Error(`${k}: expected finite number, got ${JSON.stringify(v)}`)
    return v
  }
  const pos = (k: string): number => {
    const v = num(k)
    if (v < 0) throw new Error(`${k}: must be >= 0`)
    return v
  }
  const bool = (k: string): boolean => {
    const v = raw[k]
    if (typeof v !== 'boolean') throw new Error(`${k}: expected boolean, got ${JSON.stringify(v)}`)
    return v
  }

  // Range invariants
  const pair = (minK: string, maxK: string): [number, number] => {
    const mn = pos(minK)
    const mx = pos(maxK)
    if (mn > mx) throw new Error(`${minK} (${mn}) > ${maxK} (${mx})`)
    return [mn, mx]
  }

  pair('ATTACK_DAMAGE_MIN',  'ATTACK_DAMAGE_MAX')
  pair('BATON_BONUS_MIN',    'BATON_BONUS_MAX')
  pair('BOMB_DAMAGE_MIN',    'BOMB_DAMAGE_MAX')
  pair('SHIELD_MAX_HP_MIN',  'SHIELD_MAX_HP_MAX')
  pair('WALL_DMG_HAND_MIN',  'WALL_DMG_HAND_MAX')
  pair('WALL_DMG_BATON_MIN', 'WALL_DMG_BATON_MAX')
  pair('WALL_DMG_BOMB_MIN',  'WALL_DMG_BOMB_MAX')

  // WALL_HP_RANGES: { name: [min, max] }
  const hp = raw.WALL_HP_RANGES
  if (!hp || typeof hp !== 'object') throw new Error('WALL_HP_RANGES: expected object')
  const wallHpRanges: Record<string, [number, number]> = {}
  for (const [name, range] of Object.entries(hp)) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => typeof n === 'number' && isFinite(n))) {
      throw new Error(`WALL_HP_RANGES.${name}: expected [min, max] of numbers`)
    }
    const [mn, mx] = range as [number, number]
    if (mn < 0 || mx > 255 || mn > mx) throw new Error(`WALL_HP_RANGES.${name}: invalid range [${mn}, ${mx}] (must be 0..255 and min <= max)`)
    wallHpRanges[name] = [mn, mx]
  }

  // Spawn weights
  const spawnW = raw.ITEM_SPAWN_WEIGHTS
  if (!spawnW || typeof spawnW !== 'object') throw new Error('ITEM_SPAWN_WEIGHTS: expected object')
  for (const [k, v] of Object.entries(spawnW)) {
    if (typeof v !== 'number' || v < 0) throw new Error(`ITEM_SPAWN_WEIGHTS.${k}: expected non-negative number`)
  }

  // Maze options
  const m = raw.MAZE_OPTIONS
  if (!m || typeof m !== 'object') throw new Error('MAZE_OPTIONS: expected object')
  if (!Array.isArray(m.materialBias) || m.materialBias.length === 0) throw new Error('MAZE_OPTIONS.materialBias: expected non-empty array')
  if (!Array.isArray(m.corridorObstacleBias) || m.corridorObstacleBias.length === 0) throw new Error('MAZE_OPTIONS.corridorObstacleBias: expected non-empty array')

  const mazeOptions: MazeOptions = {
    windingness:          m.windingness,
    braidProb:            m.braidProb,
    widenProb:            m.widenProb,
    corridorDoorProb:     m.corridorDoorProb,
    obstaclesMin:         m.obstaclesMin,
    obstaclesMax:         m.obstaclesMax,
    minBlockersPerLine:   m.minBlockersPerLine,
    routeCount:           m.routeCount,
    branchCount:          m.branchCount,
    materialBias:         resolveMazeWeights(m.materialBias),
    corridorObstacleBias: resolveMazeWeights(m.corridorObstacleBias),
  }

  // VIP config — light validation; full fetch logic lives in GameRoom
  const v = raw.vipConfig
  if (!v || typeof v !== 'object') throw new Error('vipConfig: expected object')
  if (!['random', 'female', 'male', 'player'].includes(v.mode)) {
    throw new Error(`vipConfig.mode: expected 'random'|'female'|'male'|'player', got ${JSON.stringify(v.mode)}`)
  }

  return {
    GAME_DURATION_S:   pos('GAME_DURATION_S'),
    COUNTDOWN_S:       pos('COUNTDOWN_S'),
    END_LINGER_S:      pos('END_LINGER_S'),
    MIN_PLAYERS_START: pos('MIN_PLAYERS_START'),
    MAX_PLAYERS:       pos('MAX_PLAYERS'),
    VIP_ROOM_LOCK_S:   pos('VIP_ROOM_LOCK_S'),
    EMPTY_ARENA_MODE:  bool('EMPTY_ARENA_MODE'),

    PLAYER_MAX_HP:           pos('PLAYER_MAX_HP'),
    VIP_MAX_HP:              pos('VIP_MAX_HP'),
    ATTACK_DAMAGE_MIN:       pos('ATTACK_DAMAGE_MIN'),
    ATTACK_DAMAGE_MAX:       pos('ATTACK_DAMAGE_MAX'),
    ATTACK_COOLDOWN_MS:      pos('ATTACK_COOLDOWN_MS'),
    ATTACK_RESOLVE_DELAY_MS: pos('ATTACK_RESOLVE_DELAY_MS'),
    DEFENDING_DAMAGE_MULT:   pos('DEFENDING_DAMAGE_MULT'),
    BATON_BONUS_MIN:         pos('BATON_BONUS_MIN'),
    BATON_BONUS_MAX:         pos('BATON_BONUS_MAX'),
    BOMB_DAMAGE_MIN:         pos('BOMB_DAMAGE_MIN'),
    BOMB_DAMAGE_MAX:         pos('BOMB_DAMAGE_MAX'),
    BOMB_SELF_DAMAGE:        pos('BOMB_SELF_DAMAGE'),
    BOMB_FUSE_MS:            pos('BOMB_FUSE_MS'),

    SHIELD_MAX_HP_MIN:   pos('SHIELD_MAX_HP_MIN'),
    SHIELD_MAX_HP_MAX:   pos('SHIELD_MAX_HP_MAX'),
    SHIELD_HIT_BY_HAND:  pos('SHIELD_HIT_BY_HAND'),
    SHIELD_HIT_BY_BATON: pos('SHIELD_HIT_BY_BATON'),
    SHIELD_HIT_BY_BOMB:  pos('SHIELD_HIT_BY_BOMB'),

    WALL_DMG_HAND_MIN:  pos('WALL_DMG_HAND_MIN'),
    WALL_DMG_HAND_MAX:  pos('WALL_DMG_HAND_MAX'),
    WALL_DMG_BATON_MIN: pos('WALL_DMG_BATON_MIN'),
    WALL_DMG_BATON_MAX: pos('WALL_DMG_BATON_MAX'),
    WALL_DMG_BOMB_MIN:  pos('WALL_DMG_BOMB_MIN'),
    WALL_DMG_BOMB_MAX:  pos('WALL_DMG_BOMB_MAX'),

    WALL_HP_RANGES: wallHpRanges,

    ITEM_SPAWN_INTERVAL_MS: pos('ITEM_SPAWN_INTERVAL_MS'),
    ITEM_MAX:               pos('ITEM_MAX'),
    ITEM_INITIAL_COUNT:     pos('ITEM_INITIAL_COUNT'),
    BATON_MAX_TOTAL:        pos('BATON_MAX_TOTAL'),
    SHIELD_MAX_TOTAL:       pos('SHIELD_MAX_TOTAL'),
    ITEM_SPAWN_WEIGHTS:     { ...spawnW },

    NPC_MOVE_INTERVAL_MS: pos('NPC_MOVE_INTERVAL_MS'),
    VIP_BYPASS_TILES:     pos('VIP_BYPASS_TILES'),
    VIP_FLEE_TILES:       pos('VIP_FLEE_TILES'),
    NPC_FOLLOW_RADIUS:    pos('NPC_FOLLOW_RADIUS'),

    DISCONNECT_DEATH_MS: pos('DISCONNECT_DEATH_MS'),
    DISCONNECT_PURGE_MS: pos('DISCONNECT_PURGE_MS'),

    ENABLE_GAME_ZONE_FIRST_PERSON: bool('ENABLE_GAME_ZONE_FIRST_PERSON'),
    ENABLE_ROOF_PHYSICS_COLLIDER:  bool('ENABLE_ROOF_PHYSICS_COLLIDER'),
    ALLOW_ALL_TILE_OVERLAP:        bool('ALLOW_ALL_TILE_OVERLAP'),

    // Admin controls — number() (not pos()) for ADD_TIME_S so negative deltas can shrink time too.
    FORCE_START_GAME: bool('FORCE_START_GAME'),
    FORCE_END_GAME:   bool('FORCE_END_GAME'),
    ADD_TIME_S:       num('ADD_TIME_S'),
    IMMORTALITY_MODE: bool('IMMORTALITY_MODE'),

    MAZE_OPTIONS: mazeOptions,

    vipConfig: {
      mode:         v.mode,
      playerWallet: String(v.playerWallet ?? ''),
      overrides: {
        bodyShape:       v.overrides?.bodyShape       ?? null,
        wearables:       v.overrides?.wearables       ?? null,
        addWearables:    Array.isArray(v.overrides?.addWearables)    ? v.overrides.addWearables    : [],
        removeWearables: Array.isArray(v.overrides?.removeWearables) ? v.overrides.removeWearables : [],
        skinColor:       v.overrides?.skinColor       ?? null,
        hairColor:       v.overrides?.hairColor       ?? null,
        eyeColor:        v.overrides?.eyeColor        ?? null,
      },
    },
  }
}

// ── Initial load (sync — must finish before constants module consumers run) ─

function readSync(): GameConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  return validate(raw)
}

let _current: GameConfig
try {
  _current = readSync()
  console.log(`[Config] Loaded ${CONFIG_PATH}`)
} catch (e) {
  // Without an initial config we have nothing to fall back to — hard fail.
  console.error(`[Config] FATAL: failed to read ${CONFIG_PATH}:`, (e as Error).message)
  throw e
}

// Mutable export — other modules read fields lazily (cfg.GAME_DURATION_S).
// We mutate _this_ object in-place on reload so existing references stay live.
export const cfg: GameConfig = _current

// ── Change notification ─────────────────────────────────────────────────────
// Rooms register a callback to react to JSON edits (e.g. re-broadcast scene
// settings to already-connected clients). Returns an unsubscribe — call it on
// onDispose so disposed rooms don't keep firing.

type ChangeListener = (cfg: GameConfig) => void
const _listeners: ChangeListener[] = []

export function onConfigChange(listener: ChangeListener): () => void {
  _listeners.push(listener)
  return () => {
    const i = _listeners.indexOf(listener)
    if (i !== -1) _listeners.splice(i, 1)
  }
}

// ── Reload on file change ───────────────────────────────────────────────────
// fs.watch fires "change" multiple times per save on many editors (write +
// rename + truncate). Debounce so we only re-read once per quiet 200ms window.

let _reloadTimer: NodeJS.Timeout | null = null

function reload(): void {
  try {
    const next = readSync()
    Object.assign(cfg, next)
    console.log(`[Config] ✓ Reloaded ${path.basename(CONFIG_PATH)}`)
    for (const listener of _listeners) {
      try { listener(cfg) }
      catch (e) { console.error('[Config] listener threw:', (e as Error).message) }
    }
  } catch (e) {
    console.error(`[Config] ✗ Reload failed (keeping previous values):`, (e as Error).message)
  }
}

try {
  fs.watch(CONFIG_PATH, { persistent: false }, (event) => {
    if (event !== 'change' && event !== 'rename') return
    if (_reloadTimer) clearTimeout(_reloadTimer)
    _reloadTimer = setTimeout(reload, 200)
  })
  console.log(`[Config] Watching ${path.basename(CONFIG_PATH)} for hot-reload`)
} catch (e) {
  console.warn(`[Config] fs.watch unavailable — hot-reload disabled:`, (e as Error).message)
}

// ── Convenience: random wall HP using current ranges ────────────────────────
// Lives here (not in constants.ts) because the ranges live in cfg.

const WALL_HP_NAME_BY_TYPE: Record<number, string> = {
  [WALL_HEDGE]:     'hedge',
  [WALL_WOOD_WALL]: 'woodWall',
  [WALL_WOOD_DOOR]: 'woodDoor',
}

export function randomWallHp(type: number): number {
  const name = WALL_HP_NAME_BY_TYPE[type]
  if (!name) return 0
  const range = cfg.WALL_HP_RANGES[name]
  if (!range) return 0
  return randInt(range[0], range[1])
}
