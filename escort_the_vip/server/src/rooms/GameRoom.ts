import { Room, Client, ServerError } from 'colyseus'
import { GameState, PlayerState, VIPState, ItemState, BombState, GameResult } from './state/GameState'
import { generateRandomMaze, generateEmptyArena, MazeConfig } from '../game/MazeGenerator'
import { canMoveBetween, findPath, wallIdxBetween, isPassable } from '../game/Pathfinder'
import { verifyToken } from '../auth'

interface AuthPayload {
  userId:      string
  displayName: string
}
import {
  GRID_COLS, GRID_ROWS, H_WALL_COUNT, hWallIndex, vWallIndex,
  WALL_NONE, WALL_WOOD_DOOR, WALL_WOOD_WALL, WALL_HEDGE,
  STATE_SOLID, STATE_OPEN, STATE_DESTROYED, STATE_BLOCKED,
  WALL_COUNT,
  randInt,
} from '../game/constants'
import { cfg, randomWallHp, onConfigChange } from '../game/config'

interface PendingAttack {
  targetId:    string                // sessionId or '__vip__'
  isVip:       boolean
  src:         'hand' | 'baton'
  scheduledAt: number
}

// ── VIP appearance config (defined in server/src/game/constants.ts) ─────────
// Resolved once on first GameRoom.onCreate(); shared across all room instances.

interface VipAvatarData {
  bodyShape:  string
  wearables:  string[]
  skinColor:  { r: number; g: number; b: number }
  hairColor:  { r: number; g: number; b: number }
  eyeColor:   { r: number; g: number; b: number }
}

let _vipConfigMode       = 'random'
let _vipConfigWallet     = ''
let _vipCachedAvatarJson = ''   // serialised VipAvatarData, or '' if unavailable
let _vipConfigLoaded     = false

/** Load VIP appearance from game/constants.ts (vipConfig) and optionally fetch Catalyst avatar. */
async function loadVipConfig() {
  if (_vipConfigLoaded) return
  _vipConfigLoaded = true

  _vipConfigMode   = cfg.vipConfig.mode
  _vipConfigWallet = cfg.vipConfig.playerWallet.toLowerCase().trim()
  console.log('[VipConfig] mode=' + _vipConfigMode + '  wallet=' + (_vipConfigWallet || '(none)'))

  if (_vipConfigMode === 'player' && _vipConfigWallet) {
    const loaded = await fetchCatalystAvatar(_vipConfigWallet)
    if (loaded) {
      const result = applyVipOverrides(loaded, cfg.vipConfig.overrides)
      _vipCachedAvatarJson = JSON.stringify(result)
      console.log('[VipConfig] ✓ Avatar ready — bodyShape:', result.bodyShape)
      console.log('[VipConfig]   skin:', JSON.stringify(result.skinColor),
                  ' hair:', JSON.stringify(result.hairColor),
                  ' eyes:', JSON.stringify(result.eyeColor))
      console.log('[VipConfig]   wearables (' + result.wearables.length + '):',
                  result.wearables.slice(0, 3).join(', ') + (result.wearables.length > 3 ? ' …' : ''))
    }
  }
}

/**
 * Fetch avatar data from the DCL Catalyst profiles endpoint.
 *
 * The Catalyst lambdas/profiles API returns colours in one of two formats
 * depending on the node version:
 *   Newer nodes:  av.skin.color / av.hair.color / av.eyes.color  (nested)
 *   Older nodes:  av.skinColor  / av.hairColor  / av.eyeColor    (flat)
 * We handle both.
 */
async function fetchCatalystAvatar(wallet: string): Promise<VipAvatarData | null> {
  const url = 'https://peer.decentraland.org/lambdas/profiles/' + wallet
  try {
    const resp = await (fetch as any)(url)
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    const json: any = await resp.json()

    // Support both the array response (new content-server) and the
    // { avatars: [...] } wrapper (lambdas endpoint)
    const entry = Array.isArray(json) ? json[0] : json?.avatars?.[0]
    const av    = entry?.avatar ?? entry?.metadata?.avatar ?? null

    if (!av) {
      console.error('[VipConfig] No avatar object in Catalyst response. Raw:', JSON.stringify(json).slice(0, 400))
      return null
    }


    // Normalise colour — prefer the nested format (current Catalyst default),
    // fall back to the flat format (older lambdas endpoint).
    const toRgb = (nested: any, flat: any): { r: number; g: number; b: number } => {
      const src = nested ?? flat
      if (src && typeof src.r === 'number') return { r: src.r, g: src.g, b: src.b }
      return { r: 0.8, g: 0.65, b: 0.5 }  // DCL default skin tone fallback
    }

    const avatar: VipAvatarData = {
      bodyShape: av.bodyShape ?? 'urn:decentraland:off-chain:base-avatars:BaseFemale',
      wearables: Array.isArray(av.wearables) ? av.wearables.map(sanitizeWearableUrn) : [],
      skinColor: toRgb(av.skin?.color,  av.skinColor),
      hairColor: toRgb(av.hair?.color,  av.hairColor),
      eyeColor:  toRgb(av.eyes?.color,  av.eyeColor),
    }
    return avatar
  } catch (e) {
    console.error('[VipConfig] Catalyst fetch failed — will use random fallback for matches:', e)
    return null
  }
}

/**
 * Strip the ownership token-ID suffix from Matic/Ethereum collections-v2 wearable URNs.
 * Catalyst profiles store the FULL ownership URN:
 *   urn:decentraland:matic:collections-v2:CONTRACT:ITEM_ID:TOKEN_ID  (7 parts)
 * AvatarShape needs the ITEM URN (without the specific token):
 *   urn:decentraland:matic:collections-v2:CONTRACT:ITEM_ID           (6 parts)
 */
function sanitizeWearableUrn(urn: string): string {
  const parts = urn.split(':')
  // v2 NFT ownership URN has 7 parts; strip the last one (TOKEN_ID)
  if (parts.length === 7 && parts[3] === 'collections-v2') {
    return parts.slice(0, 6).join(':')
  }
  return urn
}

/** Apply vipConfig.overrides (from server/config.json) on top of a fetched base avatar. */
function applyVipOverrides(base: VipAvatarData, ov: Partial<{ bodyShape: string | null; wearables: string[] | null; addWearables: string[]; removeWearables: string[]; skinColor: { r: number; g: number; b: number } | null; hairColor: { r: number; g: number; b: number } | null; eyeColor: { r: number; g: number; b: number } | null }>): VipAvatarData {
  const r: VipAvatarData = {
    bodyShape: base.bodyShape,
    wearables: [...base.wearables],
    skinColor: { ...base.skinColor },
    hairColor: { ...base.hairColor },
    eyeColor:  { ...base.eyeColor  },
  }
  if (typeof ov.bodyShape === 'string' && ov.bodyShape) r.bodyShape = ov.bodyShape
  if (Array.isArray(ov.wearables)) r.wearables = ov.wearables
  if (Array.isArray(ov.addWearables)    && ov.addWearables.length)
    r.wearables = [...r.wearables, ...ov.addWearables]
  if (Array.isArray(ov.removeWearables) && ov.removeWearables.length) {
    const rm = new Set<string>(ov.removeWearables)
    r.wearables = r.wearables.filter((w: string) => !rm.has(w))
  }
  if (ov.skinColor && typeof ov.skinColor.r === 'number') r.skinColor = ov.skinColor
  if (ov.hairColor && typeof ov.hairColor.r === 'number') r.hairColor = ov.hairColor
  if (ov.eyeColor  && typeof ov.eyeColor.r  === 'number') r.eyeColor  = ov.eyeColor
  return r
}

export class GameRoom extends Room<{ state: GameState }> {
  maxClients = cfg.MAX_PLAYERS

  private mazeConfig: MazeConfig | null = null
  private safetyTileSet  = new Set<number>()
  private vipRoomTileSet = new Set<number>()
  private attackCooldowns = new Map<string, number>()
  private npcTimer            = 0
  private vipDoorUnlockTimer  = 0
  private itemTimer           = 0
  private endTimer            = 0
  private vipTargetTimer      = 0
  private vipTargetId         = ''
  private readonly VIP_TARGET_SWITCH_MS = 5_000

  // Set to true the first time a hater lands a hit on VIP. VIP only enters
  // flee/bypass mode after being hit — she does not react to mere proximity.
  private vipWasHitByHater     = false
  // When VIP is struck while in a dead-end, she steps toward the attacker
  // (into the tile the knocked-back hater just vacated) to escape.
  private vipDeadEndEscape: { col: number; row: number } | null = null
  // Tile VIP was in when she got cornered — excluded from flee destinations
  // so she does not immediately run back into the same dead-end.
  private vipAvoidTile:    { col: number; row: number } | null = null

  // VIP flee state. Once a hater forces the VIP out, she stays in "fleeing"
  // mode and keeps moving every NPC tick — first to a random spawn-room door
  // farther from the hater (and blocks it behind her), then random walks
  // through the labyrinth biased toward keeping her current direction.
  // Mode ends when she enters a dead-end (no forward options) OR a bodyguard
  // is on an adjacent tile.
  private vipFleeing           = false
  private vipFleeLastDir: [number, number] | null = null
  // VIP's tile at the moment she started fleeing. VIP must reach
  // cfg.VIP_FLEE_TILES Manhattan tiles from this origin before she may stop.
  private vipFleeOrigin: { col: number; row: number } | null = null

  // Phase 5 — pending-attack queue. Holds each attack for cfg.ATTACK_RESOLVE_DELAY_MS
  // before it actually deals damage. If the target enqueues a reciprocal attack
  // back at the original attacker within the window, both still take damage but
  // neither is knocked back (counter-attack rule).
  private pendingAttacks = new Map<string, PendingAttack>()

  // Phase 3 — track who opened each door, so we can auto-close it when the
  // opener wanders more than DOOR_AUTO_CLOSE_TILES away. Cleared on close.
  private doorOpener = new Map<number, string>()
  private readonly DOOR_AUTO_CLOSE_TILES = 2

  // VIP-room doors: all start BLOCKED. Every VIP_DOOR_UNLOCK_INTERVAL_MS one
  // random still-blocked door becomes SOLID (closed but openable). Players /
  // VIP can then click it to open.
  private unlockedVipRoomDoors = new Set<number>()
  private readonly VIP_DOOR_UNLOCK_INTERVAL_MS = 30_000

  // Door-claim system: the FIRST entity (player or VIP) to stand on a tile
  // adjacent to a door "claims" it for their team — opposite-team players are
  // then refused all interactions on that door (handleDoor returns early).
  // When the claimant leaves the adjacent tile, a DOOR_CLAIM_EXPIRE_MS timer
  // counts down; once it runs out the claim drops and the door reverts to
  // STATE_SOLID (anyone can now click it). Opening the door (claimant clicks
  // it through) also clears the claim immediately.
  private doorClaim = new Map<number, { sid: string; team: string; leftAt: number }>()
  private readonly DOOR_CLAIM_EXPIRE_MS = 30_000
  private static readonly VIP_CLAIM_SID = '__vip__'

  // Doors that currently have an unarmed trap bomb. While a door is in this
  // set it is exempt from autoClaimAdjacentDoors so the placer cannot
  // accidentally re-lock the door they just booby-trapped. Entries are
  // removed on detonation, pickup, and resetToLobby.
  private trappedDoors = new Set<number>()

  // Per-userId snapshot for reconnect restore — preserves the in-game
  // position, team, inventory and stance so a brief disconnect doesn't wipe
  // a player's progress.
  private playerBackup = new Map<string, {
    tileCol: number; tileRow: number; team: string; zone: string;
    health:  number; maxHealth: number; isAlive: boolean;
    rightHand: string; leftHand: string; shieldHP: number; shieldMaxHP: number;
    savedAt: number
  }>()
  private readonly BACKUP_TTL_MS = 120_000

  private readonly KNOCKBACK_DIAG_PROB_EACH = 1 / 3
  // How long (ms) a hater can idle adjacent to a cornered VIP before being
  // force-pushed away so the VIP can attempt a dead-end escape.
  private readonly DEAD_END_IDLE_PUSH_MS = 2_500

  private _mazePrepared = false

  // cfg.EMPTY_ARENA_MODE — persistent demo item tiles.
  // Maps "${col}_${row}" → item type. Each entry is immediately re-spawned
  // after pickup so the slot is never empty for the duration of the match.
  private readonly demoTiles = new Map<string, string>()
  private readonly MAZE_PREPARE_S = 10

  // Unsubscribe handle for the hot-reload listener — populated in onCreate,
  // called in onDispose so a disposed room doesn't keep broadcasting.
  private _unsubscribeConfig: (() => void) | null = null

  // Admin-command state (mirrors last applied values so edge-triggers fire once
  // per false→true and ADD_TIME_S applies only on real changes).
  private _lastForceStart = false
  private _lastForceEnd   = false
  private _lastAddTime    = 0

  // ── Colyseus lifecycle ───────────────────────────────────────────────────

  onCreate(_options: Record<string, unknown>) {
    this.state = new GameState()
    this.setupMessages()
    loadVipConfig().catch((e: unknown) => console.error('[VipConfig] Init error:', e))
    this.setSimulationInterval((dt: number) => this.gameLoop(dt), 100)

    // Hot-reload hook: when server/config.json changes, re-broadcast values
    // that clients only learn about via dedicated messages (scene_config).
    // Fires in EVERY phase (lobby / countdown / playing / ended). The client
    // handles both directions cleanly because CameraModeArea is created once
    // in buildGameZone() and toggled by moving its entity between an active
    // position and a parked Y=-1000 (see client/zones/gameZone.ts park-pattern).
    // Roof collider layer is also safe to swap at any time.
    this._unsubscribeConfig = onConfigChange((c) => {
      this.broadcast('scene_config', {
        firstPerson:         c.ENABLE_GAME_ZONE_FIRST_PERSON,
        roofPhysics:         c.ENABLE_ROOF_PHYSICS_COLLIDER,
        allowAllTileOverlap: c.ALLOW_ALL_TILE_OVERLAP,
      })
      console.log(`[GameRoom] Re-broadcast scene_config (phase=${this.state.phase}): firstPerson=${c.ENABLE_GAME_ZONE_FIRST_PERSON} roofPhysics=${c.ENABLE_ROOF_PHYSICS_COLLIDER} allowAllTileOverlap=${c.ALLOW_ALL_TILE_OVERLAP}`)
      this.processAdminCommands(c)
    })

    console.log(`[GameRoom] Room created: ${this.roomId}`)
  }

  static async onAuth(token: string, _options: unknown, _context: unknown): Promise<AuthPayload> {
    if (!token || typeof token !== 'string') {
      throw new ServerError(525, 'Auth token required — call POST /auth first')
    }
    const payload = verifyToken(token)
    if (!payload) {
      throw new ServerError(525, 'Auth token invalid or expired')
    }
    return payload
  }

  onJoin(client: Client, _options: Record<string, unknown> | undefined, auth: AuthPayload) {
    const userId      = auth?.userId      ?? ''
    const displayName = auth?.displayName ?? ''
    if (!userId) {
      console.log(`[GameRoom] WARN: onJoin without userId despite onAuth — kicking ${client.sessionId}`)
      try { client.leave(4004) } catch (_) {}
      return
    }

    const { restored, wasReconnect } = this.handleGhostsForUserId(userId, client.sessionId)

    const p = new PlayerState()
    p.userId      = userId
    p.displayName = displayName
    this.state.players.set(client.sessionId, p)
    this.state.playerCount++

    if (restored) {
      p.tileCol     = restored.tileCol
      p.tileRow     = restored.tileRow
      p.team        = restored.team
      p.zone        = restored.zone
      p.health      = restored.health
      p.maxHealth   = restored.maxHealth
      p.rightHand   = restored.rightHand
      p.leftHand    = restored.leftHand
      p.shieldHP    = restored.shieldHP
      p.shieldMaxHP = restored.shieldMaxHP
      p.isAlive     = restored.isAlive
      if (restored.isAlive && restored.zone === 'game') {
        // Alive, in-game: restore to the saved tile.
        if (wasReconnect) {
          this.evictFromTile(restored.tileCol, restored.tileRow, client.sessionId, p.team !== 'bodyguard')
        }
        const wx = restored.tileCol * 2 + 1
        const wy = 15.5
        const wz = restored.tileRow * 2 + 1
        client.send('teleport', { x: wx, y: wy, z: wz, cx: wx, cy: wy, cz: wz + 1 })
        console.log(`[GameRoom] onJoin restored ${userId} to (${restored.tileCol},${restored.tileRow})${wasReconnect ? ' [reconnect]' : ' [duplicate-tab]'}`)
      } else {
        // Dead or spectator (killed by disconnect grace, or was already spectating):
        // send to the spectator zone. The client's spectator camera + UI are
        // driven by the spectating:true flag on the teleport message.
        client.send('teleport', { x: 16, y: 1.1, z: 27, cx: 16, cy: 1.5, cz: 26, spectating: true })
        console.log(`[GameRoom] onJoin restored ${userId} as dead/spectator (zone=${restored.zone}, alive=${restored.isAlive})`)
      }
    }

    console.log(`[GameRoom] ${client.sessionId} joined as ${userId} — total: ${this.state.playerCount}`)

    client.send('welcome', { sessionId: client.sessionId, phase: this.state.phase })
    // Надсилає налаштування сцени (камера, стеля) — визначені в server/src/game/constants.ts.
    // Клієнт застосовує їх через applySceneConfig() у gameZone.ts.
    client.send('scene_config', {
      firstPerson:          cfg.ENABLE_GAME_ZONE_FIRST_PERSON,
      roofPhysics:          cfg.ENABLE_ROOF_PHYSICS_COLLIDER,
      allowAllTileOverlap:  cfg.ALLOW_ALL_TILE_OVERLAP,
    })
    client.send('maze_rebuild', this.buildMazeRebuildPayload())
  }

  onLeave(client: Client, code: number) {
    const p = this.state.players.get(client.sessionId)
    if (!p) {
      this.attackCooldowns.delete(client.sessionId)
      console.log(`[GameRoom] ${client.sessionId} left (no state)`)
      return
    }

    // ── Ghost-tab fast-path ────────────────────────────────────────────────
    // If another session for the same userId is already active (i.e. this is
    // a ghost that handleGhostsForUserId kicked for a duplicate tab), skip the
    // grace period entirely — the player's progress is already restored in the
    // new session. Without this check, onLeave would leave a disconnected
    // placeholder AND a stale backup, causing two state.players entries for
    // the same userId and potentially a false checkWinByElimination trigger.
    if (p.userId) {
      const hasActiveReplacement = [...this.state.players.entries()].some(
        ([sid, q]) => sid !== client.sessionId && q.userId === p.userId && q.connected
      )
      if (hasActiveReplacement) {
        if (p.inQueue) this.state.queueCount--
        this.state.players.delete(client.sessionId)
        this.state.playerCount--
        this.attackCooldowns.delete(client.sessionId)
        this.pendingAttacks.delete(client.sessionId)
        if (this.state.vip.followerId === client.sessionId) this.state.vip.followerId = ''
        console.log(`[GameRoom] ${client.sessionId} ghost removed on leave (userId ${p.userId} resumed in new session)`)
        return
      }
    }

    // ── Normal leave ───────────────────────────────────────────────────────
    // userId is always a DCL address (never equal to sessionId after auth).
    // The !!p.userId guard is sufficient; no need to compare with sessionId.
    const isActiveGameplay = this.state.phase === 'playing'
                             && !!p.userId
                             && p.zone === 'game'
                             && p.team !== 'none'
                             && p.isAlive

    if (isActiveGameplay) {
      p.connected      = false
      p.disconnectedAt = Date.now()
      this.playerBackup.set(p.userId, {
        tileCol:     p.tileCol,
        tileRow:     p.tileRow,
        team:        p.team,
        zone:        p.zone,
        health:      p.health,
        maxHealth:   p.maxHealth,
        rightHand:   p.rightHand,
        leftHand:    p.leftHand,
        shieldHP:    p.shieldHP,
        shieldMaxHP: p.shieldMaxHP,
        isAlive:     p.isAlive,
        savedAt:     Date.now()
      })
      // Clear VIP follower if disconnecting bodyguard was leading the VIP.
      if (this.state.vip.followerId === client.sessionId) this.state.vip.followerId = ''
      console.log(`[GameRoom] ${client.sessionId} disconnected (code ${code}) — grace period started`)
      return
    }

    if (p.inQueue) this.state.queueCount--
    this.state.players.delete(client.sessionId)
    this.state.playerCount--
    this.attackCooldowns.delete(client.sessionId)
    this.pendingAttacks.delete(client.sessionId)
    if (this.state.vip.followerId === client.sessionId) this.state.vip.followerId = ''
    console.log(`[GameRoom] ${client.sessionId} left (code ${code})`)
  }

  onDispose() {
    if (this._unsubscribeConfig) {
      this._unsubscribeConfig()
      this._unsubscribeConfig = null
    }
    console.log(`[GameRoom] Disposed: ${this.roomId}`)
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  private setupMessages() {
    this.onMessage('ping', (client: Client, data: { timestamp: number }) => {
      client.send('pong', { timestamp: data.timestamp })
    })

    this.onMessage('report_ping', (client: Client, data: { ms: number }) => {
      const p = this.state.players.get(client.sessionId)
      if (!p) return
      const ms = Math.max(0, Math.min(9999, (data?.ms ?? 0) | 0))
      p.ping = ms
      if (!p.connected) { p.connected = true; p.disconnectedAt = 0 }
    })

    this.onMessage('identify', (client: Client, data: { userId: string; displayName: string }) => {
      const p = this.state.players.get(client.sessionId)
      if (!p) return
      if (typeof data?.displayName === 'string' && data.displayName)
        p.displayName = data.displayName.slice(0, 32)
    })

    this.onMessage('join_game', (client: Client) => {
      const p = this.state.players.get(client.sessionId)
      const phase = this.state.phase
      if (!p || p.inQueue || (phase !== 'lobby' && phase !== 'countdown')) return
      p.inQueue = true
      this.state.queueCount++
      this.checkCountdown()
    })

    this.onMessage('cancel_join', (client: Client) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || !p.inQueue) return
      p.inQueue = false
      this.state.queueCount--
      if (this.state.phase === 'countdown' && this.state.queueCount < cfg.MIN_PLAYERS_START) {
        this.state.phase    = 'lobby'
        this.state.countdown = 0
      }
    })

    this.onMessage('spectate', (client: Client) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || this.state.phase === 'lobby') return
      // Alive in-game players cannot self-spectate — they must die first.
      // Without this guard a player can escape death by clicking Spectate,
      // silently setting team='none' and leaving the game without a kill,
      // which corrupts team counts and may false-trigger checkWinByElimination.
      if (p.zone === 'game' && p.isAlive) return
      p.zone = 'spectator'
      p.team = 'none'
      client.send('teleport', { x: 16, y: 1.1, z: 27, cx: 16, cy: 1.5, cz: 26, spectating: true })
    })

    this.onMessage('stop_spectate', (client: Client) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || p.zone !== 'spectator') return
      p.zone = 'lobby'
      client.send('teleport', { x: 8, y: 1.1, z: 4, cx: 16, cy: 1.1, cz: 16, spectating: false })
    })

    this.onMessage('player_tile', (client: Client, data: { col: number; row: number }) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || p.zone !== 'game' || !p.isAlive) return
      if (!p.connected) { p.connected = true; p.disconnectedAt = 0 }

      const newCol = Math.max(0, Math.min(GRID_COLS - 1, data.col | 0))
      const newRow = Math.max(0, Math.min(GRID_ROWS - 1, data.row | 0))
      if (newCol === p.tileCol && newRow === p.tileRow) return

      const dc = newCol - p.tileCol, dr = newRow - p.tileRow
      const manh = Math.abs(dc) + Math.abs(dr)
      const wt = this.state.wallTypes  as unknown as number[]
      const ws = this.state.wallStates as unknown as number[]
      const teleportBack = () => {
        const wx = p.tileCol * 2 + 1, wz = p.tileRow * 2 + 1
        client.send('teleport', { x: wx, y: 15.5, z: wz })
      }
      if (manh > 2) { teleportBack(); return }
      if (manh === 1) {
        if (!canMoveBetween(p.tileCol, p.tileRow, newCol, newRow, wt, ws)) { teleportBack(); return }
      } else {
        const intermediates: Array<{ col: number; row: number }> = []
        if (Math.abs(dc) === 1 && Math.abs(dr) === 1) {
          intermediates.push({ col: newCol, row: p.tileRow })
          intermediates.push({ col: p.tileCol, row: newRow })
        } else if (Math.abs(dc) === 2) {
          intermediates.push({ col: p.tileCol + Math.sign(dc), row: p.tileRow })
        } else {
          intermediates.push({ col: p.tileCol, row: p.tileRow + Math.sign(dr) })
        }
        const ok = intermediates.some(mid =>
          canMoveBetween(p.tileCol, p.tileRow, mid.col, mid.row, wt, ws) &&
          canMoveBetween(mid.col, mid.row, newCol, newRow, wt, ws)
        )
        if (!ok) { teleportBack(); return }
      }

      // ALLOW_ALL_TILE_OVERLAP: skip the rejection entirely. Any player can
      // stand on any other player's tile (including the VIP's). Default false.
      if (!cfg.ALLOW_ALL_TILE_OVERLAP) {
        const allowVipOverlap = p.team === 'bodyguard'
        // Allies of the same team don't block each other — they can share tiles
        // freely. Enemies and (for haters) the VIP still block.
        if (this.isTileOccupiedByOther(newCol, newRow, client.sessionId, allowVipOverlap, p.team)) { teleportBack(); return }
      }

      // Haters cannot enter the VIP spawn room while it is still locked (all
      // doors STATE_BLOCKED). Once the periodic timer unlocks the first door
      // (vipRoomLocked → false), the physical wall/door collision already
      // governs access — no extra movement-level block is needed.
      if (p.team === 'hater'
          && this.state.vipRoomLocked
          && this.vipRoomTileSet.has(newRow * GRID_COLS + newCol)) {
        teleportBack(); return
      }

      p.tileCol = newCol
      p.tileRow = newRow

      // Phase 3 — door claim system: the player may have just become the
      // first one adjacent to a door, in which case they claim it for their
      // team and the door flips to BLOCKED for the opposite team. The
      // processDoorClaims tick handles "claimant left" timer + auto-unblock.
      this.autoClaimAdjacentDoors(client.sessionId, p.team, newCol, newRow)
    })

    this.onMessage('attack', (client: Client, data: { targetId: string }) => {
      if (typeof data?.targetId !== 'string') return
      this.handleAttack(client.sessionId, data.targetId)
    })
    this.onMessage('attack_vip', (client: Client) => {
      this.handleAttack(client.sessionId, '__vip__')
    })

    this.onMessage('attack_wall', (client: Client, data: { wallIdx: number }) => {
      if (typeof data?.wallIdx !== 'number') return
      this.handleWallAttack(client.sessionId, data.wallIdx)
    })
    this.onMessage('destroy_wall', (client: Client, data: { wallIdx: number }) => {
      if (typeof data?.wallIdx !== 'number') return
      this.handleWallAttack(client.sessionId, data.wallIdx)
    })

    this.onMessage('place_bomb', (client: Client, data?: { wallIdx?: number }) => {
      this.handlePlaceBomb(client.sessionId, data?.wallIdx ?? -1)
    })
    this.onMessage('pickup_bomb', (client: Client, data: { key: string }) => {
      this.handlePickupBomb(client.sessionId, data?.key ?? '')
    })
    // Legacy alias from before E/F mechanic.
    this.onMessage('use_item', (client: Client, data: { type: string }) => {
      if (data?.type === 'bomb') this.handlePlaceBomb(client.sessionId, -1)
    })

    this.onMessage('toggle_defend', (client: Client, data: { defending: boolean }) => {
      const p = this.state.players.get(client.sessionId)
      if (!p || p.zone !== 'game' || !p.isAlive) return
      p.defending = !!(data?.defending)
    })

    this.onMessage('pickup_item', (client: Client, data: { key: string }) => {
      if (typeof data?.key !== 'string') return
      this.handlePickup(client.sessionId, data.key)
    })

    this.onMessage('interact_door', (client: Client, data: { wallIdx: number }) => {
      if (typeof data?.wallIdx !== 'number') return
      this.handleDoor(client.sessionId, data.wallIdx)
    })

    this.onMessage('follow_vip', (client: Client) => {
      this.handleFollowVip(client.sessionId)
    })
  }

  // ── Game loop ────────────────────────────────────────────────────────────

  private gameLoop(dt: number) {
    const phase = this.state.phase

    if (phase === 'countdown') {
      this.state.countdown = Math.max(0, this.state.countdown - dt / 1000)
      if (!this._mazePrepared && this.state.countdown <= this.MAZE_PREPARE_S) {
        this.prepareMazeForMatch()
      }
      if (this.state.countdown <= 0) this.startGame()
    }

    if (phase === 'playing') {
      this.state.timeRemaining = Math.max(0, this.state.timeRemaining - dt / 1000)

      this.npcTimer       += dt; if (this.npcTimer       >= this.npcMoveInterval())      { this.npcTimer       = 0; this.moveNpc() }
      this.vipTargetTimer += dt; if (this.vipTargetTimer >= this.VIP_TARGET_SWITCH_MS)   { this.vipTargetTimer = 0; this.refreshVipFollower() }
      if (!cfg.EMPTY_ARENA_MODE) { this.itemTimer += dt; if (this.itemTimer >= cfg.ITEM_SPAWN_INTERVAL_MS) { this.itemTimer = 0; this.spawnItem() } }

      // Periodically unblock one random VIP-room door so the room opens up
      // gradually over time (every VIP_DOOR_UNLOCK_INTERVAL_MS = 30s by default).
      this.vipDoorUnlockTimer += dt
      if (this.vipDoorUnlockTimer >= this.VIP_DOOR_UNLOCK_INTERVAL_MS) {
        this.vipDoorUnlockTimer = 0
        this.unlockOneVipRoomDoor()
      }

      this.processPendingAttacks()
      this.processBombs()
      this.autoCloseDoors()
      this.processDoorClaims()
      this.processDisconnectGrace()
      if (this.state.timeRemaining <= 0) this.endGame('draw', 'timeout') // VIP alive but time ran out → draw
    }

    if (phase === 'ended') {
      this.endTimer += dt
      if (this.endTimer >= cfg.END_LINGER_S * 1000) this.resetToLobby()
    }
  }

  private npcMoveInterval(): number {
    const vip = this.state.vip
    if (!vip.active || vip.maxHealth === 0) return cfg.NPC_MOVE_INTERVAL_MS
    const hpFrac   = vip.health / vip.maxHealth
    const timeFrac = cfg.GAME_DURATION_S > 0 ? this.state.timeRemaining / cfg.GAME_DURATION_S : 0
    const urgency  = 1 - Math.min(hpFrac, timeFrac)
    const PLAYER_TILE_MS = 700   // floor: VIP can move at most ~1.4 tiles/sec
    return Math.max(PLAYER_TILE_MS, cfg.NPC_MOVE_INTERVAL_MS / (1 + urgency * 3))
  }

  // ── Phase transitions ────────────────────────────────────────────────────

  private checkCountdown() {
    if (this.state.phase === 'lobby' && this.state.queueCount >= cfg.MIN_PLAYERS_START) {
      this.state.phase    = 'countdown'
      this.state.countdown = cfg.COUNTDOWN_S
    }
  }

  private prepareMazeForMatch() {
    this._mazePrepared = true
    // In cfg.EMPTY_ARENA_MODE the maze is replaced with a flat open field that
    // keeps only the VIP spawn room + safety zone — useful for testing combat,
    // items, or movement mechanics without navigating a labyrinth.
    this.applyMazeConfig(cfg.EMPTY_ARENA_MODE ? generateEmptyArena() : generateRandomMaze())

    const vip = this.state.vip
    vip.health      = cfg.VIP_MAX_HP
    vip.maxHealth   = cfg.VIP_MAX_HP
    vip.tileCol     = this.mazeConfig!.vipSpawn.col
    vip.tileRow     = this.mazeConfig!.vipSpawn.row
    vip.active      = true
    vip.reachedSafe = false
    vip.followerId  = ''
    vip.lastMoveAt  = Date.now()
    this.vipFleeing      = false
    this.vipFleeLastDir  = null
    this.vipFleeOrigin   = null
    this.vipWasHitByHater = false
    this.vipDeadEndEscape = null
    this.vipAvoidTile     = null
    // Apply appearance from vipConfig (game/constants.ts, loaded at server startup).
    vip.appearanceMode    = _vipConfigMode
    vip.playerWallet      = _vipConfigWallet
    vip.playerAvatarJson  = ''

    if (_vipConfigMode === 'player' && _vipCachedAvatarJson) {
      // Catalyst avatar was pre-fetched on startup — pass it straight to clients.
      vip.playerAvatarJson = _vipCachedAvatarJson
      const av = JSON.parse(_vipCachedAvatarJson) as VipAvatarData
      vip.female      = av.bodyShape?.toLowerCase().includes('female') ?? false
      vip.outfitIndex = 0; vip.skinIndex = 0; vip.hairIndex = 0; vip.eyeIndex = 0
    } else if (_vipConfigMode === 'female') {
      vip.female      = true
      vip.outfitIndex = (Math.random() * 4) | 0
      vip.skinIndex   = (Math.random() * 5) | 0
      vip.hairIndex   = (Math.random() * 6) | 0
      vip.eyeIndex    = (Math.random() * 5) | 0
    } else if (_vipConfigMode === 'male') {
      vip.female      = false
      vip.outfitIndex = (Math.random() * 4) | 0
      vip.skinIndex   = (Math.random() * 5) | 0
      vip.hairIndex   = (Math.random() * 6) | 0
      vip.eyeIndex    = (Math.random() * 5) | 0
    } else {
      // 'random' (default) or 'player' without a valid cached avatar
      if (_vipConfigMode === 'player')
        console.log('[VipConfig] No cached avatar for player mode — using random fallback')
      vip.female      = Math.random() < 0.5
      vip.outfitIndex = (Math.random() * 4) | 0
      vip.skinIndex   = (Math.random() * 5) | 0
      vip.hairIndex   = (Math.random() * 6) | 0
      vip.eyeIndex    = (Math.random() * 5) | 0
    }
    console.log(`[GameRoom] Maze prepared (${this.mazeConfig?.templateId}) — VIP at (${vip.tileCol},${vip.tileRow})`)
  }

  private applyMazeConfig(cfg: MazeConfig) {
    this.mazeConfig = cfg
    for (let i = 0; i < cfg.wallTypes.length; i++) {
      this.state.wallTypes[i]      = cfg.wallTypes[i]
      this.state.wallStates[i]     = cfg.wallStates[i]
      this.state.wallHP[i]         = cfg.wallHP[i]
      this.state.wallMaxHP[i]      = cfg.wallMaxHP[i]
      this.state.wallClaimTeams[i] = 0
      this.state.wallClaimAck[i]   = 0
    }
    this.state.mazeTemplateId   = cfg.templateId
    // VIP-room doors start BLOCKED (truly locked — no one can open them until
    // the periodic timer unlocks them one by one). Haters see AMBER at first
    // (claimTeam=1, ackBits=0) and switch to RED only after clicking.
    // Once unlocked by the timer the door goes BLOCKED→SOLID with claimTeam=0
    // and ackBits=0, so it becomes openable by both teams.
    this.state.vipRoomLocked    = true
    this.unlockedVipRoomDoors   = new Set()   // start empty — timer unlocks gradually
    this.vipDoorUnlockTimer     = 0
    for (const idx of cfg.vipRoomDoors) {
      this.state.wallStates[idx]     = STATE_BLOCKED  // locked until timer fires
      this.state.wallClaimTeams[idx] = 1              // bodyguard-owned (shows AMBER→RED for hater)
      this.state.wallClaimAck[idx]   = 0
    }

    this.safetyTileSet  = new Set(cfg.safetyTiles.map(t  => t.row * GRID_COLS + t.col))
    this.vipRoomTileSet = new Set(cfg.vipRoomTiles.map(t => t.row * GRID_COLS + t.col))

    this.broadcast('maze_rebuild', this.buildMazeRebuildPayload())
    console.log(`[GameRoom] Maze applied: ${cfg.templateId}`)
  }

  private startGame() {
    this.state.phase         = 'playing'
    this.state.timeRemaining = cfg.GAME_DURATION_S

    const queued = [...this.state.players.values()].filter(p => p.inQueue)
    this.assignTeams(queued)

    if (!this.state.vip.active || !this.mazeConfig) this.prepareMazeForMatch()

    // VIP-room doors are already SOLID and all pre-unlocked from applyMazeConfig;
    // no re-blocking needed. vipRoomLocked stays false — bodyguards can open
    // the doors immediately on first click.
    this.vipDoorUnlockTimer = 0
    this.state.vip.followerId = ''
    this.state.vip.lastMoveAt = Date.now()

    const usedSpawns = new Set<number>()
    const pool = this.mazeConfig?.spawnPool ?? []

    for (const [sid, p] of this.state.players.entries()) {
      if (p.team === 'none') continue
      const spawn = this.pickSpawnTile(pool, usedSpawns)
      p.tileCol = spawn.col; p.tileRow = spawn.row
      usedSpawns.add(spawn.row * GRID_COLS + spawn.col)
      p.zone = 'game'; p.health = cfg.PLAYER_MAX_HP; p.maxHealth = cfg.PLAYER_MAX_HP
      p.isAlive = true; p.inQueue = false
      // Reset inventory + stance every match.
      p.rightHand = 'none'
      p.leftHand  = 'none'
      p.shieldHP  = 0; p.shieldMaxHP = 0
      p.defending = false
      const wx = spawn.col * 2 + 1, wy = 15.5, wz = spawn.row * 2 + 1
      this.clients.find(c => c.sessionId === sid)?.send('teleport', { x: wx, y: wy, z: wz, cx: wx, cy: wy, cz: wz + 1 })
    }

    this.state.queueCount = 0
    this.npcTimer = 0; this.itemTimer = 0
    this.vipTargetId = ''; this.vipTargetTimer = 0; this.state.vip.targetName = ''

    // In cfg.EMPTY_ARENA_MODE, place one permanent demo item of each type in a row
    // at fixed positions (row 9, cols 6-8) so testers can always find them.
    // Demo items use "{col}_{row}" keys so spawnItem() won't accidentally
    // overlap them. Each item is re-spawned immediately after pickup.
    if (cfg.EMPTY_ARENA_MODE) {
      this.demoTiles.clear()
      const DEMO_ITEM_ROW = 9
      const demoItemDefs: Array<{ col: number; type: string }> = [
        { col: 6, type: 'baton'  },
        { col: 7, type: 'shield' },
        { col: 8, type: 'bomb'   },
      ]
      for (const { col, type } of demoItemDefs) {
        const tileKey = `${col}_${DEMO_ITEM_ROW}`
        this.demoTiles.set(tileKey, type)
        const item = new ItemState()
        item.tileCol = col; item.tileRow = DEMO_ITEM_ROW; item.type = type; item.active = true
        this.state.items.set(tileKey, item)
      }
    }

    // Scatter a handful of items across the maze immediately at game start so
    // players have something to pick up right away. Player spawn tiles are
    // already set above, so spawnItem()'s isTileOccupied check will keep items
    // away from starting positions. Each call is independent — the shared
    // items map prevents two calls from placing items on the same tile.
    // In cfg.EMPTY_ARENA_MODE the three fixed demo items are enough — skip random spawns.
    if (!cfg.EMPTY_ARENA_MODE) {
      for (let i = 0; i < cfg.ITEM_INITIAL_COUNT; i++) this.spawnItem()
    }

    console.log(`[GameRoom] Game started — ${queued.length} players (${this.state.mazeTemplateId})`)
  }

  private assignTeams(queued: PlayerState[]) {
    for (let i = queued.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [queued[i], queued[j]] = [queued[j], queued[i]]
    }
    const half = Math.ceil(queued.length / 2)
    queued.forEach((p, i) => { p.team = i < half ? 'bodyguard' : 'hater' })
  }

  private pickSpawnTile(pool: Array<{ col: number; row: number }>, used: Set<number>): { col: number; row: number } {
    if (pool.length === 0) return { col: 0, row: 0 }
    for (let i = 0; i < 20; i++) {
      const t = pool[(Math.random() * pool.length) | 0]
      const k = t.row * GRID_COLS + t.col
      if (!used.has(k) && !this.isTileOccupied(t.col, t.row)) return t
    }
    for (const t of pool) {
      const k = t.row * GRID_COLS + t.col
      if (!used.has(k) && !this.isTileOccupied(t.col, t.row)) return t
    }
    return pool[0]
  }

  // ── Admin commands ───────────────────────────────────────────────────────
  // Called by the onConfigChange listener on every successful JSON reload.
  // Edge-trigger semantics: actions fire once per transition, not every reload.

  private processAdminCommands(c: typeof cfg): void {
    // FORCE_START_GAME — edge-trigger false→true.
    // From 'lobby': auto-enqueue every player still in lobby zone, then start.
    // From 'countdown': skip the remaining countdown.
    // Otherwise: ignored.
    if (c.FORCE_START_GAME && !this._lastForceStart) {
      if (this.state.phase === 'lobby') {
        let enqueued = 0
        for (const p of this.state.players.values()) {
          if (p.zone === 'lobby' && p.connected && !p.inQueue) {
            p.inQueue = true
            enqueued++
          }
        }
        this.state.queueCount = [...this.state.players.values()].filter(p => p.inQueue).length
        console.log(`[GameRoom] Admin FORCE_START_GAME: auto-queued ${enqueued} players, starting now`)
        this.startGame()
      } else if (this.state.phase === 'countdown') {
        console.log('[GameRoom] Admin FORCE_START_GAME: skipping countdown')
        this.startGame()
      } else {
        console.log(`[GameRoom] Admin FORCE_START_GAME ignored (phase=${this.state.phase})`)
      }
    }
    this._lastForceStart = c.FORCE_START_GAME

    // FORCE_END_GAME — edge-trigger false→true. Only meaningful during 'playing'.
    if (c.FORCE_END_GAME && !this._lastForceEnd) {
      if (this.state.phase === 'playing') {
        console.log('[GameRoom] Admin FORCE_END_GAME: ending match (draw / admin_end)')
        this.endGame('draw', 'admin_end')
      } else {
        console.log(`[GameRoom] Admin FORCE_END_GAME ignored (phase=${this.state.phase})`)
      }
    }
    this._lastForceEnd = c.FORCE_END_GAME

    // ADD_TIME_S — apply once per value-change to a non-zero number, while
    // 'playing'. Negative values shrink time; 0 = reset slot (no action).
    if (c.ADD_TIME_S !== this._lastAddTime) {
      if (c.ADD_TIME_S !== 0 && this.state.phase === 'playing') {
        const before = this.state.timeRemaining
        this.state.timeRemaining = Math.max(0, this.state.timeRemaining + c.ADD_TIME_S)
        console.log(`[GameRoom] Admin ADD_TIME_S=${c.ADD_TIME_S}: timeRemaining ${Math.round(before)}s → ${Math.round(this.state.timeRemaining)}s`)
      } else if (c.ADD_TIME_S !== 0) {
        console.log(`[GameRoom] Admin ADD_TIME_S=${c.ADD_TIME_S} ignored (phase=${this.state.phase})`)
      }
      this._lastAddTime = c.ADD_TIME_S
    }
  }

  // ── Immortality ──────────────────────────────────────────────────────────
  // Called from every code path that brings a player's health to 0. When
  // IMMORTALITY_MODE is on, instead of dying the player teleports to a random
  // spawn tile and gets full HP back. Shield is NOT restored (a save isn't a
  // free shield refill). Returns true if the player was saved (caller skips
  // the normal death branch).

  private tryImmortalSave(sessionId: string, p: PlayerState): boolean {
    if (!cfg.IMMORTALITY_MODE) return false
    const pool = this.mazeConfig?.spawnPool ?? []
    if (pool.length === 0) return false

    const used = new Set<number>()
    const spawn = this.pickSpawnTile(pool, used)
    p.tileCol = spawn.col
    p.tileRow = spawn.row
    p.health  = p.maxHealth
    // Keep p.isAlive = true; p.killerId stays as-is (or empty).
    const wx = spawn.col * 2 + 1, wz = spawn.row * 2 + 1
    this.clients.find(c => c.sessionId === sessionId)
      ?.send('teleport', { x: wx, y: 15.5, z: wz })
    console.log(`[GameRoom] Immortal save: ${sessionId} → (${spawn.col}, ${spawn.row}) HP=${p.health}`)
    return true
  }

  // VIP variant — moves the VIP to a random spawn tile and refills HP. Returns
  // true if the VIP was saved (caller skips `endGame('haters', 'vip_killed')`).
  private tryImmortalSaveVip(): boolean {
    if (!cfg.IMMORTALITY_MODE) return false
    const pool = this.mazeConfig?.spawnPool ?? []
    if (pool.length === 0) return false

    const vip = this.state.vip
    const used = new Set<number>()
    const spawn = this.pickSpawnTile(pool, used)
    vip.tileCol = spawn.col
    vip.tileRow = spawn.row
    vip.health  = vip.maxHealth
    vip.lastMoveAt = Date.now()
    // Broadcast the new tile is implicit via state replication; clients smooth
    // the VIP's move themselves. No explicit message needed.
    this.vipWasHitByHater = false
    this.vipFleeing       = false
    console.log(`[GameRoom] Immortal save (VIP) → (${spawn.col}, ${spawn.row}) HP=${vip.health}`)
    return true
  }

  // ── VIP safe-zone arrival ───────────────────────────────────────────────
  // Server-side tile updates land instantly, but the client interpolates VIP
  // movement over ANIM_BASE_MS (~850 ms). Calling endGame() the moment the tile
  // changes ends the match BEFORE the player visually sees VIP arrive. Instead
  // we flip `reachedSafe` (freezes movement + blocks further damage) and delay
  // the win by VIP_SAFE_WIN_DELAY_MS so the avatar finishes its walk first.
  //
  // Re-entrancy: re-calling while reachedSafe is true is a no-op (idempotent).
  // endGame() itself also guards against being called twice via the phase check.

  private readonly VIP_SAFE_WIN_DELAY_MS = 1000

  private triggerVipSafeWin(): void {
    const vip = this.state.vip
    if (vip.reachedSafe) return            // already scheduled
    if (this.state.phase !== 'playing') return
    vip.reachedSafe = true
    setTimeout(() => this.endGame('bodyguards', 'vip_safe'), this.VIP_SAFE_WIN_DELAY_MS)
  }

  private endGame(winner: string, reason: string) {
    if (this.state.phase !== 'playing') return
    this.state.phase  = 'ended'
    this.state.winner = winner
    this.state.vip.active = false
    this.endTimer = 0
    this.pendingAttacks.clear()
    this.state.bombs.clear()
    // Items on the floor are match-scoped — clear them here, not in
    // resetToLobby, so they vanish the moment the game ends instead of
    // lingering on the maze through the cfg.END_LINGER_S countdown.
    this.state.items.clear()

    const result = new GameResult()
    result.winner    = winner
    result.reason    = reason
    result.endedAt   = Date.now()
    result.durationS = Math.max(0, Math.round(cfg.GAME_DURATION_S - this.state.timeRemaining))
    this.state.history.push(result)
    while (this.state.history.length > 5) this.state.history.shift()
    console.log(`[GameRoom] History recorded: ${winner}/${reason} (${result.durationS}s); total=${this.state.history.length}`)

    // Players stay in the game zone during the cfg.END_LINGER_S results screen.
    // resetToLobby() will teleport them to lobby once the countdown expires.
    this.broadcast('game_ended', { winner, reason })
    console.log(`[GameRoom] Ended — winner: ${winner}, reason: ${reason}`)
  }

  private resetToLobby() {
    this.state.phase = 'lobby'; this.state.winner = ''; this.state.queueCount = 0
    this.endTimer = 0; this.vipTargetId = ''; this.vipTargetTimer = 0
    this.state.vip.targetName = ''
    this.state.vip.active     = false
    this.state.vip.followerId = ''
    this.vipFleeing      = false
    this.vipFleeLastDir  = null
    this.vipFleeOrigin   = null
    this.vipWasHitByHater = false
    this.vipDeadEndEscape = null
    this.vipAvoidTile     = null
    for (const [sid, p] of this.state.players.entries()) {
      if (p.zone !== 'lobby') {
        this.clients.find(c => c.sessionId === sid)
          ?.send('teleport', { x: 8, y: 1.1, z: 4, cx: 16, cy: 1.1, cz: 16, spectating: false })
      }
      p.inQueue = false; p.team = 'none'; p.zone = 'lobby'
    }
    this.state.items.clear()
    this.state.bombs.clear()
    this.pendingAttacks.clear()
    this.doorOpener.clear()
    this.doorClaim.clear()
    this.trappedDoors.clear()
    this.demoTiles.clear()
    this.unlockedVipRoomDoors.clear()
    this.playerBackup.clear()
    this._mazePrepared = false
    this.mazeConfig    = null

    for (let i = 0; i < this.state.wallTypes.length; i++) {
      this.state.wallTypes[i]      = WALL_NONE
      this.state.wallStates[i]     = STATE_SOLID
      this.state.wallHP[i]         = 0
      this.state.wallMaxHP[i]      = 0
      this.state.wallClaimTeams[i] = 0
      this.state.wallClaimAck[i]   = 0
    }
    this.state.mazeTemplateId   = ''
    this.state.vipRoomLocked    = true
    this.safetyTileSet  = new Set()
    this.vipRoomTileSet = new Set()

    this.broadcast('maze_rebuild', this.buildMazeRebuildPayload())
    console.log('[GameRoom] Maze cleared (lobby)')
  }

  // ── Maze ─────────────────────────────────────────────────────────────────

  private buildMazeRebuildPayload() {
    return {
      wallTypes:        [...this.state.wallTypes],
      wallStates:       [...this.state.wallStates],
      wallHP:           [...this.state.wallHP],
      wallMaxHP:        [...this.state.wallMaxHP],
      templateId:       this.state.mazeTemplateId,
      vipRoomTiles:     this.mazeConfig?.vipRoomTiles  ?? [],
      vipRoomDoors:     this.mazeConfig?.vipRoomDoors  ?? [],
      safetyTiles:      this.mazeConfig?.safetyTiles   ?? [],
      vipRoomLocked:    this.state.vipRoomLocked,
    }
  }

  // Pick a random STILL-blocked VIP-room door and unblock it (state goes from
  // BLOCKED → SOLID = closed-but-openable). Players + VIP can now click /
  // path through it. After all doors are eventually unblocked this is a no-op.
  private unlockOneVipRoomDoor() {
    if (!this.mazeConfig) return
    const remaining = this.mazeConfig.vipRoomDoors.filter(
      d => !this.unlockedVipRoomDoors.has(d)
    )
    if (remaining.length === 0) return
    const pick = remaining[(Math.random() * remaining.length) | 0]
    this.unlockedVipRoomDoors.add(pick)
    this.state.wallStates[pick]     = STATE_SOLID
    // Clear bodyguard claim and hater ack-bit so the door goes back to neutral
    // AMBER for all teams and becomes openable by anyone (the "lock" is lifted).
    this.state.wallClaimTeams[pick] = 0
    this.state.wallClaimAck[pick]   = 0
    // Locked perimeter doors are stored with hp=maxHp=0 (indestructible).
    // Now that this one is unlocked it joins the regular destructible-wood-door
    // pool — grant it full HP so it can be broken like any other corridor door.
    const rHp = randomWallHp(WALL_WOOD_DOOR)
    this.state.wallHP[pick]    = rHp
    this.state.wallMaxHP[pick] = rHp
    if (this.state.vipRoomLocked) this.state.vipRoomLocked = false
    this.broadcast('vip_door_unlocked', { wallIdx: pick })
  }

  // ── Phase 6: VIP follow / movement ───────────────────────────────────────

  private handleFollowVip(sessionId: string) {
    const p = this.state.players.get(sessionId)
    const vip = this.state.vip
    if (!p || !vip.active || p.team !== 'bodyguard' || !p.isAlive || p.zone !== 'game') return
    // Bodyguard must be reasonably close to the VIP to claim the follow slot.
    const manh = Math.abs(p.tileCol - vip.tileCol) + Math.abs(p.tileRow - vip.tileRow)
    if (manh > 3) return
    vip.followerId = sessionId
    vip.targetName = p.displayName || sessionId.slice(0, 6)
    console.log(`[GameRoom] VIP now following ${sessionId} (${vip.targetName})`)
  }

  // Periodic re-validation of the follower (every VIP_TARGET_SWITCH_MS).
  // Drops the follower if they died, left, or wandered too far away.
  private refreshVipFollower() {
    const vip = this.state.vip
    if (!vip.active) { vip.followerId = ''; vip.targetName = ''; return }
    const f = vip.followerId ? this.state.players.get(vip.followerId) : null
    if (!f || !f.isAlive || f.zone !== 'game' || f.team !== 'bodyguard' || !f.connected) {
      vip.followerId = ''; vip.targetName = ''
    }
  }

  // VIP move tick. State-machine:
  //   1. Bodyguard adjacent → exit fleeing mode (the "stops on meeting a
  //      bodyguard" half of the flee contract).
  //   2. Hater adjacent + no protector
  //        • Inside spawn room → commit to a random unblocked spawn-room
  //          door whose OUTSIDE tile is farther from the hater. Step one
  //          tile along the path; if VIP crosses the door, block it
  //          behind her. Sets vipFleeing = true.
  //        • Outside spawn room → single-step away (existing logic).
  //          Sets vipFleeing = true.
  //   3. vipFleeing & no current threat → wander step (random valid neighbour,
  //      biased toward continuing in the last direction so VIP doesn't loop
  // VIP move tick. State machine:
  //   1. Bodyguard adjacent → exit flee/bypass, resume escort.
  //   2. Hater adjacent + no shield bodyguard:
  //        a. Bypass phase (up to VIP_BYPASS_MS): VIP pathfinds around the
  //           hater toward her bodyguard, treating all hater tiles as blocked.
  //           She does NOT enter flee mode yet.
  //        b. Bypass grace expired → detach from bodyguard, enter flee mode.
  //   3. No adjacent hater → clear bypass timer (hater moved away).
  //   4. Wander/flee mode: keep running until dead-end or bodyguard arrives.
  //   5. Escort mode: follow bodyguard, preferring the "shield" tile that
  //      places the bodyguard between VIP and the nearest hater.
  /** Compute DCL yaw angle (degrees) from a tile delta.
   *  DCL: yaw=0 → facing -Z (north), yaw=90 → +X (east), yaw=180 → +Z (south). */
  private tileYaw(dcol: number, drow: number): number {
    return Math.atan2(dcol, drow) * (180 / Math.PI)
  }

  /** Return the nearest live player (any team) within 1 Manhattan tile, or null. */
  private nearestAdjacentPlayer(col: number, row: number): { tileCol: number; tileRow: number } | null {
    let best: { tileCol: number; tileRow: number } | null = null
    let bestDist = 2
    for (const p of this.state.players.values()) {
      if (!p.isAlive || p.zone !== 'game') continue
      const d = Math.abs(p.tileCol - col) + Math.abs(p.tileRow - row)
      if (d >= 1 && d < bestDist) { best = p; bestDist = d }
    }
    return best
  }

  private moveNpc() {
    const vip = this.state.vip
    if (!vip.active) return
    // Once VIP has reached the safety tile we freeze her in place until the
    // delayed bodyguard-win endGame fires (see triggerVipSafeWin). Without
    // this guard the NPC tick could keep her wandering during the visual
    // interpolation window.
    if (vip.reachedSafe) return

    // Idle facing: rotate toward nearest adjacent player (overridden by
    // stepVipNormal / stepVipFleeing if VIP actually moves this tick).
    const nearForFacing = this.nearestAdjacentPlayer(vip.tileCol, vip.tileRow)
    if (nearForFacing) {
      const newYaw = this.tileYaw(nearForFacing.tileCol - vip.tileCol, nearForFacing.tileRow - vip.tileRow)
      if (Math.abs(newYaw - vip.facingYaw) > 5) vip.facingYaw = newYaw
    }

    // VIP naturally cannot leave the spawn room while all doors are SOLID —
    // the escort pathfinder uses actual wallStates (not the flee-passable view),
    // so VIP only moves out once a bodyguard opens a door (STATE_OPEN).
    // No explicit vipRoomLocked check needed.

    const wt  = this.state.wallTypes  as unknown as number[]
    const ws  = this.state.wallStates as unknown as number[]
    const now = Date.now()

    // Idle-push: if VIP is currently stuck in a dead-end (≤ 1 exits) and an
    // adjacent hater has not attacked for DEAD_END_IDLE_PUSH_MS, force-push
    // that hater to a free neighbour so VIP gets a window to escape.
    {
      const dirs4: Array<[number,number]> = [[0,1],[0,-1],[1,0],[-1,0]]
      let exits4 = 0
      for (const [dc4, dr4] of dirs4) {
        const nc4 = vip.tileCol + dc4, nr4 = vip.tileRow + dr4
        if (this.tileInBounds(nc4, nr4) &&
            canMoveBetween(vip.tileCol, vip.tileRow, nc4, nr4, wt, ws)) exits4++
      }
      if (exits4 <= 1 && this.vipWasHitByHater) {
        const blocker = this.findAdjacentHater(vip.tileCol, vip.tileRow, wt, ws)
        if (blocker && now - blocker.lastDealtTime > this.DEAD_END_IDLE_PUSH_MS) {
          const beforeCol = blocker.tileCol, beforeRow = blocker.tileRow
          const pushed = this.forceKnockbackToFreeNeighbour(
            blocker, vip.tileCol, vip.tileRow, wt, ws
          )
          if (pushed && (blocker.tileCol !== beforeCol || blocker.tileRow !== beforeRow)) {
            const sid = [...this.state.players.entries()]
              .find(([, p]) => p === blocker)?.[0]
            if (sid) {
              const wx = blocker.tileCol * 2 + 1, wz = blocker.tileRow * 2 + 1
              this.clients.find(c => c.sessionId === sid)?.send('teleport', { x: wx, y: 15.5, z: wz })
            }
            // Refresh the timer so the hater gets a fresh window before next push.
            blocker.lastDealtTime = now
          }
        }
      }
    }

    // Dead-end escape: if VIP was cornered and hit, take one step toward the
    // hater's former tile (now free after knockback) before normal flee logic.
    if (this.vipDeadEndEscape) {
      const esc = this.vipDeadEndEscape
      this.vipDeadEndEscape = null
      if (canMoveBetween(vip.tileCol, vip.tileRow, esc.col, esc.row, wt, ws) &&
          !this.isTileOccupied(esc.col, esc.row) &&
          !this.safetyTileSet.has(esc.row * GRID_COLS + esc.col)) {
        // Activate full flee mode from this dead-end so VIP keeps running
        // toward open space even after the hater is no longer adjacent.
        if (!this.vipFleeing) {
          this.vipFleeing    = true
          this.vipFleeOrigin = { col: vip.tileCol, row: vip.tileRow }
        }
        this.stepVipNormal(vip, esc)
        return
      }
    }

    // 1. Bodyguard adjacent → exit flee/bypass, resume escort.
    const adjBGEntry = this.findAdjacentBodyguardEntry(vip.tileCol, vip.tileRow)
    if (this.vipFleeing && adjBGEntry) {
      this.vipFleeing      = false
      this.vipFleeLastDir  = null
      this.vipFleeOrigin   = null
      this.vipWasHitByHater = false
      this.vipDeadEndEscape = null
      this.vipAvoidTile     = null
      // VIP exits flee when a bodyguard is adjacent — she stops running.
      // followerId is only set when a bodyguard explicitly clicks VIP (handleFollowVip).
    }

    // 2. Hater adjacent.
    const adjHater = this.findAdjacentHater(vip.tileCol, vip.tileRow, wt, ws)
    if (adjHater) {
      // If BG is adjacent to VIP, try to slide behind BG first before fleeing.
      // Reuse adjBGEntry from step 1 (already computed) to avoid a redundant scan.
      // If a BG is adjacent, restore the escort relationship immediately so the
      // VIP never loses her bodyguard just because followerId was cleared during
      // a previous bypass/flee episode.
      if (adjBGEntry) {
        const [adjBGSid, adjBG] = adjBGEntry
        // Adjacent BG shields VIP from the hater — no followerId override here.
        // VIP uses adjBG for shield positioning directly (no followerId needed).
        // followerId is only set by an explicit bodyguard click (handleFollowVip).
        const shield = this.pickShieldTile(adjBG, adjHater, wt, ws)
        if (shield && !(shield.col === vip.tileCol && shield.row === vip.tileRow)) {
          // Exclude BG's tile from the path so VIP routes AROUND the bodyguard
          // instead of stepping onto her tile (co-location causes a 1-tick stall).
          // In a maze there's almost always an alternate route; in an open arena
          // findPath simply goes 1 step wide before converging on the shield tile.
          const blockedForShield = new Set(this.haterTileSet())
          blockedForShield.add(adjBG.tileRow * GRID_COLS + adjBG.tileCol)
          const path = findPath({ col: vip.tileCol, row: vip.tileRow }, shield, wt, ws, blockedForShield)
          if (path.length >= 2) { this.stepVipNormal(vip, path[1]); return }
        }
        // Already at shield or no path around BG — BG is adjacent so stay in place.
        return
      }

      // No adjacent BG.
      // Before any flee/stop reaction — try to path around the hater to
      // continue following the bodyguard. If an unblocked route exists
      // (hater tiles excluded), take one step. No threat reaction needed.
      {
        const follower = vip.followerId ? this.state.players.get(vip.followerId) : null
        if (follower && follower.isAlive && follower.zone === 'game') {
          const haterBlocked = this.haterTileSet()
          const target = this.pickShieldTile(follower, adjHater, wt, ws)
            ?? { col: follower.tileCol, row: follower.tileRow }
          const path = findPath({ col: vip.tileCol, row: vip.tileRow }, target, wt, ws, haterBlocked)
          if (path.length >= 2) {
            this.stepVipNormal(vip, path[1])
            return
          }
        }
      }
      // Truly blocked — no path around hater exists.
      // VIP only flees / bypasses if she has been hit at least once.
      if (!this.vipWasHitByHater) return

      // Record (or refresh) the flee origin so step 4 can measure distance.
      this.vipFleeOrigin = { col: vip.tileCol, row: vip.tileRow }

      if (!this.vipFleeing) {
        // ── Tile-count bypass: find a short path around the hater to the BG ──
        // If VIP has a follower bodyguard, try to pathfind to the shield tile
        // (behind BG, away from hater). Path must be ≤ cfg.VIP_BYPASS_TILES long.
        // Hater tiles are blocked so the route is guaranteed to avoid them.
        const follower = vip.followerId ? this.state.players.get(vip.followerId) : null
        if (follower && follower.isAlive && follower.zone === 'game') {
          const fleeStates = this.vipFleePassableStates(wt, ws)
          const haterTiles = this.fleeBlockedSet()
          const shieldTile = this.pickShieldTile(follower, adjHater, wt, ws)
            ?? { col: follower.tileCol, row: follower.tileRow }
          const path = findPath(
            { col: vip.tileCol, row: vip.tileRow },
            shieldTile, wt, fleeStates, haterTiles
          )
          // path.length - 1 = number of steps (path includes start tile)
          if (path.length >= 2 && path.length - 1 <= cfg.VIP_BYPASS_TILES) {
            const next = path[1]
            if (next.col !== follower.tileCol || next.row !== follower.tileRow) {
              this.stepVipNormal(vip, next)
              return
            }
          }
          // Path not found or too long — fall through to flee.
        }
      }

      // ── Flee phase ────────────────────────────────────────────────────
      const fleeStates = this.vipFleePassableStates(wt, ws)
      const inRoom = this.vipRoomTileSet.has(vip.tileRow * GRID_COLS + vip.tileCol)
      if (inRoom) {
        const exit = this.pickRandomRoomExitTarget(vip, adjHater)
        if (exit) {
          const haterTiles = this.fleeBlockedSet()
          const path = findPath(
            { col: vip.tileCol, row: vip.tileRow },
            exit, wt, fleeStates, haterTiles
          )
          if (path.length >= 2) { this.stepVipFleeing(vip, path[1]); return }
        }
      }
      // When already fleeing: use the scored pathfinder (pickVipFleeDest)
      // which gives a bonus to tiles across doors. This guides VIP through
      // doors instead of oscillating 1-step back-and-forth with the hater.
      if (this.vipFleeing) {
        const fleeTarget = this.pickVipFleeDest(vip, wt, ws, false)
        if (fleeTarget) {
          const haterTiles = this.fleeBlockedSet()
          const path = findPath({ col: vip.tileCol, row: vip.tileRow }, fleeTarget, wt, fleeStates, haterTiles)
          if (path.length >= 2) {
            const next    = path[1]
            const curMin  = this.minDistFromHaters(vip.tileCol, vip.tileRow)
            const nextMin = this.minDistFromHaters(next.col, next.row)
            // Only take this step if it doesn't move VIP closer to any hater.
            // If the maze forces an initial step toward a hater (to route around
            // it), we fall through to the greedy pickFleeTile fallback instead.
            if (nextMin >= curMin) { this.stepVipFleeing(vip, next); return }
          }
        }
      }
      // First flee step or no smart path found: greedy 1-step away from hater.
      const flee = this.pickFleeTile(vip, adjHater, wt, fleeStates)
      if (flee) this.stepVipFleeing(vip, flee)
      return
    }

    // 3. No adjacent hater — vipWasHitByHater stays set; flee continues if active.

    // 4. Flee mode: VIP actively seeks the tile maximally far from all haters,
    //    routing through closed doors. She stops once she is cfg.VIP_FLEE_TILES
    //    Manhattan tiles away from the last hater encounter (vipFleeOrigin).
    //    If a hater catches up during the flee the counter resets from the
    //    new position (origin is updated in step 2 above).
    if (this.vipFleeing) {
      const tilesAway = this.vipFleeOrigin
        ? Math.abs(vip.tileCol - this.vipFleeOrigin.col) + Math.abs(vip.tileRow - this.vipFleeOrigin.row)
        : cfg.VIP_FLEE_TILES   // no origin → treat as done
      const fleeDone = tilesAway >= cfg.VIP_FLEE_TILES

      if (fleeDone) {
        // If already on a non-door tile, stop immediately.
        if (!this.isDoorAdjacent(vip.tileCol, vip.tileRow, wt)) {
          this.vipFleeing       = false
          this.vipFleeLastDir   = null
          this.vipFleeOrigin    = null
          this.vipAvoidTile     = null
          this.vipWasHitByHater = false   // must be hit again to trigger next flee
          return
        }
        // Otherwise take one more step toward the nearest safe (non-door) tile.
        const stopTile = this.pickVipFleeDest(vip, wt, ws, true)
        if (stopTile) {
          const fleeStates = this.vipFleePassableStates(wt, ws)
          const haterTiles = this.fleeBlockedSet()
          const path = findPath({ col: vip.tileCol, row: vip.tileRow }, stopTile, wt, fleeStates, haterTiles)
          if (path.length >= 2) { this.stepVipFleeing(vip, path[1]); return }
        }
        // No safe tile reachable — stop here anyway.
        this.vipFleeing       = false
        this.vipFleeLastDir   = null
        this.vipFleeOrigin    = null
        this.vipAvoidTile     = null
        this.vipWasHitByHater = false   // must be hit again to trigger next flee
        return
      }

      // Still within flee window: pathfind toward the tile that is farthest
      // from all haters and reachable through passable doors.
      const remainingTiles = cfg.VIP_FLEE_TILES - tilesAway
      const fleeTarget = this.pickVipFleeDest(vip, wt, ws, false)
      if (fleeTarget) {
        const fleeStates = this.vipFleePassableStates(wt, ws)
        const haterTiles = this.fleeBlockedSet()
        const path = findPath({ col: vip.tileCol, row: vip.tileRow }, fleeTarget, wt, fleeStates, haterTiles)
        if (path.length >= 2) {
          const next = path[1]
          // Check whether the next step crosses a door. VIP only crosses a
          // door if there are ≥ 2 remaining flee tiles — enough to take the
          // crossing step AND then at least one step past the door-adjacent
          // tile before stopping. If the budget is too tight we fall through
          // to the random-wander fallback which avoids committing to a door.
          const crossWall    = wallIdxBetween({ col: vip.tileCol, row: vip.tileRow }, next)
          const crossesDoor  = crossWall >= 0 && wt[crossWall] === WALL_WOOD_DOOR
          if (!crossesDoor || remainingTiles >= 2) {
            // Guard: don't take a step that moves VIP closer to any hater.
            // pickVipFleeDest optimises the DESTINATION, not the first step —
            // maze topology can force the route to initially close on a hater
            // before curving away. When that happens, fall back to wander.
            const curMin  = this.minDistFromHaters(vip.tileCol, vip.tileRow)
            const nextMin = this.minDistFromHaters(next.col, next.row)
            if (nextMin >= curMin) {
              this.stepVipFleeing(vip, next)
              return
            }
            // First step moves closer to a hater — fall through to wander.
          }
          // Not enough tiles to stop safely past the door (or first step toward
          // hater) — fall through to random wander.
        }
      }

      // No directed path found — fall back to random wander step.
      const step = this.pickRandomWanderStep(vip, wt, ws, this.vipFleeLastDir)
      if (!step) {
        this.vipFleeing       = false
        this.vipFleeLastDir   = null
        this.vipFleeOrigin    = null
        this.vipAvoidTile     = null
        this.vipWasHitByHater = false   // must be hit again to trigger next flee
        return
      }
      this.stepVipFleeing(vip, { col: step.col, row: step.row })
      return
    }

    // 4.5. Dead-end self-escape (no active threat, no flee mode).
    // If VIP wandered into a dead-end during normal movement and has a short
    // path back to the main labyrinth (≥2 exits), take one step toward it.
    // "Enough moves" = path length ≤ cfg.VIP_BYPASS_TILES tiles.
    if (!this.vipFleeing && !this.vipWasHitByHater) {
      const exits45 = this._tileExitCount(vip.tileCol, vip.tileRow, wt, ws)
      if (exits45 <= 1) {
        // Find the nearest main-labyrinth tile (≥2 exits), hater tiles blocked.
        const blocked45 = this.haterTileSet()
        let bestTarget: { col: number; row: number } | null = null
        let bestDist = Infinity
        for (let r = 0; r < GRID_ROWS; r++) {
          for (let c = 0; c < GRID_COLS; c++) {
            if (c === vip.tileCol && r === vip.tileRow) continue
            if (blocked45.has(r * GRID_COLS + c)) continue
            if (this._tileExitCount(c, r, wt, ws) < 2) continue
            const d = Math.abs(c - vip.tileCol) + Math.abs(r - vip.tileRow)
            if (d < bestDist) { bestDist = d; bestTarget = { col: c, row: r } }
          }
        }
        if (bestTarget) {
          const path45 = findPath(
            { col: vip.tileCol, row: vip.tileRow },
            bestTarget, wt, ws, blocked45
          )
          if (path45.length >= 2 && path45.length - 1 <= cfg.VIP_BYPASS_TILES) {
            this.stepVipNormal(vip, path45[1])
            return
          }
        }
      }
    }

    // 5. Escort: follow bodyguard. Target the "shield" tile behind the
    //    bodyguard so the bodyguard stands between VIP and the nearest hater.
    const f = vip.followerId ? this.state.players.get(vip.followerId) : null
    if (!f || !f.isAlive || f.zone !== 'game') return

    const manh = Math.abs(f.tileCol - vip.tileCol) + Math.abs(f.tileRow - vip.tileRow)

    if (manh <= 1) {
      if (manh === 0) return   // same tile — guard only
      if (canMoveBetween(vip.tileCol, vip.tileRow, f.tileCol, f.tileRow, wt, ws)) {
        // VIP is adjacent to BG. Check if a hater is within 2 tiles of VIP OR BG.
        // Radius 2 (not just adjacent) gives VIP time to pre-position before the
        // hater closes to attack range. Only triggers when there's an actual nearby
        // threat so VIP doesn't jitter unnecessarily during quiet escorting.
        const threatHater =
          this.findAdjacentHater(vip.tileCol, vip.tileRow, wt, ws) ??
          this.findAdjacentHater(f.tileCol,   f.tileRow,   wt, ws) ??
          this.findNearestHater(f.tileCol,    f.tileRow,    2)
        if (threatHater) {
          const shield = this.pickShieldTile(f, threatHater, wt, ws)
          if (shield && !(shield.col === vip.tileCol && shield.row === vip.tileRow)) {
            // Same BG co-location guard as step 2: route around the bodyguard's
            // tile so VIP never temporarily shares a tile and stalls there.
            const blockedForShield = new Set(this.haterTileSet())
            blockedForShield.add(f.tileRow * GRID_COLS + f.tileCol)
            const path = findPath({ col: vip.tileCol, row: vip.tileRow }, shield, wt, ws, blockedForShield)
            if (path.length >= 2) { this.stepVipNormal(vip, path[1]); return }
          }
        }
        return   // no threat nearby or already at shield — stay in place
      }
      // Wall between VIP and BG despite manh=1 — fall through to pathfind around.
    }

    // VIP not yet adjacent to bodyguard (manh > 1).
    // If there's a nearby hater (within 3 tiles of VIP or BG), aim for the
    // shield tile directly — this avoids the oscillation that occurs when step 2
    // repeatedly bounces VIP away from BG while step 5 keeps routing VIP back
    // toward BG's own tile. If no hater is close, simply follow BG.
    const blocked5 = this.haterTileSet()
    const nearHater = this.findNearestHater(vip.tileCol, vip.tileRow, 3)
      ?? this.findNearestHater(f.tileCol, f.tileRow, 3)
    let targetCol = f.tileCol, targetRow = f.tileRow
    if (nearHater) {
      const shield5 = this.pickShieldTile(f, nearHater, wt, ws)
      if (shield5) {
        targetCol = shield5.col; targetRow = shield5.row
        // Block BG's tile so VIP routes AROUND the bodyguard (same co-location
        // guard as step 2). Only applied when targeting the shield tile (hater
        // nearby) — when no hater the target IS BG's tile, so we must not block it.
        blocked5.add(f.tileRow * GRID_COLS + f.tileCol)
      }
    }
    const path5 = findPath(
      { col: vip.tileCol, row: vip.tileRow },
      { col: targetCol,   row: targetRow   },
      wt, ws, blocked5
    )
    if (path5.length >= 2) this.stepVipNormal(vip, path5[1])
  }

  // Move VIP one tile during escort or bypass (no flee flag, no door-blocking).
  private stepVipNormal(vip: VIPState, next: { col: number; row: number }) {
    // Check if VIP is crossing through a door that still has a trap bomb on
    // it. This handles the edge case where a hater opened the door from their
    // own side (sameSide=true in triggerDoorBombsOnOpen → trap survived),
    // leaving it STATE_OPEN but with the trap still active. Since the door is
    // already open no state manipulation is needed — the blast wave reaches
    // both sides freely.
    const wallIdx = wallIdxBetween({ col: vip.tileCol, row: vip.tileRow }, next)
    if (wallIdx >= 0 && this.trappedDoors.has(wallIdx)) {
      this.triggerDoorBombsOnOpen(wallIdx, vip.tileCol, vip.tileRow)
    }
    vip.facingYaw  = this.tileYaw(next.col - vip.tileCol, next.row - vip.tileRow)
    vip.tileCol    = next.col
    vip.tileRow    = next.row
    vip.lastMoveAt = Date.now()
    // No door claiming during escort — VIP only blocks doors while fleeing.
    if (this.safetyTileSet.has(vip.tileRow * GRID_COLS + vip.tileCol)) {
      this.triggerVipSafeWin()
    }
  }

  // Returns the closest live hater to (col, row) within maxDist Manhattan
  // tiles, or null if none is close enough.
  private findNearestHater(col: number, row: number, maxDist: number): PlayerState | null {
    let best: PlayerState | null = null
    let bestDist = maxDist + 1
    for (const p of this.state.players.values()) {
      if (p.team !== 'hater' || p.zone !== 'game' || !p.isAlive) continue
      const d = Math.abs(p.tileCol - col) + Math.abs(p.tileRow - row)
      if (d < bestDist) { bestDist = d; best = p }
    }
    return best
  }

  // Returns the cardinal tile adjacent to the bodyguard that maximises
  // Manhattan distance from the given hater — i.e., the tile that places
  // the bodyguard between VIP and the threat. Returns null if all four
  // cardinal neighbours are walled off or occupied.
  private pickShieldTile(
    bg: PlayerState, hater: PlayerState, wt: number[], ws: number[]
  ): { col: number; row: number } | null {
    // All 8 neighbours of the bodyguard — cardinal + diagonal.
    // Cardinal candidates: must have no wall between BG and the tile (standard
    //   canMoveBetween check). They're the primary shelter choices.
    // Diagonal candidates: axis-aligned walls don't sit between diagonal tiles,
    //   so there's no wall to check — bounds check only. Included so that when
    //   the hater approaches from a diagonal direction, VIP hides squarely behind
    //   BG instead of ending up at an exposed cardinal neighbour.
    const cardinalDirs: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]]
    const diagonalDirs: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
    let best: { col: number; row: number; dist: number } | null = null

    for (const [dc, dr] of cardinalDirs) {
      const tc = bg.tileCol + dc, tr = bg.tileRow + dr
      if (tc < 0 || tc >= GRID_COLS || tr < 0 || tr >= GRID_ROWS) continue
      if (!canMoveBetween(bg.tileCol, bg.tileRow, tc, tr, wt, ws)) continue
      const dist = Math.abs(tc - hater.tileCol) + Math.abs(tr - hater.tileRow)
      if (!best || dist > best.dist) best = { col: tc, row: tr, dist }
    }

    for (const [dc, dr] of diagonalDirs) {
      const tc = bg.tileCol + dc, tr = bg.tileRow + dr
      if (tc < 0 || tc >= GRID_COLS || tr < 0 || tr >= GRID_ROWS) continue
      // A diagonal tile is only worth hiding in if it's clearly farther from
      // the hater than the best cardinal option — avoids unnecessary routing.
      const dist = Math.abs(tc - hater.tileCol) + Math.abs(tr - hater.tileRow)
      if (!best || dist > best.dist) best = { col: tc, row: tr, dist }
    }

    return best ? { col: best.col, row: best.row } : null
  }

  // Move VIP one tile while fleeing. Updates direction memory, blocks ONLY
  // the door VIP actually crossed (vipBlockDoorBehind), then triggers the
  // bodyguards-win check if she lands on a safety tile.
  //
  // We deliberately do NOT call autoClaimAdjacentDoorsForVip here. Claiming
  // every door adjacent to the destination tile would preemptively lock doors
  // that VIP hasn't yet passed through — haters approaching from another angle
  // would be blocked by doors VIP may never use. The claim on the already-
  // crossed door is maintained automatically by processDoorClaims as long as
  // VIP remains adjacent (isClaimantAdjacent returns true while VIP stands on
  // either tile flanking the door, so no re-claim call is needed).
  private stepVipFleeing(vip: VIPState, next: { col: number; row: number }) {
    const now = Date.now()
    const wallIdx = wallIdxBetween({ col: vip.tileCol, row: vip.tileRow }, next)
    // Trigger any bomb trap wired to the door VIP is phasing through.
    // VIP's current tile (before moving) is used as the "opener" position —
    // a bomb placed on the OPPOSITE side will detonate. This mirrors the same
    // logic used for players in handleDoor → triggerDoorBombsOnOpen.
    //
    // The door is temporarily set to STATE_OPEN before detonation so the
    // blast wave is not blocked by the door mesh — same approach as the
    // claim-blocked branch in handleDoor. vipBlockDoorBehind restores
    // ownership (STATE_BLOCKED) immediately after.
    if (wallIdx >= 0 && this.trappedDoors.has(wallIdx)) {
      const savedState = this.state.wallStates[wallIdx]
      this.state.wallStates[wallIdx] = STATE_OPEN
      this.triggerDoorBombsOnOpen(wallIdx, vip.tileCol, vip.tileRow)
      // Restore previous state only if detonation didn't already change it
      // (detonateBomb removes the bomb but does not touch wall state).
      if (this.state.wallStates[wallIdx] === STATE_OPEN) {
        this.state.wallStates[wallIdx] = savedState
      }
    }
    this.vipBlockDoorBehind(wallIdx)
    this.vipFleeLastDir = [next.col - vip.tileCol, next.row - vip.tileRow] as [number, number]
    vip.facingYaw  = this.tileYaw(next.col - vip.tileCol, next.row - vip.tileRow)
    vip.tileCol = next.col
    vip.tileRow = next.row
    vip.lastMoveAt = now
    this.vipFleeing = true
    if (this.safetyTileSet.has(vip.tileRow * GRID_COLS + vip.tileCol)) {
      this.triggerVipSafeWin()
    }
  }

  // Pick a random spawn-room exit whose OUTSIDE cell sits farther from the
  // given hater than VIP's current tile. Returns the outside cell to head
  // toward, or null if every reachable exit is closer (or all are blocked).
  private pickRandomRoomExitTarget(vip: VIPState, hater: PlayerState): { col: number; row: number } | null {
    if (!this.mazeConfig) return null
    const vipFromHater = Math.abs(vip.tileCol - hater.tileCol) + Math.abs(vip.tileRow - hater.tileRow)
    const farther:  Array<{ col: number; row: number; dist: number }> = []
    const fallback: Array<{ col: number; row: number; dist: number }> = []
    for (const doorIdx of this.mazeConfig.vipRoomDoors) {
      // Door must currently be openable for VIP — not still BLOCKED by the
      // 30-second unlock cadence, not destroyed.
      if (!this.unlockedVipRoomDoors.has(doorIdx)) continue
      const st = this.state.wallStates[doorIdx]
      if (st === STATE_DESTROYED || st === STATE_BLOCKED) continue
      const sides = this.wallSidesTiles(doorIdx)
      const aInRoom = this.vipRoomTileSet.has(sides.a.row * GRID_COLS + sides.a.col)
      const outside = aInRoom ? sides.b : sides.a
      if (!this.tileInBounds(outside.col, outside.row)) continue
      if (this.isTileOccupied(outside.col, outside.row)) continue
      const dist = Math.abs(outside.col - hater.tileCol) + Math.abs(outside.row - hater.tileRow)
      if (dist > vipFromHater) farther.push({ col: outside.col, row: outside.row, dist })
      else                     fallback.push({ col: outside.col, row: outside.row, dist })
    }
    const pool = farther.length > 0 ? farther : fallback
    if (pool.length === 0) return null
    return pool[(Math.random() * pool.length) | 0]
  }

  // Random walk step for the wander phase. Returns null if no neighbour is
  // reachable except by reversing direction — that means VIP just entered a
  // dead-end pocket and her flee ends. Same-direction continuation is preferred
  // (~60% when available) so she keeps making forward progress instead of
  // oscillating between two cells.
  private pickRandomWanderStep(
    vip: VIPState, wt: number[], ws: number[], lastDir: [number, number] | null
  ): { col: number; row: number; dir: [number, number] } | null {
    const passable = this.vipFleePassableStates(wt, ws)
    const dirs: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]]
    const reverse = lastDir ? [-lastDir[0], -lastDir[1]] : null
    const candidates: Array<[number, number]> = []
    for (const [dc, dr] of dirs) {
      if (reverse && reverse[0] === dc && reverse[1] === dr) continue
      const nc = vip.tileCol + dc, nr = vip.tileRow + dr
      if (!this.tileInBounds(nc, nr)) continue
      if (!canMoveBetween(vip.tileCol, vip.tileRow, nc, nr, wt, passable)) continue
      if (this.isTileOccupied(nc, nr)) continue
      if (this.safetyTileSet.has(nr * GRID_COLS + nc)) continue
      if (this.vipAvoidTile && nc === this.vipAvoidTile.col && nr === this.vipAvoidTile.row) continue
      candidates.push([dc, dr])
    }
    if (candidates.length === 0) return null   // dead-end
    if (lastDir) {
      const same = candidates.find(([dc, dr]) => dc === lastDir[0] && dr === lastDir[1])
      if (same && Math.random() < 0.6) {
        return { col: vip.tileCol + same[0], row: vip.tileRow + same[1], dir: same }
      }
    }
    const pick = candidates[(Math.random() * candidates.length) | 0]
    return { col: vip.tileCol + pick[0], row: vip.tileRow + pick[1], dir: pick }
  }

  // True if any of the four cardinal walls bordering (col, row) is a door.
  // Used to avoid stopping VIP next to a door at the end of a flee episode.
  private isDoorAdjacent(col: number, row: number, wt: number[]): boolean {
    const isDoor = (idx: number) => {
      if (idx < 0 || idx >= wt.length) return false
      return wt[idx] === WALL_WOOD_DOOR
    }
    return (row > 0           && isDoor(hWallIndex(row - 1, col)))
        || (row < GRID_ROWS-1 && isDoor(hWallIndex(row,     col)))
        || (col > 0           && isDoor(vWallIndex(row,     col - 1)))
        || (col < GRID_COLS-1 && isDoor(vWallIndex(row,     col)))
  }

  // Pick the tile that maximises minimum Manhattan distance from all live
  // haters. If `doorFree` is true the tile must not be adjacent to any door
  // (used for VIP's end-of-flee stopping position). Returns the best tile
  // that is also reachable from VIP via a path that treats SOLID doors as
  // passable (VIP can duck through unclaimed doors while fleeing).
  //
  // Door preference: tiles immediately beyond any door adjacent to VIP get
  // a bonus score so VIP actively seeks to cross doors as escape routes.
  // Once VIP crosses a door and blocks it behind her, haters can't follow.
  /** Count how many cardinal neighbours of (col, row) are passable (no wall). */
  private _tileExitCount(col: number, row: number, wt: number[], ws: number[]): number {
    let n = 0
    if (col > 0            && canMoveBetween(col, row, col - 1, row, wt, ws)) n++
    if (col < GRID_COLS-1  && canMoveBetween(col, row, col + 1, row, wt, ws)) n++
    if (row > 0            && canMoveBetween(col, row, col, row - 1, wt, ws)) n++
    if (row < GRID_ROWS-1  && canMoveBetween(col, row, col, row + 1, wt, ws)) n++
    return n
  }

  private pickVipFleeDest(
    vip: VIPState, wt: number[], ws: number[], doorFree: boolean
  ): { col: number; row: number } | null {
    const fleeStates = this.vipFleePassableStates(wt, ws)
    const haterTiles = this.fleeBlockedSet()

    // Collect live hater positions for distance scoring.
    const haterPos: Array<{ col: number; row: number }> = []
    for (const p of this.state.players.values()) {
      if (p.team === 'hater' && p.zone === 'game' && p.isAlive) {
        haterPos.push({ col: p.tileCol, row: p.tileRow })
      }
    }
    if (haterPos.length === 0) return null

    const minHaterDist = (c: number, r: number) =>
      Math.min(...haterPos.map(h => Math.abs(h.col - c) + Math.abs(h.row - r)))

    // Tiles directly on the far side of any door adjacent to VIP get a bonus
    // so VIP prefers to duck through doors as escape routes. After crossing,
    // she blocks the door behind her, separating herself from the pursuer.
    const DOOR_BONUS = 3
    const doorBonusTiles = new Set<number>()
    for (const doorIdx of this.adjacentDoorsTo(vip.tileCol, vip.tileRow)) {
      const sides = this.wallSidesTiles(doorIdx)
      const vipOnA = sides.a.col === vip.tileCol && sides.a.row === vip.tileRow
      const far = vipOnA ? sides.b : sides.a
      doorBonusTiles.add(far.row * GRID_COLS + far.col)
    }

    // Score every tile; keep top-20 candidates to try pathfinding into.
    // 20 attempts is negligible for A* on a 16×16 grid.
    const candidates: Array<{ col: number; row: number; score: number }> = []
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (c === vip.tileCol && r === vip.tileRow) continue
        if (haterTiles.has(r * GRID_COLS + c))         continue
        if (this.isTileOccupied(c, r))                 continue
        if (doorFree && this.isDoorAdjacent(c, r, wt)) continue
        // Never flee into the safety zone — prevents VIP from accidentally
        // winning the game on her own by running away from haters.
        if (this.safetyTileSet.has(r * GRID_COLS + c)) continue
        // Don't target the exact dead-end tile VIP just escaped from.
        if (this.vipAvoidTile && c === this.vipAvoidTile.col && r === this.vipAvoidTile.row) continue
        const hDist = minHaterDist(c, r)
        if (hDist < 2) continue   // skip tiles already too close to a hater

        // Only target main-labyrinth tiles (≥2 passable exits).
        // Dead-ends (≤1 exit) are never flee destinations — VIP may wander
        // into them naturally from the main part, but never aims for them.
        // Use flee-passable states so closed doors count as exits.
        const exits = this._tileExitCount(c, r, wt, fleeStates)
        if (exits <= 1) continue

        const doorBonus = doorBonusTiles.has(r * GRID_COLS + c) ? DOOR_BONUS : 0
        candidates.push({ col: c, row: r, score: hDist + doorBonus })
      }
    }

    candidates.sort((a, b) => b.score - a.score)

    for (const cand of candidates.slice(0, 30)) {
      const path = findPath(
        { col: vip.tileCol, row: vip.tileRow },
        { col: cand.col,    row: cand.row    },
        wt, fleeStates, haterTiles
      )
      if (path.length >= 2) return { col: cand.col, row: cand.row }
    }
    return null
  }

  private findAdjacentBodyguard(col: number, row: number): PlayerState | null {
    return this.findAdjacentBodyguardEntry(col, row)?.[1] ?? null
  }

  // Like findAdjacentBodyguard but also returns the sessionId so callers can
  // restore vip.followerId without a second O(n) scan.
  private findAdjacentBodyguardEntry(col: number, row: number): [string, PlayerState] | null {
    for (const [sid, p] of this.state.players.entries()) {
      if (p.team !== 'bodyguard' || p.zone !== 'game' || !p.isAlive || !p.connected) continue
      // Chebyshev ≤ 1: treat diagonal bodyguards as adjacent so VIP can hide
      // behind a bodyguard that stands diagonally next to her — without this
      // VIP would enter bypass/flee even when a bodyguard is right there.
      const dc = Math.abs(p.tileCol - col), dr = Math.abs(p.tileRow - row)
      if (dc <= 1 && dr <= 1 && (dc + dr) > 0) return [sid, p]
    }
    return null
  }

  private haterTileSet(): Set<number> {
    const out = new Set<number>()
    for (const p of this.state.players.values()) {
      if (p.team === 'hater' && p.zone === 'game' && p.isAlive) {
        out.add(p.tileRow * GRID_COLS + p.tileCol)
      }
    }
    return out
  }

  /** Like haterTileSet() but also includes safetyTileSet — used for all flee
   *  pathfinding so VIP never steps into the safe zone while running away. */
  private fleeBlockedSet(): Set<number> {
    const out = this.haterTileSet()
    for (const key of this.safetyTileSet) out.add(key)
    return out
  }

  private findAdjacentHater(
    col: number, row: number,
    wt?: number[], ws?: number[]
  ): PlayerState | null {
    for (const p of this.state.players.values()) {
      if (p.team !== 'hater' || p.zone !== 'game' || !p.isAlive) continue
      const dc = Math.abs(p.tileCol - col), dr = Math.abs(p.tileRow - row)
      if (dc > 1 || dr > 1 || (dc + dr) === 0) continue

      // Diagonal hater — game rules allow corner attacks regardless of walls.
      if (dc === 1 && dr === 1) { return p }

      // Cardinal hater — only a real threat if no wall blocks the path.
      // If wt/ws not supplied, fall back to "assume threat" (safe default).
      if (wt && ws && !canMoveBetween(col, row, p.tileCol, p.tileRow, wt, ws)) continue

      return p
    }
    return null
  }

  // Build a wall-state view where SOLID doors look OPEN, so VIP's flee-tile
  // search can route through closed-but-openable doors. BLOCKED doors stay
  // BLOCKED (impassable) — VIP can't break locked VIP-room doors or doors
  // currently jammed by a hostile.
  private vipFleePassableStates(wt: number[], ws: number[]): number[] {
    const out = ws.slice()
    for (let i = 0; i < wt.length; i++) {
      const t = wt[i]
      if (t !== WALL_WOOD_DOOR) continue
      if (out[i] === STATE_SOLID) { out[i] = STATE_OPEN; continue }
      // VIP can also cross doors she already claimed via vipBlockDoorBehind
      // (the door she just passed through is STATE_BLOCKED with VIP_CLAIM_SID).
      // Allow her flee-path to route back through it if needed (e.g. dead end).
      if (out[i] === STATE_BLOCKED) {
        const claim = this.doorClaim.get(i)
        if (!claim || claim.sid === GameRoom.VIP_CLAIM_SID) out[i] = STATE_OPEN
      }
    }
    return out
  }

  // VIP fled through `wallIdx`. She claims it for the bodyguard side —
  // chasing haters can't open it. The standard door-claim timer takes over
  // from here: when VIP later moves off the adjacent tile, DOOR_CLAIM_EXPIRE_MS
  // counts down and the door reverts to SOLID.
  private vipBlockDoorBehind(wallIdx: number) {
    if (wallIdx < 0 || wallIdx >= this.state.wallTypes.length) return
    const t = this.state.wallTypes[wallIdx]
    if (t !== WALL_WOOD_DOOR) return
    // If door was SOLID (closed), VIP is phasing through it — broadcast a
    // dedicated event so the client plays the flash animation only for this case.
    // (SOLID→BLOCKED from a player claim must not animate.)
    const wasSolid = this.state.wallStates[wallIdx] === STATE_SOLID
    this.doorClaim.set(wallIdx, { sid: GameRoom.VIP_CLAIM_SID, team: 'bodyguard', leftAt: 0 })
    this.state.wallStates[wallIdx] = STATE_BLOCKED  // closes if open, locks if solid
    this.state.wallClaimTeams[wallIdx] = 1   // bodyguard
    this.state.wallClaimAck[wallIdx]   = 0
    this.doorOpener.delete(wallIdx)
    if (wasSolid) this.broadcast('vip_door_crossed', { wallIdx })
  }

  // Cell-adjacency: returns wood-door wall indices at the 4 cardinal edges
  // of the given tile.
  private adjacentDoorsTo(col: number, row: number): number[] {
    const out: number[] = []
    const check = (idx: number) => {
      if (idx < 0 || idx >= this.state.wallTypes.length) return
      const t = this.state.wallTypes[idx]
      if (t === WALL_WOOD_DOOR) out.push(idx)
    }
    if (row > 0)              check(hWallIndex(row - 1, col))
    if (row < GRID_ROWS - 1)  check(hWallIndex(row,     col))
    if (col > 0)              check(vWallIndex(row,     col - 1))
    if (col < GRID_COLS - 1)  check(vWallIndex(row,     col))
    return out
  }

  // After a player or VIP moves, check every door adjacent to their new tile.
  // Doors that have no claim get claimed by this actor (and flip to BLOCKED if
  // currently SOLID). Doors already claimed by this actor have their leave
  // timer reset to 0. Doors claimed by SOMEONE ELSE are untouched —
  // first-claimant wins, per the design rule.
  private autoClaimAdjacentDoors(sid: string, team: string, col: number, row: number) {
    if (team !== 'bodyguard' && team !== 'hater') return
    for (const idx of this.adjacentDoorsTo(col, row)) {
      this.tryClaimDoor(idx, sid, team)
    }
  }

  private tryClaimDoor(idx: number, sid: string, team: string) {
    const state = this.state.wallStates[idx]
    if (state === STATE_OPEN || state === STATE_DESTROYED) return
    // A trapped door must stay unclaimed so enemies can approach and open it,
    // triggering the bomb. Skip re-claiming while the trap is active.
    if (this.trappedDoors.has(idx)) return
    // Still-locked VIP-room doors are always bodyguard-owned — skip the normal
    // claim-map logic: bodyguards open them via handleDoor, haters are refused.
    // Unlocked VIP-room doors (in unlockedVipRoomDoors) are treated as regular
    // doors so both teams can claim and open them normally.
    const isStillLockedVipDoor = (this.mazeConfig?.vipRoomDoors.includes(idx) ?? false)
                               && !this.unlockedVipRoomDoors.has(idx)
    if (isStillLockedVipDoor) {
      this.state.wallClaimTeams[idx] = 1
      return
    }

    const claim = this.doorClaim.get(idx)
    if (!claim) {
      this.doorClaim.set(idx, { sid, team, leftAt: 0 })
      if (state === STATE_SOLID) this.state.wallStates[idx] = STATE_BLOCKED
      this.state.wallClaimTeams[idx] = GameRoom.teamCode(team)
      this.state.wallClaimAck[idx]   = 0
    } else if (claim.sid === sid) {
      claim.leftAt = 0   // claimant returned to adjacency — reset timer
    }
  }

  private static teamCode(team: string): number {
    if (team === 'bodyguard') return 1
    if (team === 'hater')     return 2
    return 0
  }

  private clearDoorClaimSchema(idx: number) {
    if (idx < 0 || idx >= this.state.wallTypes.length) return
    this.state.wallClaimTeams[idx] = 0
    this.state.wallClaimAck[idx]   = 0
    // Still-locked VIP-room doors always show as bodyguard-owned while closed
    // so haters see red feedback when they click them. Unlocked VIP-room doors
    // (in unlockedVipRoomDoors) stay neutral (claimTeam=0) — they are now open
    // to both teams via the normal claim system.
    const isStillLockedVipDoor = (this.mazeConfig?.vipRoomDoors.includes(idx) ?? false)
                               && !this.unlockedVipRoomDoors.has(idx)
    if (isStillLockedVipDoor && this.state.wallStates[idx] !== STATE_OPEN) {
      this.state.wallClaimTeams[idx] = 1
    }
  }

  private isClaimantAdjacent(idx: number): boolean {
    const claim = this.doorClaim.get(idx)
    if (!claim) return false
    const sides = this.wallSidesTiles(idx)
    if (claim.sid === GameRoom.VIP_CLAIM_SID) {
      const vip = this.state.vip
      if (!vip.active) return false
      return (vip.tileCol === sides.a.col && vip.tileRow === sides.a.row)
          || (vip.tileCol === sides.b.col && vip.tileRow === sides.b.row)
    }
    const p = this.state.players.get(claim.sid)
    if (!p || p.zone !== 'game' || !p.isAlive || !p.connected) return false
    return (p.tileCol === sides.a.col && p.tileRow === sides.a.row)
        || (p.tileCol === sides.b.col && p.tileRow === sides.b.row)
  }

  // Tick processor: for each claimed door, start / clear / advance the leave
  // timer. After DOOR_CLAIM_EXPIRE_MS without the claimant being adjacent,
  // drop the claim and revert state from BLOCKED to SOLID.
  private processDoorClaims() {
    if (this.doorClaim.size === 0) return
    const now = Date.now()
    for (const [idx, claim] of [...this.doorClaim.entries()]) {
      if (this.isClaimantAdjacent(idx)) {
        claim.leftAt = 0
        continue
      }
      if (claim.leftAt === 0) {
        claim.leftAt = now
        continue
      }
      if (now - claim.leftAt >= this.DOOR_CLAIM_EXPIRE_MS) {
        this.doorClaim.delete(idx)
        if (this.state.wallStates[idx] === STATE_BLOCKED) {
          this.state.wallStates[idx] = STATE_SOLID
        }
        this.clearDoorClaimSchema(idx)
      }
    }
  }



  // Heuristic: a bodyguard is "between" VIP and hater if they stand on a tile
  // adjacent to BOTH. Cheap and good enough for the spec ("кожен на своїй
  // плитці").
  private hasBodyguardBetween(vip: VIPState, hater: PlayerState): boolean {
    for (const p of this.state.players.values()) {
      if (p.team !== 'bodyguard' || p.zone !== 'game' || !p.isAlive) continue
      const adjVip   = Math.abs(p.tileCol - vip.tileCol)   + Math.abs(p.tileRow - vip.tileRow)   === 1
      const adjHater = Math.abs(p.tileCol - hater.tileCol) + Math.abs(p.tileRow - hater.tileRow) === 1
      if (adjVip && adjHater) return true
    }
    return false
  }

  // Minimum Manhattan distance from (col,row) to any live in-game hater.
  // Returns Infinity when no haters are alive (flee constraints then inactive).
  private minDistFromHaters(col: number, row: number): number {
    let min = Infinity
    for (const p of this.state.players.values()) {
      if (p.team !== 'hater' || p.zone !== 'game' || !p.isAlive) continue
      const d = Math.abs(p.tileCol - col) + Math.abs(p.tileRow - row)
      if (d < min) min = d
    }
    return min
  }

  // Pick any cardinal step that increases distance from the threatening hater
  // and is walkable + unoccupied.
  private pickFleeTile(vip: VIPState, hater: PlayerState, wt: number[], ws: number[]): { col: number; row: number } | null {
    const dirs: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]]
    const fromDist = Math.abs(vip.tileCol - hater.tileCol) + Math.abs(vip.tileRow - hater.tileRow)
    const candidates: Array<{ col: number; row: number; dist: number }> = []
    for (const [dc, dr] of dirs) {
      const nc = vip.tileCol + dc, nr = vip.tileRow + dr
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue
      if (!canMoveBetween(vip.tileCol, vip.tileRow, nc, nr, wt, ws)) continue
      if (this.isTileOccupied(nc, nr)) continue
      if (this.safetyTileSet.has(nr * GRID_COLS + nc)) continue
      if (this.vipAvoidTile && nc === this.vipAvoidTile.col && nr === this.vipAvoidTile.row) continue
      const dist = Math.abs(nc - hater.tileCol) + Math.abs(nr - hater.tileRow)
      if (dist >= fromDist) candidates.push({ col: nc, row: nr, dist })
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.dist - a.dist)
    return candidates[0]
  }

  // ── Combat ───────────────────────────────────────────────────────────────

  // Phase 5: enqueue attack. Defending players can still attack but deal 25%
  // less damage (applied in resolveAttack when baseDmg is calculated).
  private handleAttack(attackerId: string, targetId: string) {
    if (this.state.phase !== 'playing') return
    const a = this.state.players.get(attackerId)
    if (!a || !a.isAlive || a.zone !== 'game') return

    const isVip = targetId === '__vip__'
    const t = isVip ? null : this.state.players.get(targetId)
    if (isVip) {
      if (a.team !== 'hater') return
      const vip = this.state.vip
      if (!vip.active) return
      if (!this.areAdjacent(a.tileCol, a.tileRow, vip.tileCol, vip.tileRow)) return
      if (!this.canAttackTarget(a.tileCol, a.tileRow, vip.tileCol, vip.tileRow)) return
    } else {
      if (!t || !t.isAlive || t.zone !== 'game' || !t.connected) return
      if (a.team === t.team || a.team === 'none' || t.team === 'none') return
      if (!this.areAdjacent(a.tileCol, a.tileRow, t.tileCol, t.tileRow)) return
      if (!this.canAttackTarget(a.tileCol, a.tileRow, t.tileCol, t.tileRow)) return
    }

    const now = Date.now()
    if ((this.attackCooldowns.get(attackerId) ?? 0) + cfg.ATTACK_COOLDOWN_MS > now) return
    this.attackCooldowns.set(attackerId, now)

    const src: 'hand' | 'baton' = a.rightHand === 'baton' ? 'baton' : 'hand'
    this.pendingAttacks.set(attackerId, {
      targetId,
      isVip,
      src,
      scheduledAt: now + cfg.ATTACK_RESOLVE_DELAY_MS,
    })
  }

  // Process all pending attacks whose resolve-time has passed. Reciprocal
  // pairs (A→B AND B→A) deal damage but skip knockback for both — this is the
  // "trade" rule: if you swung back during your opponent's wind-up, neither
  // of you gets pushed off the tile.
  //
  // The reciprocal check scans ALL pending attacks, not just the same-tick
  // due batch. Without this, a counter-swing fired ~200 ms after the first
  // swing would still be pending when the first lands and would NOT be
  // recognised as a reciprocal — the original target would eat full damage
  // + knockback, then their own counter would land later after they'd
  // already been pushed away. With the wider scan, the first attacker's
  // resolve resolves both attacks at once.
  private processPendingAttacks() {
    const now = Date.now()
    if (this.pendingAttacks.size === 0) return

    const due: Array<[string, PendingAttack]> = []
    for (const [aid, info] of this.pendingAttacks.entries()) {
      if (info.scheduledAt <= now) due.push([aid, info])
    }
    if (due.length === 0) return

    const handled = new Set<string>()

    for (const [aid, info] of due) {
      if (handled.has(aid)) continue
      // Reciprocal attack? Only possible for player↔player (VIP can't attack).
      // We pull the reciprocal from the FULL pending map, not the due batch,
      // so a counter still in its wind-up still counts as having traded
      // blows for the knockback rule.
      if (!info.isVip) {
        const reciprocal = this.pendingAttacks.get(info.targetId)
        if (reciprocal && !reciprocal.isVip && reciprocal.targetId === aid && !handled.has(info.targetId)) {
          this.resolveAttack(aid,            info,       /*skipKnockback*/ true)
          this.resolveAttack(info.targetId,  reciprocal, /*skipKnockback*/ true)
          handled.add(aid)
          handled.add(info.targetId)
          continue
        }
      }
      this.resolveAttack(aid, info, false)
      handled.add(aid)
    }

    for (const aid of handled) this.pendingAttacks.delete(aid)
  }

  private resolveAttack(attackerId: string, info: PendingAttack, skipKnockback: boolean) {
    const a = this.state.players.get(attackerId)
    if (!a || !a.isAlive || a.zone !== 'game') return

    let baseDmg = randInt(cfg.ATTACK_DAMAGE_MIN, cfg.ATTACK_DAMAGE_MAX) +
                  (info.src === 'baton' ? randInt(cfg.BATON_BONUS_MIN, cfg.BATON_BONUS_MAX) : 0)

    // Defending attacker deals 25% less damage with hand/baton.
    if (a.defending) baseDmg = Math.max(1, Math.floor(baseDmg * 0.75))

    if (info.isVip) {
      const vip = this.state.vip
      if (!vip.active) return
      // VIP is invulnerable during the post-safety win-delay window.
      if (vip.reachedSafe) return
      vip.health = Math.max(0, vip.health - baseDmg)
      vip.lastDamage = baseDmg; vip.lastDamageTime = Date.now()
      this.vipWasHitByHater = true   // triggers flee/bypass on next move tick

      // Dead-end detection: if VIP has only 1 passable exit she is cornered.
      // Record the tile toward the attacker — after knockback that tile is free
      // and VIP will step there next tick to escape before fleeing normally.
      const wt2 = this.state.wallTypes  as unknown as number[]
      const ws2 = this.state.wallStates as unknown as number[]
      let vipInDeadEnd = false
      {
        const dirs2: Array<[number,number]> = [[0,1],[0,-1],[1,0],[-1,0]]
        let exits2 = 0
        for (const [dc2, dr2] of dirs2) {
          const nc2 = vip.tileCol + dc2, nr2 = vip.tileRow + dr2
          if (this.tileInBounds(nc2, nr2) &&
              canMoveBetween(vip.tileCol, vip.tileRow, nc2, nr2, wt2, ws2)) exits2++
        }
        if (exits2 <= 1) {
          vipInDeadEnd = true
          const signDc = Math.sign(a.tileCol - vip.tileCol)
          const signDr = Math.sign(a.tileRow - vip.tileRow)
          const ec = { col: vip.tileCol + signDc, row: vip.tileRow + signDr }
          if (this.tileInBounds(ec.col, ec.row) &&
              canMoveBetween(vip.tileCol, vip.tileRow, ec.col, ec.row, wt2, ws2)) {
            this.vipDeadEndEscape = ec
            this.vipAvoidTile     = { col: vip.tileCol, row: vip.tileRow }
          }
        }
      }
      a.lastDealt = baseDmg; a.lastDealtTime = Date.now()
      this.broadcast('hit_sound', { col: vip.tileCol, row: vip.tileRow })

      if (!skipKnockback) {
        // VIP shoves attacker back.
        // In a dead-end: if the standard directional knockback fails (hater is
        // against a wall), force them to any free neighbour farthest from VIP.
        const beforeCol = a.tileCol, beforeRow = a.tileRow
        this.tryKnockback(a, vip.tileCol, vip.tileRow)
        const moved = a.tileCol !== beforeCol || a.tileRow !== beforeRow
        if (!moved && vipInDeadEnd) {
          this.forceKnockbackToFreeNeighbour(a, vip.tileCol, vip.tileRow, wt2, ws2)
        }
        if (a.tileCol !== beforeCol || a.tileRow !== beforeRow) {
          const wx = a.tileCol * 2 + 1, wz = a.tileRow * 2 + 1
          this.clients.find(c => c.sessionId === attackerId)?.send('teleport', { x: wx, y: 15.5, z: wz })
        }
      }

      if (vip.health <= 0 && !this.tryImmortalSaveVip()) this.endGame('haters', 'vip_killed')
      return
    }

    const t = this.state.players.get(info.targetId)
    if (!t || !t.isAlive || t.zone !== 'game' || !t.connected) return

    const result = this.applyDamageToPlayer(t, baseDmg, info.src)

    // Replicate "this attacker just dealt N damage" so spectators following
    // the attacker see the dealt-damage HUD line, mirroring lastDamage/Time.
    a.lastDealt = result.hpDmg; a.lastDealtTime = Date.now()

    this.clients.find(c => c.sessionId === info.targetId) ?.send('hit',       { damage: result.hpDmg, attackerId, shield: result.shieldDmg, blocked: result.fullyBlocked })
    this.clients.find(c => c.sessionId === attackerId)    ?.send('hit_dealt', { damage: result.hpDmg, targetId: info.targetId })
    this.broadcast('hit_sound', { col: t.tileCol, row: t.tileRow })

    if (t.health > 0 && !skipKnockback && !result.fullyBlocked) {
      const beforeCol = t.tileCol, beforeRow = t.tileRow
      this.tryKnockback(t, a.tileCol, a.tileRow)
      if (t.tileCol !== beforeCol || t.tileRow !== beforeRow) {
        const wx = t.tileCol * 2 + 1, wz = t.tileRow * 2 + 1
        this.clients.find(c => c.sessionId === info.targetId)?.send('teleport', { x: wx, y: 15.5, z: wz })
      }
    }

    if (t.health <= 0 && !this.tryImmortalSave(info.targetId, t)) {
      t.isAlive  = false
      t.killerId = attackerId
      this.handlePlayerDeath(info.targetId, t, attackerId)
      this.checkWinByElimination()
    }
  }

  // Phase 5 damage application — handles defending stance + shield interaction.
  // Returns the actual HP/shield damage and whether the hit was fully blocked.
  private applyDamageToPlayer(target: PlayerState, baseDmg: number, src: 'hand'|'baton'|'bomb'): { hpDmg: number; shieldDmg: number; fullyBlocked: boolean } {
    const hasShield = target.leftHand === 'shield' && target.shieldHP > 0

    // ── Defending + shield ────────────────────────────────────────────────
    // All incoming damage (hand, baton, bomb) is fully absorbed by the shield.
    // Player HP is untouched.
    if (target.defending && hasShield) {
      const shieldDmg = Math.min(target.shieldHP, baseDmg)
      this.deductShield(target, shieldDmg)
      return { hpDmg: 0, shieldDmg, fullyBlocked: true }
    }

    // ── Defending, no shield ──────────────────────────────────────────────
    // Bomb: 50% damage to HP.
    // Hand / baton: 75% damage to HP.
    if (target.defending) {
      const mult  = src === 'bomb' ? 0.5 : 0.75
      const hpDmg = Math.max(1, Math.floor(baseDmg * mult))
      target.health = Math.max(0, target.health - hpDmg)
      target.lastDamage = hpDmg; target.lastDamageTime = Date.now()
      return { hpDmg, shieldDmg: 0, fullyBlocked: false }
    }

    // ── Not defending + shield ────────────────────────────────────────────
    // Damage is split equally: half to HP, half to shield.
    if (hasShield) {
      const halfHp = Math.floor(baseDmg / 2)
      const halfSh = baseDmg - halfHp
      const shieldDmg = Math.min(target.shieldHP, halfSh)
      this.deductShield(target, shieldDmg)
      target.health = Math.max(0, target.health - halfHp)
      target.lastDamage = halfHp; target.lastDamageTime = Date.now()
      return { hpDmg: halfHp, shieldDmg, fullyBlocked: false }
    }

    // ── Not defending, no shield ──────────────────────────────────────────
    // Full damage to HP.
    target.health = Math.max(0, target.health - baseDmg)
    target.lastDamage = baseDmg; target.lastDamageTime = Date.now()
    return { hpDmg: baseDmg, shieldDmg: 0, fullyBlocked: false }
  }

  private deductShield(target: PlayerState, dmg: number): void {
    target.shieldHP = Math.max(0, target.shieldHP - dmg)
    if (target.shieldHP <= 0) {
      target.leftHand    = 'none'
      target.shieldMaxHP = 0
    }
  }

  // ── Phase 5: bombs (15s fuse, 1-tile radius) ─────────────────────────────

  // Drop the player's bomb on their own tile. If `wallIdx` points at an
  // adjacent door, the bomb is set up as a "door trap" — unarmed, no countdown
  // — and only detonates when that door is opened from the OTHER side. For
  // any other adjacent destructible (or no target at all), the standard
  // cfg.BOMB_FUSE_MS countdown starts immediately.
  private handlePlaceBomb(sessionId: string, wallIdx: number) {
    if (this.state.phase !== 'playing') return
    const p = this.state.players.get(sessionId)
    if (!p || p.zone !== 'game' || !p.isAlive) return
    if (p.leftHand !== 'bomb') return

    let trapWallIdx = -1
    if (wallIdx >= 0 && wallIdx < this.state.wallTypes.length) {
      const wt = this.state.wallTypes[wallIdx]
      const ws = this.state.wallStates[wallIdx]
      const isDoor = wt === WALL_WOOD_DOOR
      // Any door (regardless of BLOCKED/SOLID state) that is adjacent to the
      // player's tile becomes a door-trap, never a countdown bomb. The
      // BLOCKED exception was removed because autoClaimAdjacentDoors
      // sets the door to STATE_BLOCKED the moment the player walks up — so a
      // wood door was always BLOCKED by the time E was pressed, causing the
      // bomb to incorrectly start a countdown.
      if (isDoor && this.isPlayerAdjacentToWall(p, wallIdx)) {
        trapWallIdx = wallIdx
      }
    }

    // When placing as a door trap, check whether there is already a trap bomb
    // on the player's tile. If so, swap: remove the existing trap (its door
    // claim is cleared) and return a bomb to the player's hand after placing
    // the new one. Net result: player still holds a bomb (the old trap), and
    // the new trap is live on the tile.
    let swappedExistingTrap = false
    if (trapWallIdx >= 0) {
      for (const [ek, eb] of this.state.bombs.entries()) {
        if (!eb.armed && eb.tileCol === p.tileCol && eb.tileRow === p.tileRow) {
          this.state.bombs.delete(ek)
          if (eb.triggerWallIdx >= 0) {
            this.trappedDoors.delete(eb.triggerWallIdx)
            this.clearDoorClaimSchema(eb.triggerWallIdx)
          }
          swappedExistingTrap = true
          break
        }
      }
    }

    p.leftHand = 'none'

    const now  = Date.now()
    const key  = `${p.tileCol}_${p.tileRow}_${now}`
    const bomb = new BombState()
    bomb.tileCol        = p.tileCol
    bomb.tileRow        = p.tileRow
    bomb.ownerId        = sessionId
    bomb.triggerWallIdx = trapWallIdx
    bomb.armed          = trapWallIdx < 0
    bomb.fuseEndsAt     = trapWallIdx < 0 ? now + cfg.BOMB_FUSE_MS : 0
    this.state.bombs.set(key, bomb)

    // Swap: give player back a bomb (they now hold the removed trap).
    if (swappedExistingTrap) p.leftHand = 'bomb'

    // Door-trap: release any existing claim on the target door and exempt it
    // from autoClaimAdjacentDoors while the bomb is live. Without this the
    // placer (still adjacent) would immediately re-lock the door, keeping it
    // STATE_BLOCKED so enemies can never actually open it — the bomb fires but
    // the door stays closed and the blast never reaches the opener.
    if (trapWallIdx >= 0) {
      this.trappedDoors.add(trapWallIdx)
      this.doorClaim.delete(trapWallIdx)
      if (this.state.wallStates[trapWallIdx] === STATE_BLOCKED) {
        this.state.wallStates[trapWallIdx] = STATE_SOLID
      }
      this.clearDoorClaimSchema(trapWallIdx)
    }

    this.broadcast('bomb_placed', {
      key,
      col:           bomb.tileCol,
      row:           bomb.tileRow,
      fuseEndsAt:    bomb.fuseEndsAt,
      armed:         bomb.armed,
      triggerWallIdx: bomb.triggerWallIdx,
    })
  }

  // Pick a previously-placed door-trap bomb back into the player's left hand.
  // Only works when the player has an empty left hand AND stands on the bomb's
  // tile (which by definition is the same side of the door as the bomb).
  private handlePickupBomb(sessionId: string, key: string) {
    if (this.state.phase !== 'playing') return
    const p = this.state.players.get(sessionId)
    if (!p || p.zone !== 'game' || !p.isAlive) return
    const bomb = this.state.bombs.get(key)
    if (!bomb) return
    if (bomb.tileCol !== p.tileCol || bomb.tileRow !== p.tileRow) return
    // Armed (counting-down) bombs aren't pickupable — only unarmed door traps.
    if (bomb.armed) return

    if (p.leftHand === 'bomb') {
      // SWAP: player already holds a bomb — place it as a new UNARMED trap
      // targeting the same door (no countdown, no timer), and take the existing
      // trap into hand. trappedDoors entry is preserved (same door, new bomb).
      const swapKey = `${p.tileCol}_${p.tileRow}_${Date.now()}`
      const swapBomb = new BombState()
      swapBomb.tileCol        = p.tileCol
      swapBomb.tileRow        = p.tileRow
      swapBomb.ownerId        = sessionId
      swapBomb.triggerWallIdx = bomb.triggerWallIdx  // same door target
      swapBomb.armed          = false                 // unarmed — no timer starts
      swapBomb.fuseEndsAt     = 0
      this.state.bombs.set(swapKey, swapBomb)
      // Remove old trap. trappedDoors still contains this door (new bomb targets it).
      this.state.bombs.delete(key)
      // leftHand stays 'bomb' (now holds the former trap).
      return
    }

    if (p.leftHand !== 'none') return   // holding something other than a bomb

    // Normal pickup (left hand empty).
    this.state.bombs.delete(key)
    // Release the trapped-door exemption so the door can be claimed again.
    if (bomb.triggerWallIdx >= 0) {
      this.trappedDoors.delete(bomb.triggerWallIdx)
      this.clearDoorClaimSchema(bomb.triggerWallIdx)
    }
    p.leftHand = 'bomb'
  }

  private processBombs() {
    const now = Date.now()
    const exploded: string[] = []
    for (const [key, bomb] of this.state.bombs.entries()) {
      // Door-trap bombs (armed=false, fuseEndsAt=0) sit forever until the
      // door triggers them — the timer pass must skip them or they'd explode
      // on the very first tick.
      if (!bomb.armed) continue
      if (bomb.fuseEndsAt <= now) exploded.push(key)
    }
    for (const key of exploded) {
      const bomb = this.state.bombs.get(key)
      if (bomb) this.detonateBomb(key, bomb)
    }
  }

  // Called from handleDoor whenever a door successfully opens. Detonates any
  // door-trap bomb wired to that door whose placer is on the OPPOSITE side
  // from the opener (the spec rule: bomb arms when an enemy comes through).
  private triggerDoorBombsOnOpen(wallIdx: number, openerCol: number, openerRow: number) {
    if (this.state.bombs.size === 0) return
    const triggered: string[] = []
    for (const [key, bomb] of this.state.bombs.entries()) {
      if (bomb.armed) continue
      if (bomb.triggerWallIdx !== wallIdx) continue
      // Bomb side = bomb's tile. Opener must be on the OTHER tile flanking
      // this wall for the trap to fire. Using cardinal Manhattan distance
      // because the two flanking cells differ by exactly 1 in one axis.
      const sameSide = bomb.tileCol === openerCol && bomb.tileRow === openerRow
      if (sameSide) continue
      triggered.push(key)
    }
    for (const key of triggered) {
      const bomb = this.state.bombs.get(key)
      if (bomb) this.detonateBomb(key, bomb)
    }
  }

  // Called from damageWall when a wall/door is fully destroyed (HP → 0).
  // Detonates ALL unarmed trap bombs wired to that wall — the "same-side"
  // safety check used in triggerDoorBombsOnOpen does not apply here because
  // the wall no longer exists, so there is no protected side anymore.
  // wallTypes[idx] must already be WALL_NONE when this is called so that
  // bombBlastObstacle treats the former wall location as open space and the
  // blast wave reaches both flanking tiles unobstructed.
  private triggerTrappedBombsOnWallDestroy(wallIdx: number) {
    if (this.state.bombs.size === 0) return
    if (!this.trappedDoors.has(wallIdx)) return
    const triggered: string[] = []
    for (const [key, bomb] of this.state.bombs.entries()) {
      if (bomb.armed) continue
      if (bomb.triggerWallIdx !== wallIdx) continue
      triggered.push(key)
    }
    for (const key of triggered) {
      const bomb = this.state.bombs.get(key)
      if (bomb) this.detonateBomb(key, bomb)
    }
  }

  private detonateBomb(key: string, bomb: BombState) {
    this.state.bombs.delete(key)
    // Release the trapped-door exemption so the door can be claimed normally again.
    if (bomb.triggerWallIdx >= 0) this.trappedDoors.delete(bomb.triggerWallIdx)
    if (this.state.phase !== 'playing') return
    const bc = bomb.tileCol, br = bomb.tileRow
    const ownerId = bomb.ownerId
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]

    const rollFull = () => randInt(cfg.BOMB_DAMAGE_MIN, cfg.BOMB_DAMAGE_MAX)
    const halve   = (n: number) => Math.max(1, Math.ceil(n / 2))
    const now = Date.now()

    // Track which walls have been damaged by this explosion to avoid double-
    // damaging the same wall when multiple players shelter behind it.
    const damagedWallSet = new Set<number>()
    const damageWallOnce = (wi: number) => {
      if (wi < 0 || wi >= WALL_COUNT || damagedWallSet.has(wi)) return
      damagedWallSet.add(wi)
      this.damageWall(wi, 'bomb')
    }

    // ── 1. Always damage 4 cardinal walls directly adjacent to bomb tile ─────
    for (const wi of [
      hWallIndex(br - 1, bc), hWallIndex(br, bc),
      vWallIndex(br, bc - 1), vWallIndex(br, bc),
    ]) {
      if (wi >= 0 && wi < WALL_COUNT) damageWallOnce(wi)
    }

    // ── 2. Players in Chebyshev radius ≤ 2 (5×5 square around bomb) ─────────
    //
    // Blast rules:
    //   Chebyshev 0  — full damage, no knockback (on bomb tile)
    //   Chebyshev 1  — all 8 adjacent tiles (incl. diagonal):
    //                  if obstacle on path → wall takes damage, player is safe
    //                  else               → full random damage + knockback
    //   Chebyshev 2  — surrounding ring at 2 tiles (incl. diagonal):
    //                  if obstacle on path → wall takes damage, player is safe
    //                  else               → half random damage, no knockback
    //
    // "Obstacle on path" means the FIRST solid wall encountered when tracing
    // from the bomb tile toward the player tile. For diagonal directions both
    // L-shaped routes are checked — the blast reaches the player if EITHER
    // route is clear. If both are blocked, the first blocking wall takes damage.

    for (const [sid, p] of this.state.players.entries()) {
      if (!p.isAlive || p.zone !== 'game' || !p.connected) continue
      const dx = p.tileCol - bc, dy = p.tileRow - br
      const cheb = Math.max(Math.abs(dx), Math.abs(dy))
      if (cheb > 2) continue

      // On bomb tile: full damage, no knockback.
      if (cheb === 0) {
        const dmg = sid === ownerId ? cfg.BOMB_SELF_DAMAGE : rollFull()
        this.applyBombHitToPlayer(sid, p, dmg, ownerId, false, bc, br)
        continue
      }

      // Check for the first blocking wall on the blast path.
      const blockWi = this.bombBlastObstacle(bc, br, p.tileCol, p.tileRow, wt, ws)
      if (blockWi >= 0) {
        // Obstacle absorbs the blast: wall takes damage, player is unharmed
        // and NOT knocked back (the wall physically stops the pressure wave).
        damageWallOnce(blockWi)
        continue
      }

      // Clear path: apply damage and optional knockback.
      // Knockback only for direct (Chebyshev 1) hits; at Chebyshev 2 the
      // blast has lost enough force that it stings but does not push.
      const baseDmg = cheb === 1
        ? (sid === ownerId ? cfg.BOMB_SELF_DAMAGE : rollFull())
        : halve(sid === ownerId ? cfg.BOMB_SELF_DAMAGE : rollFull())
      this.applyBombHitToPlayer(sid, p, baseDmg, ownerId, cheb === 1, bc, br)
    }

    // ── 3. VIP in Chebyshev radius ≤ 2 ──────────────────────────────────────
    // VIP has no server-driven knockback (movement is pathfinder-based).
    const vip = this.state.vip
    if (vip.active) {
      const dx = vip.tileCol - bc, dy = vip.tileRow - br
      const cheb = Math.max(Math.abs(dx), Math.abs(dy))
      if (cheb === 0) {
        this.applyBombHitToVip(rollFull(), now)
      } else if (cheb <= 2) {
        const blockWi = this.bombBlastObstacle(bc, br, vip.tileCol, vip.tileRow, wt, ws)
        if (blockWi >= 0) {
          damageWallOnce(blockWi)
        } else {
          this.applyBombHitToVip(cheb === 1 ? rollFull() : halve(rollFull()), now)
        }
      }
    }

    this.broadcast('bomb_explode', { col: bc, row: br })
    this.checkWinByElimination()
  }

  // ── Blast-path obstacle detection ────────────────────────────────────────
  //
  // Returns the index of the first solid wall between bomb tile (bc,br) and
  // target tile (tc,tr), or -1 if there is at least one fully clear path.
  //
  // For diagonal directions two L-shaped routes are checked. If EITHER is
  // clear the player is reached (return -1). If both are blocked the index of
  // the first blocking wall on route A is returned.
  //
  // Chebyshev distance 2 variants are handled by tracing through intermediate
  // cells. Two alternative paths are always checked for non-cardinal directions
  // so the result is symmetric and never penalises one diagonal over another.
  private bombBlastObstacle(
    bc: number, br: number, tc: number, tr: number,
    wt: number[], ws: number[]
  ): number {
    const dx = tc - bc, dy = tr - br
    const adx = Math.abs(dx), ady = Math.abs(dy)
    const sdx = Math.sign(dx) as -1 | 0 | 1
    const sdy = Math.sign(dy) as -1 | 0 | 1

    // ── Chebyshev 1 cardinal ────────────────────────────────────────────────
    if (adx + ady === 1) {
      return this.solidWallBetween(bc, br, tc, tr, wt, ws)
    }

    // ── Chebyshev 1 diagonal ────────────────────────────────────────────────
    if (adx === 1 && ady === 1) {
      const pA = this.firstSolidOnPath([[bc, br], [bc + sdx, br],        [tc, tr]], wt, ws)
      const pB = this.firstSolidOnPath([[bc, br], [bc,        br + sdy], [tc, tr]], wt, ws)
      if (pA < 0 || pB < 0) return -1   // at least one route is clear
      return pA >= 0 ? pA : pB          // both blocked — return wall from route A
    }

    // ── Chebyshev 2 cardinal ────────────────────────────────────────────────
    if (adx === 2 && ady === 0) {
      const w = this.solidWallBetween(bc, br, bc + sdx, br, wt, ws)
      return w >= 0 ? w : this.solidWallBetween(bc + sdx, br, tc, tr, wt, ws)
    }
    if (adx === 0 && ady === 2) {
      const w = this.solidWallBetween(bc, br, bc, br + sdy, wt, ws)
      return w >= 0 ? w : this.solidWallBetween(bc, br + sdy, tc, tr, wt, ws)
    }

    // ── Chebyshev 2, L-shape (adx=2,ady=1) ──────────────────────────────────
    // tc = bc+2sdx, tr = br+sdy
    if (adx === 2 && ady === 1) {
      // Route A (X-primary): bomb → (bc+sdx,br) → (bc+2sdx,br) → (tc,tr)
      const pA = this.firstSolidOnPath(
        [[bc, br], [bc + sdx, br], [bc + 2 * sdx, br], [tc, tr]], wt, ws)
      // Route B (Y-primary): bomb → (bc,br+sdy) → (bc+sdx,br+sdy) → (tc,tr)
      const pB = this.firstSolidOnPath(
        [[bc, br], [bc, br + sdy], [bc + sdx, br + sdy], [tc, tr]], wt, ws)
      if (pA < 0 || pB < 0) return -1
      return pA >= 0 ? pA : pB
    }

    // ── Chebyshev 2, L-shape (adx=1,ady=2) ──────────────────────────────────
    // tc = bc+sdx, tr = br+2sdy
    if (adx === 1 && ady === 2) {
      // Route A (Y-primary): bomb → (bc,br+sdy) → (bc,br+2sdy) → (tc,tr)
      const pA = this.firstSolidOnPath(
        [[bc, br], [bc, br + sdy], [bc, br + 2 * sdy], [tc, tr]], wt, ws)
      // Route B (X-primary): bomb → (bc+sdx,br) → (bc+sdx,br+sdy) → (tc,tr)
      const pB = this.firstSolidOnPath(
        [[bc, br], [bc + sdx, br], [bc + sdx, br + sdy], [tc, tr]], wt, ws)
      if (pA < 0 || pB < 0) return -1
      return pA >= 0 ? pA : pB
    }

    // ── Chebyshev 2 diagonal (adx=2,ady=2) ──────────────────────────────────
    // tc = bc+2sdx, tr = br+2sdy
    if (adx === 2 && ady === 2) {
      // Route A: bomb → (bc+sdx,br) → (bc+sdx,br+sdy) → (bc+2sdx,br+sdy) → (tc,tr)
      const pA = this.firstSolidOnPath([
        [bc, br], [bc + sdx, br], [bc + sdx, br + sdy],
        [bc + 2 * sdx, br + sdy], [tc, tr],
      ], wt, ws)
      // Route B: bomb → (bc,br+sdy) → (bc+sdx,br+sdy) → (bc+sdx,br+2sdy) → (tc,tr)
      const pB = this.firstSolidOnPath([
        [bc, br], [bc, br + sdy], [bc + sdx, br + sdy],
        [bc + sdx, br + 2 * sdy], [tc, tr],
      ], wt, ws)
      if (pA < 0 || pB < 0) return -1
      return pA >= 0 ? pA : pB
    }

    return -1  // out-of-range or same tile — no obstacle
  }

  // Returns the wall index if the wall between two ADJACENT (Manhattan 1)
  // tiles is solid, or -1 if passable / out of bounds.
  private solidWallBetween(
    c1: number, r1: number, c2: number, r2: number,
    wt: number[], ws: number[]
  ): number {
    const wi = wallIdxBetween({ col: c1, row: r1 }, { col: c2, row: r2 })
    if (wi < 0 || wi >= WALL_COUNT) return -1
    return isPassable(wt[wi], ws[wi]) ? -1 : wi
  }

  // Walk an ordered sequence of adjacent tiles and return the index of the
  // first solid wall encountered, or -1 if the entire path is passable.
  private firstSolidOnPath(
    path: Array<[number, number]>,
    wt: number[], ws: number[]
  ): number {
    for (let i = 0; i + 1 < path.length; i++) {
      const [c1, r1] = path[i], [c2, r2] = path[i + 1]
      const w = this.solidWallBetween(c1, r1, c2, r2, wt, ws)
      if (w >= 0) return w
    }
    return -1
  }

  // Send a single bomb hit to a player. baseDmg <= 0 means "no damage,
  // knockback only". The owner of the bomb is exempt from knockback.
  private applyBombHitToPlayer(
    sid: string, p: PlayerState, baseDmg: number, ownerId: string,
    allowKnockback: boolean, bc: number, br: number
  ) {
    let killed = false
    if (baseDmg > 0) {
      const result = this.applyDamageToPlayer(p, baseDmg, 'bomb')
      // Credit the bomb owner with dealt damage (skip self-damage on the owner's own tile).
      if (sid !== ownerId) {
        const owner = this.state.players.get(ownerId)
        if (owner) { owner.lastDealt = result.hpDmg; owner.lastDealtTime = Date.now() }
      }
      this.clients.find(c => c.sessionId === sid)?.send('hit', {
        damage: result.hpDmg, attackerId: ownerId,
        shield: result.shieldDmg, blocked: result.fullyBlocked,
      })
      if (p.health <= 0) {
        if (this.tryImmortalSave(sid, p)) {
          // Immortal save teleported the player; skip the knockback below since
          // we're now somewhere unrelated to the bomb tile.
          killed = true
        } else {
          p.isAlive  = false
          p.killerId = ownerId
          this.handlePlayerDeath(sid, p, ownerId)
          killed = true
        }
      }
    }
    if (!killed && allowKnockback && sid !== ownerId) {
      const beforeCol = p.tileCol, beforeRow = p.tileRow
      this.tryKnockback(p, bc, br)
      if (p.tileCol !== beforeCol || p.tileRow !== beforeRow) {
        const wx = p.tileCol * 2 + 1, wz = p.tileRow * 2 + 1
        this.clients.find(c => c.sessionId === sid)?.send('teleport', { x: wx, y: 15.5, z: wz })
      }
    }
  }

  private applyBombHitToVip(dmg: number, now: number) {
    if (dmg <= 0) return
    const vip = this.state.vip
    // VIP is invulnerable during the post-safety win-delay window.
    if (vip.reachedSafe) return
    vip.health = Math.max(0, vip.health - dmg)
    vip.lastDamage = dmg
    vip.lastDamageTime = now
    // Бомба лякає VIP так само як удар рукою/дубинкою — активує flee/bypass
    // на наступному тіку NPC. До цього вибух пошкоджував HP але VIP не тікала.
    this.vipWasHitByHater = true
    if (vip.health <= 0 && !this.tryImmortalSaveVip()) this.endGame('haters', 'vip_killed')
  }

  private handlePlayerDeath(sessionId: string, p: PlayerState, killerId: string): void {
    this.dropPlayerInventory(p)
    p.zone = 'spectator'
    p.defending = false
    if (this.state.vip.followerId === sessionId) this.state.vip.followerId = ''
    const client = this.clients.find(c => c.sessionId === sessionId)
    if (!client) return
    client.send('you_died', { killerId })
    client.send('teleport', {
      x: 16,  y: 1.1, z: 27,
      cx: 16, cy: 1.5, cz: 26,
      spectating: true
    })
  }

  private checkWinByElimination() {
    // Solo guard: with a single in-game player there's no opposing team to
    // eliminate, so the "all of team X are dead" condition would always fire
    // (true for whichever team isn't represented) and instantly end the match.
    // Let the lone player escort VIP / lose by timeout / die instead.
    const inGame = [...this.state.players.values()].filter(p => p.zone === 'game' && p.connected)
    if (inGame.length <= 1) return

    const alive = inGame.filter(p => p.isAlive)
    const bg = alive.some(p => p.team === 'bodyguard'), h = alive.some(p => p.team === 'hater')
    if (!bg && h)  this.endGame('haters', 'elimination')
    if (!h  && bg) this.endGame('bodyguards', 'elimination')
  }

  // Diagonal tiles have no wall between them — always passable for attacks.
  // Cardinal tiles use canMoveBetween to check for blocking walls.
  private canAttackTarget(ac: number, ar: number, tc: number, tr: number): boolean {
    const isDiagonal = Math.abs(ac - tc) === 1 && Math.abs(ar - tr) === 1
    if (isDiagonal) return true
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]
    return canMoveBetween(ac, ar, tc, tr, wt, ws)
  }

  // Chebyshev <= 1: allows diagonal attacks in addition to cardinal.
  // max(dx,dy) <= 1 covers all 8 neighbours; exclude same-tile.
  private areAdjacent(c1: number, r1: number, c2: number, r2: number): boolean {
    return Math.max(Math.abs(c1 - c2), Math.abs(r1 - r2)) <= 1
      && (c1 !== c2 || r1 !== r2)
  }

  // ── Phase 2 — wall HP / destruction ──────────────────────────────────────

  private isPlayerAdjacentToWall(p: PlayerState, idx: number): boolean {
    const isH = idx < H_WALL_COUNT
    let aCol: number, aRow: number, bCol: number, bRow: number
    if (isH) {
      const r = (idx / GRID_COLS) | 0
      const c = idx % GRID_COLS
      aCol = c; aRow = r; bCol = c; bRow = r + 1
    } else {
      const r = ((idx - H_WALL_COUNT) / (GRID_COLS - 1)) | 0
      const c = (idx - H_WALL_COUNT) % (GRID_COLS - 1)
      aCol = c; aRow = r; bCol = c + 1; bRow = r
    }
    return (p.tileCol === aCol && p.tileRow === aRow)
        || (p.tileCol === bCol && p.tileRow === bRow)
  }

  private wallSidesTiles(idx: number): { a: { col: number; row: number }; b: { col: number; row: number } } {
    const isH = idx < H_WALL_COUNT
    if (isH) {
      const r = (idx / GRID_COLS) | 0
      const c = idx % GRID_COLS
      return { a: { col: c, row: r }, b: { col: c, row: r + 1 } }
    }
    const r = ((idx - H_WALL_COUNT) / (GRID_COLS - 1)) | 0
    const c = (idx - H_WALL_COUNT) % (GRID_COLS - 1)
    return { a: { col: c, row: r }, b: { col: c + 1, row: r } }
  }

  private handleWallAttack(sessionId: string, wallIdx: number) {
    if (this.state.phase !== 'playing') return
    if (wallIdx < 0 || wallIdx >= this.state.wallTypes.length) return
    const p = this.state.players.get(sessionId)
    if (!p || p.zone !== 'game' || !p.isAlive) return
    if (!this.isPlayerAdjacentToWall(p, wallIdx)) return
    // Unified attack cooldown — shares the timer with player + VIP attacks so
    // a single swing rate applies whether the target is a player, the VIP, or
    // a destructible wall.
    const now = Date.now()
    if ((this.attackCooldowns.get(sessionId) ?? 0) + cfg.ATTACK_COOLDOWN_MS > now) return
    this.attackCooldowns.set(sessionId, now)
    const src: 'hand' | 'baton' = p.rightHand === 'baton' ? 'baton' : 'hand'
    const ok = this.damageWall(wallIdx, src)
    if (!ok) {
      // Tell the player WHY the attack didn't land — without it, clicking a
      // hedge with bare hands looks like nothing happened.
      const type = this.state.wallTypes[wallIdx]
      const hp = this.state.wallHP[wallIdx], maxHp = this.state.wallMaxHP[wallIdx]
      const reason = this.attackBlockReason(type, hp, maxHp, src)
      if (reason) this.clients.find(c => c.sessionId === sessionId)?.send('attack_blocked', { reason })
    }
  }

  // Human-readable hint for why a wall attack was rejected. Plain ASCII —
  // DCL's text rendering doesn't show coloured emoji reliably.
  private attackBlockReason(type: number, hp: number, maxHp: number, src: 'hand' | 'baton' | 'bomb'): string {
    const frac = maxHp > 0 ? hp / maxHp : 0
    if (type === WALL_HEDGE) {
      if (frac >= 0.5)  return src === 'hand' || src === 'baton' ? 'Need a bomb to break this hedge'    : ''
      if (frac >= 0.25) return src === 'hand' ? 'Need baton or bomb' : ''
      return ''
    }
    if (type === WALL_WOOD_DOOR) {
      if (frac >= 0.5) return src === 'hand' ? 'Need baton or bomb to break this door' : ''
      return ''
    }
    return ''   // wood wall accepts everything; nothing else is destructible
  }

  // Damage a wall by `src`. Returns true if any damage actually applied
  // (gating rules below decide whether the source can hurt this wall yet).
  private damageWall(idx: number, src: 'hand' | 'baton' | 'bomb'): boolean {
    const type  = this.state.wallTypes[idx]
    const hp    = this.state.wallHP[idx]
    const maxHp = this.state.wallMaxHP[idx]
    if (maxHp <= 0) return false   // indestructible (concrete / NONE / still-locked VIP door)
    if (hp <= 0)    return false
    // VIP-room doors are wood doors but stay indestructible until the lock
    // timer releases them. While locked their maxHp is 0 (handled above);
    // this extra guard is a belt-and-braces check in case future code paths
    // grant HP without clearing them from the locked list.
    if (this.mazeConfig?.vipRoomDoors.includes(idx)
        && !this.unlockedVipRoomDoors.has(idx)) return false

    let allowed = false
    if (type === WALL_WOOD_WALL) {
      allowed = true   // any source, anytime
    } else if (type === WALL_WOOD_DOOR) {
      if (src === 'baton' || src === 'bomb') allowed = true
      else if (src === 'hand' && hp / maxHp < 0.5) allowed = true
    } else if (type === WALL_HEDGE) {
      if (src === 'bomb') allowed = true
      else if (src === 'baton' && hp / maxHp < 0.5) allowed = true
      else if (src === 'hand' && hp / maxHp < 0.25) allowed = true
    }
    if (!allowed) return false

    const dmg = src === 'hand'
      ? randInt(cfg.WALL_DMG_HAND_MIN,  cfg.WALL_DMG_HAND_MAX)
      : src === 'baton'
        ? randInt(cfg.WALL_DMG_BATON_MIN, cfg.WALL_DMG_BATON_MAX)
        : randInt(cfg.WALL_DMG_BOMB_MIN,  cfg.WALL_DMG_BOMB_MAX)
    const newHp = Math.max(0, hp - dmg)
    this.state.wallHP[idx] = newHp
    if (newHp === 0) {
      this.state.wallTypes[idx]  = WALL_NONE
      this.state.wallStates[idx] = STATE_SOLID
      this.state.wallMaxHP[idx]  = 0
      // Wall is fully destroyed — detonate any trap bomb wired to it.
      // wallTypes[idx] is already WALL_NONE so bombBlastObstacle will treat
      // the former wall location as passable and the blast reaches both sides.
      this.triggerTrappedBombsOnWallDestroy(idx)
    }
    return true
  }

  // ── Phase 3 — movable doors with push/block ──────────────────────────────

  private handleDoor(sessionId: string, wallIdx: number) {
    if (wallIdx < 0 || wallIdx >= this.state.wallTypes.length) return
    const type = this.state.wallTypes[wallIdx]
    if (type !== WALL_WOOD_DOOR) return
    const p = this.state.players.get(sessionId)
    if (!p || p.zone !== 'game' || !p.isAlive) return

    // Only adjacent players can interact (must stand on one of the door's two cells).
    if (!this.isPlayerAdjacentToWall(p, wallIdx)) return

    // A VIP-room door is "locked" only while it hasn't yet been unlocked by the
    // periodic timer (i.e. NOT in unlockedVipRoomDoors). Once the timer fires
    // it goes BLOCKED→SOLID with claimTeam=0, becomes neutral for everyone, and
    // isVipDoor flips to false so the normal open/close path takes over.
    const isVipDoor = (this.mazeConfig?.vipRoomDoors.includes(wallIdx) ?? false)
                   && !this.unlockedVipRoomDoors.has(wallIdx)
    // Haters may not interact with still-locked VIP-room doors. Record their
    // ack bit so the client paints the door red until the timer unlocks it.
    if (isVipDoor && p.team !== 'bodyguard') {
      const bit = GameRoom.teamCode(p.team)
      if (bit !== 0) {
        this.state.wallClaimTeams[wallIdx] = 1   // ensure bodyguard ownership
        this.state.wallClaimAck[wallIdx]   = (this.state.wallClaimAck[wallIdx] | bit) & 0xff
      }
      return
    }

    // Door-claim system: opposite-team players are refused all interaction
    // while a claimant from the other side holds the door. Their attempt is
    // recorded in `wallClaimAck` so the client can light the door red for
    // their team until the claim expires.
    //
    // IMPORTANT: even though the door physically stays shut, an attempt from
    // the OPPOSITE side still triggers any bomb trap wired to this door.
    // The `sameSide` check inside triggerDoorBombsOnOpen compares the opener's
    // tile against the bomb's tile — if they differ, the bomb detonates.
    // Players on the SAME side as the bomb (claim holders) are not affected.
    const claim = this.doorClaim.get(wallIdx)
    if (claim && claim.team !== p.team && claim.team !== 'none' && p.team !== 'none') {
      const bit = GameRoom.teamCode(p.team)
      if (bit !== 0) {
        this.state.wallClaimAck[wallIdx] = (this.state.wallClaimAck[wallIdx] | bit) & 0xff
      }
      // If there is a trap bomb on this door, open it before detonating so the
      // blast wave is not blocked by a closed door. Without this the explosion
      // happens on the placer's tile while the door stays BLOCKED — the opener
      // is on the other side of a solid wall and takes no damage.
      const hasTrap = this.trappedDoors.has(wallIdx)
      if (hasTrap) {
        this.state.wallStates[wallIdx] = STATE_OPEN
        this.doorOpener.set(wallIdx, sessionId)
        this.doorClaim.delete(wallIdx)
        this.clearDoorClaimSchema(wallIdx)
      }
      // Trigger any bomb trap wired to this door.
      this.triggerDoorBombsOnOpen(wallIdx, p.tileCol, p.tileRow)
      return
    }

    const cur = this.state.wallStates[wallIdx]
    if (cur === STATE_OPEN) {
      // Closing — same-team / no-claim players can do this freely.
      this.state.wallStates[wallIdx] = STATE_SOLID
      this.doorOpener.delete(wallIdx)
      // VIP-room doors regain bodyguard ownership after closing so haters
      // continue to see red feedback when they click them.
      if (isVipDoor) {
        this.state.wallClaimTeams[wallIdx] = 1
        this.state.wallClaimAck[wallIdx]   = 0
      }
      return
    }

    // Open the door. Players on the other side are NOT pushed — only bomb
    // explosions may knock players back (design rule).
    this.state.wallStates[wallIdx] = STATE_OPEN
    this.doorOpener.set(wallIdx, sessionId)
    // Opening clears any prior claim — door is now openly passable.
    this.doorClaim.delete(wallIdx)
    this.clearDoorClaimSchema(wallIdx)
    // Trigger any bomb trap: same-side openers are safe, opposite-side triggers.
    this.triggerDoorBombsOnOpen(wallIdx, p.tileCol, p.tileRow)
  }

  // Auto-close any door whose opener has wandered DOOR_AUTO_CLOSE_TILES away
  // from the wall. Cheap — only iterates the small `doorOpener` map.
  private autoCloseDoors() {
    if (this.doorOpener.size === 0) return
    for (const [wallIdx, openerSid] of [...this.doorOpener.entries()]) {
      // Door already closed (e.g. someone re-toggled it) → drop the entry.
      if (this.state.wallStates[wallIdx] !== STATE_OPEN) {
        this.doorOpener.delete(wallIdx)
        continue
      }
      const opener = this.state.players.get(openerSid)
      // Opener gone (disconnect / death / left game) → close immediately.
      if (!opener || opener.zone !== 'game' || !opener.isAlive) {
        this.state.wallStates[wallIdx] = STATE_SOLID
        this.doorOpener.delete(wallIdx)
        continue
      }
      // Distance from opener to NEAREST cell adjacent to the door.
      const sides = this.wallSidesTiles(wallIdx)
      const dA = Math.abs(opener.tileCol - sides.a.col) + Math.abs(opener.tileRow - sides.a.row)
      const dB = Math.abs(opener.tileCol - sides.b.col) + Math.abs(opener.tileRow - sides.b.row)
      if (Math.min(dA, dB) > this.DOOR_AUTO_CLOSE_TILES) {
        this.state.wallStates[wallIdx] = STATE_SOLID
        this.doorOpener.delete(wallIdx)
        // Still-locked VIP-room doors regain bodyguard ownership after auto-close
        // so haters continue to see red feedback when they click them.
        // Unlocked VIP-room doors (in unlockedVipRoomDoors) stay neutral (claimTeam=0)
        // so both teams can continue to open/close them freely.
        const stillLocked = (this.mazeConfig?.vipRoomDoors.includes(wallIdx) ?? false)
                         && !this.unlockedVipRoomDoors.has(wallIdx)
        if (stillLocked) {
          this.state.wallClaimTeams[wallIdx] = 1
          this.state.wallClaimAck[wallIdx]   = 0
        }
      }
    }
  }

  // ── Phase 4 — items: two-handed pickup, drop on death ────────────────────

  private spawnItem() {
    if (this.state.items.size >= cfg.ITEM_MAX) return
    if (!this.mazeConfig) return
    const pool  = this.mazeConfig.spawnPool
    if (pool.length === 0) return

    // Pick a type via weighted RNG (bombs spawn ~3× as often as baton/shield).
    // If the rolled type is "baton" and we're already at cfg.BATON_MAX_TOTAL, drop
    // baton from the pool and re-roll once — we want to KEEP spawning items,
    // just not more batons.
    const roll = (weights: Record<string, number>): string => {
      let total = 0
      for (const k in weights) total += weights[k]
      let r = Math.random() * total
      for (const k in weights) { r -= weights[k]; if (r <= 0) return k }
      return Object.keys(weights)[0]
    }
    const batonCount  = this.countBatonsInPlay()
    const shieldCount = this.countShieldsInPlay()
    const weights: Record<string, number> = { ...cfg.ITEM_SPAWN_WEIGHTS }
    if (batonCount  >= cfg.BATON_MAX_TOTAL)  delete weights.baton
    if (shieldCount >= cfg.SHIELD_MAX_TOTAL) delete weights.shield
    // If everything is capped (extremely rare), fall back to a bomb.
    if (Object.keys(weights).length === 0) weights.bomb = 1
    const type = roll(weights)

    for (let attempt = 0; attempt < 20; attempt++) {
      const t = pool[(Math.random() * pool.length) | 0]
      const key = `${t.col}_${t.row}`
      if (!this.state.items.has(key) && !this.isTileOccupied(t.col, t.row)) {
        const item = new ItemState()
        item.tileCol = t.col; item.tileRow = t.row; item.type = type; item.active = true
        this.state.items.set(key, item)
        return
      }
    }
  }

  // Total batons currently in the match — counts both world-tile drops AND
  // batons equipped in players' right hands. Used by spawnItem to enforce
  // cfg.BATON_MAX_TOTAL across the whole game, not just floor items.
  private countBatonsInPlay(): number {
    let n = 0
    for (const it of this.state.items.values()) {
      if (it.active && it.type === 'baton') n++
    }
    for (const p of this.state.players.values()) {
      if (p.rightHand === 'baton') n++
    }
    return n
  }

  // Same for shields. Counts only ACTIVE shields (the broken-shield path
  // already clears leftHand to 'none' in deductShield, so a destroyed
  // shield naturally frees its slot for a new spawn).
  private countShieldsInPlay(): number {
    let n = 0
    for (const it of this.state.items.values()) {
      if (it.active && it.type === 'shield') n++
    }
    for (const p of this.state.players.values()) {
      if (p.leftHand === 'shield') n++
    }
    return n
  }

  private handlePickup(sessionId: string, key: string) {
    const item = this.state.items.get(key)
    const p = this.state.players.get(sessionId)
    if (!item || !item.active || !p || p.zone !== 'game' || !p.isAlive) return
    if (p.tileCol !== item.tileCol || p.tileRow !== item.tileRow) return

    if (item.type === 'baton') {
      // Drop currently held baton (if any) on this tile, then take this baton.
      // Tile is currently free of items (we're picking it up), so drop here.
      if (p.rightHand === 'baton') {
        const dropKey = `${p.tileCol}_${p.tileRow}_drop_${Date.now()}`
        const drop = new ItemState()
        drop.tileCol = p.tileCol; drop.tileRow = p.tileRow; drop.type = 'baton'; drop.active = true
        this.state.items.set(dropKey, drop)
      }
      p.rightHand = 'baton'
    } else if (item.type === 'shield') {
      this.dropLeftHandIfNeeded(p)
      p.leftHand    = 'shield'
      // Each shield rolls its own HP between 50% and 150% of player full
      // HP — variance so two players carrying "the same" shield don't
      // necessarily survive the same fights.
      const rolledMaxHp = randInt(cfg.SHIELD_MAX_HP_MIN, cfg.SHIELD_MAX_HP_MAX)
      p.shieldHP    = rolledMaxHp
      p.shieldMaxHP = rolledMaxHp
    } else if (item.type === 'bomb') {
      this.dropLeftHandIfNeeded(p)
      p.leftHand = 'bomb'
    }
    this.state.items.delete(key)

    // In cfg.EMPTY_ARENA_MODE, demo item tiles are never left empty — re-spawn
    // the same type immediately so the next tester always finds the slot full.
    // The key reuses "{col}_{row}" format so spawnItem() continues to respect
    // the tile as occupied. If a player drops something on this tile before
    // picking up the demo item, both items will briefly coexist — acceptable
    // in a test environment.
    if (cfg.EMPTY_ARENA_MODE) {
      const demoType = this.demoTiles.get(`${item.tileCol}_${item.tileRow}`)
      if (demoType) {
        const respawn = new ItemState()
        respawn.tileCol = item.tileCol; respawn.tileRow = item.tileRow
        respawn.type = demoType; respawn.active = true
        this.state.items.set(`${item.tileCol}_${item.tileRow}`, respawn)
      }
    }
  }

  // If left hand currently holds something, drop it on the player's current
  // tile (or an adjacent free tile if the current is taken).
  private dropLeftHandIfNeeded(p: PlayerState) {
    if (p.leftHand === 'none') return
    const droppedType = p.leftHand
    const dropTile = this.findItemDropTileExcluding(p.tileCol, p.tileRow, new Set())
    if (dropTile) {
      const k = `${dropTile.col}_${dropTile.row}_drop_${Date.now()}`
      const drop = new ItemState()
      drop.tileCol = dropTile.col; drop.tileRow = dropTile.row; drop.type = droppedType; drop.active = true
      this.state.items.set(k, drop)
    }
    if (p.leftHand === 'shield') { p.shieldHP = 0; p.shieldMaxHP = 0 }
    p.leftHand = 'none'
  }

  // Drop everything on death. Same one-per-tile rule — second item goes adjacent.
  private dropPlayerInventory(p: PlayerState) {
    const drops: string[] = []
    if (p.rightHand !== 'none') drops.push(p.rightHand)
    if (p.leftHand  !== 'none') drops.push(p.leftHand)

    // usedTiles tracks tiles already claimed by earlier drops in this death so
    // two items never land on the same tile even when adjacent options are few.
    const usedTiles = new Set<string>()
    for (let i = 0; i < drops.length; i++) {
      const tile = this.findItemDropTileExcluding(p.tileCol, p.tileRow, usedTiles)
      if (!tile) break   // every reachable tile is occupied — skip remaining items
      usedTiles.add(`${tile.col}_${tile.row}`)
      const k = `${tile.col}_${tile.row}_death_${Date.now()}_${i}`
      const drop = new ItemState()
      drop.tileCol = tile.col; drop.tileRow = tile.row; drop.type = drops[i]; drop.active = true
      this.state.items.set(k, drop)
    }
    p.rightHand = 'none'; p.leftHand = 'none'
    p.shieldHP  = 0;       p.shieldMaxHP = 0
  }

  // Find the nearest tile (origin first, then cardinal neighbours) that:
  //   • is in-bounds
  //   • has no existing item
  //   • is not already claimed by an earlier drop in this call (excluded set)
  //   • is reachable from origin without crossing a solid wall / closed door
  private findItemDropTileExcluding(
    col: number, row: number,
    excluded: Set<string>
  ): { col: number; row: number } | null {
    const key = `${col}_${row}`
    if (!this.tileHasItem(col, row) && !excluded.has(key)) return { col, row }
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]
    const dirs: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]]
    for (const [dc, dr] of dirs) {
      const nc = col + dc, nr = row + dr
      const nk = `${nc}_${nr}`
      if (!this.tileInBounds(nc, nr)) continue
      if (!canMoveBetween(col, row, nc, nr, wt, ws)) continue
      if (this.tileHasItem(nc, nr)) continue
      if (excluded.has(nk)) continue
      return { col: nc, row: nr }
    }
    return null
  }

  private tileHasItem(col: number, row: number): boolean {
    for (const it of this.state.items.values()) {
      if (it.active && it.tileCol === col && it.tileRow === row) return true
    }
    return false
  }

  // ── Tile occupancy ───────────────────────────────────────────────────────

  private isTileOccupied(col: number, row: number): boolean {
    for (const p of this.state.players.values())
      if (p.zone === 'game' && p.connected && p.tileCol === col && p.tileRow === row) return true
    const v = this.state.vip
    return v.active && v.tileCol === col && v.tileRow === row
  }

  // `sameTeamAs` — when provided, players of the same team don't count as
  // blockers. Allies can stand on the same tile without pushing each other.
  private isTileOccupiedByOther(
    col: number,
    row: number,
    ignoreSessionId: string,
    allowVip = false,
    sameTeamAs: string = '',
  ): boolean {
    for (const [sid, p] of this.state.players.entries()) {
      if (sid === ignoreSessionId) continue
      if (!p.connected) continue
      if (p.zone !== 'game') continue
      if (p.tileCol !== col || p.tileRow !== row) continue
      // Allies don't block. 'none' isn't a team — guard against it explicitly.
      if (sameTeamAs && sameTeamAs !== 'none' && p.team === sameTeamAs) continue
      return true
    }
    if (allowVip) return false
    const v = this.state.vip
    return v.active && v.tileCol === col && v.tileRow === row
  }

  // ── Knockback ────────────────────────────────────────────────────────────

  private tryKnockback(target: PlayerState, attackerCol: number, attackerRow: number): void {
    if (!target.isAlive || target.zone !== 'game') return
    // ALLOW_ALL_TILE_OVERLAP: skip all knockback. If shared tiles are allowed
    // then shoving someone off the contested tile defeats the point of the
    // setting — attacks should still damage but not relocate the victim.
    if (cfg.ALLOW_ALL_TILE_OVERLAP) return
    const vip = this.state.vip
    if (target.team === 'bodyguard'
        && vip.active
        && target.tileCol === vip.tileCol
        && target.tileRow === vip.tileRow) {
      return
    }
    const dc = Math.sign(target.tileCol - attackerCol)
    const dr = Math.sign(target.tileRow - attackerRow)
    if (dc === 0 && dr === 0) return

    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]

    const sCol = target.tileCol + dc
    const sRow = target.tileRow + dr
    if (this.canKnockbackTo(target.tileCol, target.tileRow, sCol, sRow, wt, ws)) {
      target.tileCol = sCol; target.tileRow = sRow
      return
    }

    const leftCol  = target.tileCol + dc + (-dr)
    const leftRow  = target.tileRow + dr + ( dc)
    const rightCol = target.tileCol + dc + ( dr)
    const rightRow = target.tileRow + dr + (-dc)

    const roll = Math.random()
    if (roll < this.KNOCKBACK_DIAG_PROB_EACH) {
      this.applyDiagonalKnockback(target, leftCol, leftRow, dc, dr, -dr, dc, wt, ws)
    } else if (roll < this.KNOCKBACK_DIAG_PROB_EACH * 2) {
      this.applyDiagonalKnockback(target, rightCol, rightRow, dc, dr, dr, -dc, wt, ws)
    }
  }

  private applyDiagonalKnockback(
    target: PlayerState,
    cornerCol: number, cornerRow: number,
    dc: number, dr: number, perpDc: number, perpDr: number,
    wt: number[], ws: number[]
  ): void {
    if (!this.tileInBounds(cornerCol, cornerRow)) return
    if (this.isTileOccupied(cornerCol, cornerRow)) return

    const fromCol = target.tileCol, fromRow = target.tileRow
    const midA_col = fromCol + dc, midA_row = fromRow + dr
    const pathA = this.tileInBounds(midA_col, midA_row)
      && !this.isTileOccupied(midA_col, midA_row)
      && canMoveBetween(fromCol, fromRow, midA_col, midA_row, wt, ws)
      && canMoveBetween(midA_col, midA_row, cornerCol, cornerRow, wt, ws)

    const midB_col = fromCol + perpDc, midB_row = fromRow + perpDr
    const pathB = this.tileInBounds(midB_col, midB_row)
      && !this.isTileOccupied(midB_col, midB_row)
      && canMoveBetween(fromCol, fromRow, midB_col, midB_row, wt, ws)
      && canMoveBetween(midB_col, midB_row, cornerCol, cornerRow, wt, ws)

    if (pathA || pathB) {
      target.tileCol = cornerCol; target.tileRow = cornerRow
    }
  }

  /**
   * Guaranteed knockback for dead-end situations.
   * Collects all free cardinal neighbours of `target`, then picks the one
   * with the greatest Manhattan distance from (awayFromCol, awayFromRow)
   * (i.e. farthest from the cornered VIP).  If multiple tiles tie on
   * distance, one is chosen at random.
   * Returns true and updates target.tileCol/Row on success; false if
   * no free neighbour exists (target is completely surrounded).
   */
  private forceKnockbackToFreeNeighbour(
    target: PlayerState,
    awayFromCol: number, awayFromRow: number,
    wt: number[], ws: number[]
  ): boolean {
    // Same as tryKnockback: skip all relocation when shared tiles are allowed.
    // VIP idle-push and corner-attack knockback both flow through here.
    if (cfg.ALLOW_ALL_TILE_OVERLAP) return false
    const dirs: Array<[number,number]> = [[0,1],[0,-1],[1,0],[-1,0]]
    const free: {col:number; row:number; dist:number}[] = []
    for (const [dc, dr] of dirs) {
      const nc = target.tileCol + dc, nr = target.tileRow + dr
      if (!this.tileInBounds(nc, nr)) continue
      if (!canMoveBetween(target.tileCol, target.tileRow, nc, nr, wt, ws)) continue
      if (this.isTileOccupied(nc, nr)) continue
      const dist = Math.abs(nc - awayFromCol) + Math.abs(nr - awayFromRow)
      free.push({ col: nc, row: nr, dist })
    }
    if (free.length === 0) return false
    // Prefer tiles farthest from the cornered VIP so hater clears the exit.
    const maxDist = Math.max(...free.map(t => t.dist))
    const best = free.filter(t => t.dist === maxDist)
    const picked = best[Math.floor(Math.random() * best.length)]
    target.tileCol = picked.col
    target.tileRow = picked.row
    return true
  }

  private canKnockbackTo(fromCol: number, fromRow: number, toCol: number, toRow: number, wt: number[], ws: number[]): boolean {
    if (!this.tileInBounds(toCol, toRow)) return false
    if (this.isTileOccupied(toCol, toRow)) return false
    return canMoveBetween(fromCol, fromRow, toCol, toRow, wt, ws)
  }

  private tileInBounds(col: number, row: number): boolean {
    return col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS
  }

  private evictFromTile(col: number, row: number, exceptSessionId: string, includeVip: boolean): void {
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]

    const dirs: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]]

    const findFreeNeighbour = (
      fromCol: number, fromRow: number,
      ignoreSid: string
    ): { col: number; row: number } | null => {
      for (const [dc, dr] of dirs) {
        const nc = fromCol + dc, nr = fromRow + dr
        if (!this.tileInBounds(nc, nr)) continue
        if (!canMoveBetween(fromCol, fromRow, nc, nr, wt, ws)) continue
        if (this.isTileOccupiedByOther(nc, nr, ignoreSid, false)) continue
        return { col: nc, row: nr }
      }
      return null
    }

    for (const [sid, other] of this.state.players.entries()) {
      if (sid === exceptSessionId) continue
      if (other.zone !== 'game') continue
      if (other.tileCol !== col || other.tileRow !== row) continue
      const dest = findFreeNeighbour(col, row, sid)
      if (!dest) continue
      other.tileCol = dest.col
      other.tileRow = dest.row
      const wx = dest.col * 2 + 1, wz = dest.row * 2 + 1
      this.clients.find(c => c.sessionId === sid)?.send('teleport', { x: wx, y: 15.5, z: wz })
      console.log(`[GameRoom] Evicted ${sid} from (${col},${row}) → (${dest.col},${dest.row})`)
    }

    if (includeVip) {
      const vip = this.state.vip
      if (vip.active && vip.tileCol === col && vip.tileRow === row) {
        const dest = findFreeNeighbour(col, row, '__vip__')
        if (dest) {
          vip.tileCol = dest.col
          vip.tileRow = dest.row
          vip.lastMoveAt = Date.now()
          console.log(`[GameRoom] Evicted VIP from (${col},${row}) → (${dest.col},${dest.row})`)
        }
      }
    }
  }

  private handleGhostsForUserId(
    userId: string, ourSessionId: string
  ): {
    restored: { tileCol: number; tileRow: number; team: string; zone: string;
                health: number; maxHealth: number;
                rightHand: string; leftHand: string; shieldHP: number; shieldMaxHP: number;
                isAlive: boolean } | null
    wasReconnect: boolean
  } {
    let restored: {
      tileCol: number; tileRow: number; team: string; zone: string;
      health: number; maxHealth: number;
      rightHand: string; leftHand: string; shieldHP: number; shieldMaxHP: number;
      isAlive: boolean
    } | null = null
    let wasReconnect = false

    for (const [otherSid, other] of this.state.players.entries()) {
      if (otherSid === ourSessionId) continue
      if (other.userId !== userId) continue

      // Restore from any in-game or spectating placeholder (zone may be
      // 'spectator' if processDisconnectGrace already killed the player via
      // timeout — we must still pick up that state, not fall through to the
      // backup which was saved at disconnect time and has isAlive=true).
      if (this.state.phase === 'playing' && other.team !== 'none' &&
          (other.zone === 'game' || other.zone === 'spectator')) {
        restored = {
          tileCol:     other.tileCol,
          tileRow:     other.tileRow,
          team:        other.team,
          zone:        other.zone,
          health:      other.health,
          maxHealth:   other.maxHealth,
          rightHand:   other.rightHand,
          leftHand:    other.leftHand,
          shieldHP:    other.shieldHP,
          shieldMaxHP: other.shieldMaxHP,
          isAlive:     other.isAlive
        }
      }

      const ghost = this.clients.find(c => c.sessionId === otherSid)
      if (ghost && other.connected) {
        console.log(`[GameRoom] Kicking live ghost ${otherSid} for userId ${userId}`)
        try { ghost.leave(4000) } catch (_) {}
        // Mark wasReconnect so onJoin calls evictFromTile — the ghost is still
        // briefly on the restored tile until its onLeave fires (Fix in onLeave
        // ensures that onLeave removes the placeholder immediately rather than
        // leaving a grace-period stub behind).
        if (restored) wasReconnect = true
      } else {
        wasReconnect = true
        if (other.inQueue) this.state.queueCount--
        this.state.players.delete(otherSid)
        this.state.playerCount--
        console.log(`[GameRoom] Resumed session for ${userId}: removed placeholder ${otherSid}`)
      }
    }

    if (!restored) {
      const snap = this.playerBackup.get(userId)
      if (snap && Date.now() - snap.savedAt <= this.BACKUP_TTL_MS && this.state.phase === 'playing') {
        restored = {
          tileCol: snap.tileCol, tileRow: snap.tileRow,
          team:    snap.team,    zone:    snap.zone,
          health:  snap.health,  maxHealth: snap.maxHealth,
          rightHand: snap.rightHand, leftHand: snap.leftHand,
          shieldHP:  snap.shieldHP,  shieldMaxHP: snap.shieldMaxHP,
          isAlive: snap.isAlive
        }
        wasReconnect = true
      }
      if (snap) this.playerBackup.delete(userId)
    }

    return { restored, wasReconnect }
  }



  private processDisconnectGrace() {
    const now = Date.now()
    let purgedAlive = false
    for (const [sid, p] of [...this.state.players.entries()]) {
      if (p.connected) continue
      if (p.disconnectedAt === 0) continue
      const elapsed = now - p.disconnectedAt
      if (elapsed >= cfg.DISCONNECT_PURGE_MS) {
        if (p.inQueue) this.state.queueCount--
        this.state.players.delete(sid)
        this.state.playerCount--
        if (p.isAlive && p.zone === 'game') purgedAlive = true
        if (p.userId) this.playerBackup.delete(p.userId)
        console.log(`[GameRoom] Purged ${sid} after ${Math.round(elapsed / 1000)}s offline`)
      } else if (p.isAlive && elapsed >= cfg.DISCONNECT_DEATH_MS && p.zone === 'game') {
        p.isAlive   = false
        p.killerId  = ''
        p.zone      = 'spectator'   // mirrors handlePlayerDeath so handleGhostsForUserId
        // picks up zone='spectator' correctly and doesn't fall through to the
        // backup (which was saved at disconnect time with isAlive=true).
        p.defending = false
        this.dropPlayerInventory(p)
        // Belt-and-suspenders: also wipe the backup so a second reconnect
        // attempt (after the placeholder is purged) can't revive via stale data.
        if (p.userId) this.playerBackup.delete(p.userId)
        purgedAlive = true
        console.log(`[GameRoom] ${sid} marked dead after ${Math.round(elapsed / 1000)}s offline`)
      }
    }
    if (purgedAlive) this.checkWinByElimination()
  }
}
