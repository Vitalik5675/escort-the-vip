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
  WALL_NONE, WALL_CONCRETE, WALL_WOOD_DOOR, WALL_WOOD_WALL, WALL_HEDGE,
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
  // Set of dead-end tile keys (row*GRID_COLS+col) VIP visited while fleeing.
  // pickRandomWanderStep gives these an 80 % skip probability so VIP does not
  // repeatedly run back into the same short corridors and circle indefinitely.
  private _vipVisitedDeadEnds  = new Set<number>()
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
  private vipFleeSteps  = 0   // steps taken during the current flee phase
  // Precomputed escape route (full A* path to a random dead-end).
  // VIP follows it step-by-step instead of re-evaluating direction every tick.
  // This eliminates corridor oscillation: VIP commits to a destination and only
  // re-routes when the path is physically blocked or the destination is reached.
  private vipFleeRoute: Array<{ col: number; row: number }> = []
  private vipFleeRouteIdx = 0   // index of the next step to execute in vipFleeRoute
  // Two-phase flee: Phase 1 = escape ≥ VIP_FLEE_TILES steps; Phase 2 = hide behind a door.
  private vipFleePhase: 1 | 2 = 1

  // Phase 5 — pending-attack queue. Holds each attack for cfg.ATTACK_RESOLVE_DELAY_MS
  // before it actually deals damage. If the target enqueues a reciprocal attack
  // back at the original attacker within the window, both still take damage but
  // neither is knocked back (counter-attack rule).
  private pendingAttacks = new Map<string, PendingAttack>()

  // Phase 3 — track who opened each door (sessionId). Used to determine the
  // opener's team for auto-close logic. Cleared on close.
  private doorOpener = new Map<number, string>()

  // Auto-close timers: remaining milliseconds before each open door closes.
  // All doors open with DOOR_CLOSE_ALLY_MS (10 s). Two behaviours:
  //   • Escort door (BG ≤ 1 tile OR VIP ≤ 2 tiles): timer held at 10 s.
  //     2 s countdown once both BG ≥ 2 tiles AND VIP > 2 tiles away.
  //   • All other doors: flat 10 s countdown from the moment of opening.
  private doorAutoCloseMs    = new Map<number, number>()
  private readonly DOOR_CLOSE_ALLY_MS  = 10_000   // standard close delay for all doors
  // Doors opened by non-escort BGs specifically to clear VIP's path.
  // Held open (timer pinned) until VIP physically crosses through them,
  // then removed so the normal countdown takes over.
  private vipCorridorDoors   = new Set<number>()

  // VIP-room doors: all start BLOCKED. Every VIP_DOOR_UNLOCK_INTERVAL_MS one
  // random still-blocked door becomes SOLID (closed but openable). Players /
  // VIP can then click it to open.
  private unlockedVipRoomDoors = new Set<number>()
  // Unlock interval is driven by cfg.VIP_ROOM_LOCK_S (config.json, hot-reloadable).
  // Each unlocked door takes this many ms before the next door is unblocked.
  private get VIP_DOOR_UNLOCK_INTERVAL_MS(): number { return cfg.VIP_ROOM_LOCK_S * 1000 }

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

  // After a door auto-closes, give a 5 s window where tryClaimDoor won't
  // immediately re-claim it. Without this, a bodyguard standing adjacent at
  // the moment of auto-close would re-block the door (SOLID→BLOCKED) on their
  // very next player_tile tick, making it invisible to haters that the door
  // had closed at all.  Maps wallIdx → timestamp when grace expires.
  private doorAutoCloseGrace = new Map<number, number>()
  private readonly DOOR_CLAIM_GRACE_MS = 5_000

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
    // Never auto-dispose when clients.length drops to 0 — a match may be in
    // progress with all clients temporarily disconnected (scene reload, network
    // blip). Without this the room is destroyed the moment the last client
    // leaves, wiping playerBackup and the full game state so reconnecting
    // players land in a fresh lobby instead of their running match.
    this.autoDispose = false

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
        bombFuseMs:          c.BOMB_FUSE_MS,
      })
      console.log(`[GameRoom] Re-broadcast scene_config (phase=${this.state.phase}): firstPerson=${c.ENABLE_GAME_ZONE_FIRST_PERSON} roofPhysics=${c.ENABLE_ROOF_PHYSICS_COLLIDER} allowAllTileOverlap=${c.ALLOW_ALL_TILE_OVERLAP} bombFuseMs=${c.BOMB_FUSE_MS}`)
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
      if (restored.inQueue) {
        // Player reconnected during countdown — put them back in the queue.
        // No teleport needed: they stay in the lobby and will be teleported to
        // the game zone when startGame() runs (same as a fresh queue join).
        p.inQueue = true
        this.state.queueCount++
        console.log(`[GameRoom] onJoin re-queued ${userId} during countdown [reconnect]`)
      } else if (restored.isAlive && restored.zone === 'game') {
        // Alive, in-game: restore to the saved tile.
        if (wasReconnect) {
          this.evictFromTile(restored.tileCol, restored.tileRow, client.sessionId, p.team !== 'bodyguard')
        }
        const wx = restored.tileCol * 2 + 1
        const wy = 15.5
        const wz = restored.tileRow * 2 + 1
        client.send('teleport', { x: wx, y: wy, z: wz, cx: wx, cy: wy, cz: wz + 1 })
        console.log(`[GameRoom] onJoin restored ${userId} to (${restored.tileCol},${restored.tileRow})${wasReconnect ? ' [reconnect]' : ' [duplicate-tab]'}`)
      } else if (restored.zone === 'spectator') {
        // Active spectator (dead player watching the game):
        // send to the spectator zone. The client's spectator camera + UI are
        // driven by the spectating:true flag on the teleport message.
        client.send('teleport', { x: 16, y: 2.1, z: 26.5, cx: 16, cy: 3.0, cz: 26, spectating: true })
        console.log(`[GameRoom] onJoin restored ${userId} as spectator`)
      }
      // else: lobby player — no teleport needed, they stay wherever they were
    }

    console.log(`[GameRoom] ${client.sessionId} joined as ${userId} — total: ${this.state.playerCount}`)

    client.send('welcome', { sessionId: client.sessionId, phase: this.state.phase })
    // Надсилає налаштування сцени (камера, стеля) — визначені в server/src/game/constants.ts.
    // Клієнт застосовує їх через applySceneConfig() у gameZone.ts.
    client.send('scene_config', {
      firstPerson:         cfg.ENABLE_GAME_ZONE_FIRST_PERSON,
      roofPhysics:         cfg.ENABLE_ROOF_PHYSICS_COLLIDER,
      allowAllTileOverlap: cfg.ALLOW_ALL_TILE_OVERLAP,
      bombFuseMs:          cfg.BOMB_FUSE_MS,
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

    // Queued players who disconnect during countdown should be re-queued on
    // reconnect. Keep their placeholder so handleGhostsForUserId finds it.
    // We do NOT decrement queueCount here — the slot is still reserved.
    const isCountdownQueued = this.state.phase === 'countdown'
                              && !!p.userId
                              && p.inQueue

    if (isActiveGameplay || isCountdownQueued) {
      p.connected      = false
      p.disconnectedAt = Date.now()
      if (isActiveGameplay) {
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
      }
      // Clear VIP follower if disconnecting bodyguard was leading the VIP.
      if (this.state.vip.followerId === client.sessionId) this.state.vip.followerId = ''
      console.log(`[GameRoom] ${client.sessionId} disconnected (code ${code}) — ${isCountdownQueued ? 'countdown re-queue hold' : 'grace period started'}`)
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
      client.send('teleport', { x: 16, y: 2.1, z: 26.5, cx: 16, cy: 3.0, cz: 26, spectating: true })
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

      // validIntermediate: for manh=2 moves, the first passable midpoint tile.
      // Saved here so the isTileOccupiedByOther block can fall back to it
      // instead of teleporting the player all the way back to the server's
      // stored tile (which may be outside the VIP room).
      let validIntermediate: { col: number; row: number } | null = null

      if (manh === 1) {
        // If the wall/door physically blocks this step, just ignore the report —
        // DCL physics already stopped the player on the client side, so no
        // server teleport is needed. Teleporting causes a visible snap-back
        // (e.g. when pressing against a locked VIP room door) that feels wrong.
        // We keep teleportBack() only for manh > 2 (extreme jumps) and for
        // occupied-tile corrections below.
        if (!canMoveBetween(p.tileCol, p.tileRow, newCol, newRow, wt, ws)) return
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
        validIntermediate = intermediates.find(mid =>
          canMoveBetween(p.tileCol, p.tileRow, mid.col, mid.row, wt, ws) &&
          canMoveBetween(mid.col, mid.row, newCol, newRow, wt, ws)
        ) ?? null
        if (!validIntermediate) { teleportBack(); return }
      }

      // ALLOW_ALL_TILE_OVERLAP: skip the rejection entirely. Any player can
      // stand on any other player's tile (including the VIP's). Default false.
      if (!cfg.ALLOW_ALL_TILE_OVERLAP) {
        // All players — including haters — are allowed to enter VIP's tile.
        // Haters that register on VIP's tile are evicted server-side each NPC
        // tick (evictHatersFromVipTile) and receive a teleport back to a free
        // neighbouring tile.  Blocking the tile update here made the eviction
        // invisible to the server (it never saw the hater as co-located) so
        // haters appeared to stand on VIP without ever being pushed.
        const allowVipOverlap = true
        if (this.isTileOccupiedByOther(newCol, newRow, client.sessionId, allowVipOverlap, p.team)) {
          // For manh=2 moves, advance to the valid intermediate tile so the
          // player gets as close as possible to the destination.
          // Critical case: hater at col=3 (outside) jumps to col=1 (VIP's tile).
          // Without this they'd end up stuck at col=3 or bounce outside;
          // with this they land on col=2 and can attack VIP from there.
          if (validIntermediate
              && !this.isTileOccupiedByOther(validIntermediate.col, validIntermediate.row,
                                              client.sessionId, false, p.team)) {
            p.tileCol = validIntermediate.col
            p.tileRow = validIntermediate.row
            return
          }
          // manh=1 (or intermediate also occupied): do NOT teleport back.
          //
          // Root cause of the VIP-room pushback bug:
          //   VIP's hitbox is 0.8 m — smaller than the 2 m tile. A hater
          //   physically reaches col=2 (VIP's tile space) before the hitbox
          //   stops them. The old teleportBack() sent the player to the server's
          //   stored tile — which was col=3 (outside) when they hadn't yet been
          //   confirmed inside the room. That is what "constantly pushed out"
          //   feels like. Worse, VIP moves to col=2 (door tile) when following
          //   an escort; while she's there the server kept bouncing haters to
          //   col=3 on every attempt.
          //
          // Fix: just `return`. DCL physics already stopped the player at the
          // contact surface. The server keeps the player at their last confirmed
          // tile. As soon as VIP moves off the blocked tile the next player_tile
          // report succeeds normally — no visible snap required.
          return
        }
      }

      // vipRoomLocked: haters cannot enter VIP-room tiles while the room is
      // still locked. The physical walls (STATE_BLOCKED) already prevent this
      // in canMoveBetween above; this is a server-side safety net for any edge
      // case where a blocked door report slips through.
      // Use plain `return` (no teleport) — the physical wall handles position;
      // a teleportBack here would cause a visible snap on the locked-door press.
      if (p.team === 'hater'
          && this.state.vipRoomLocked
          && this.vipRoomTileSet.has(newRow * GRID_COLS + newCol)) {
        return
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
    // Throw the player's bomb onto an enemy player's / VIP's tile.
    // targetId = sessionId of an enemy player, or '__vip__' for the VIP.
    this.onMessage('throw_bomb', (client: Client, data: { targetId: string }) => {
      if (typeof data?.targetId === 'string') this.handleThrowBomb(client.sessionId, data.targetId)
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

      this.vipDoorUnlockTimer += dt
      if (this.vipDoorUnlockTimer >= this.VIP_DOOR_UNLOCK_INTERVAL_MS) {
        this.vipDoorUnlockTimer = 0
        this.unlockOneVipRoomDoor()
      }

      this.processPendingAttacks()
      this.processBombs()
      this.autoCloseDoors(dt)
      this.processDoorClaims()
      this.processDisconnectGrace()
      // Guard: if VIP already reached the safe zone (reachedSafe=true), the
      // bodyguard-win setTimeout is pending — do NOT let a simultaneous timeout
      // tick fire endGame('draw') and steal the win from bodyguards. The 1-second
      // VIP_SAFE_WIN_DELAY_MS is deliberately shorter than any possible game-loop
      // gap, so the bodyguard endGame fires before any realistic overtime window.
      if (this.state.timeRemaining <= 0 && !this.state.vip.reachedSafe) {
        this.endGame('draw', 'timeout')  // VIP alive but time ran out → draw
      }
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
    this.vipFleeing       = false
    this.vipFleeSteps     = 0
    this.vipFleeLastDir   = null
    this.vipFleeOrigin    = null
    this.vipWasHitByHater = false
    this.vipDeadEndEscape = null
    this.vipAvoidTile     = null
    this.vipFleeRoute    = []
    this.vipFleeRouteIdx = 0
    this.vipFleePhase    = 1
    this._vipVisitedDeadEnds.clear()
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
    // VIP-room doors start BLOCKED (locked). Every VIP_DOOR_UNLOCK_INTERVAL_MS
    // one door switches to SOLID so haters can click to open it.
    this.state.vipRoomLocked    = true
    this.unlockedVipRoomDoors   = new Set()
    this.vipDoorUnlockTimer     = 0
    for (const idx of cfg.vipRoomDoors) {
      this.state.wallStates[idx]     = STATE_BLOCKED
      this.state.wallClaimTeams[idx] = 1
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
    // Fisher-Yates shuffle — randomises which specific players end up on each team.
    for (let i = queued.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [queued[i], queued[j]] = [queued[j], queued[i]]
    }

    const n = queued.length
    // Even count → exact 50/50 split.
    // Odd count  → the extra player goes to bodyguards OR haters with equal
    //              probability (50/50). Previously Math.ceil always pushed the
    //              odd player to bodyguards, making bodyguards more common in
    //              every odd-sized lobby.
    const base    = Math.floor(n / 2)
    const bgCount = n % 2 === 0
      ? base
      : base + (Math.random() < 0.5 ? 1 : 0)

    queued.forEach((p, i) => { p.team = i < bgCount ? 'bodyguard' : 'hater' })
    console.log(`[GameRoom] assignTeams: ${n} players → ${bgCount} bodyguard(s), ${n - bgCount} hater(s)`)
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
    this.vipFleeSteps     = 0
    this.vipFleeRoute     = []
    this.vipFleeRouteIdx  = 0
    this.vipFleePhase     = 1
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
    this.vipFleeing       = false
    this.vipFleeSteps     = 0
    this.vipFleeLastDir   = null
    this.vipFleeOrigin    = null
    this.vipWasHitByHater = false
    this.vipDeadEndEscape = null
    this.vipAvoidTile     = null
    this.vipFleeRoute    = []
    this.vipFleeRouteIdx = 0
    this.vipFleePhase    = 1
    this._vipVisitedDeadEnds.clear()
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
    this.doorAutoCloseMs.clear()
    this.doorAutoCloseGrace.clear()
    this.vipCorridorDoors.clear()
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
        && this.state.wallStates[d] !== STATE_OPEN   // skip already-open doors
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

  // Push any hater standing on VIP's tile to the nearest free neighbour.
  // Called both from stepVipNormal/stepVipFleeing (when VIP moves) and from
  // the top of moveNpc (every NPC tick) so that a hater who arrived while
  // VIP was stationary is also evicted promptly.
  private evictHatersFromVipTile(vip: VIPState): void {
    if (!vip.active) return
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]
    for (const [sid, p] of this.state.players.entries()) {
      if (p.team !== 'hater' || p.zone !== 'game' || !p.isAlive) continue
      if (p.tileCol !== vip.tileCol || p.tileRow !== vip.tileRow) continue
      const pushed = this.forceKnockbackToFreeNeighbour(p, vip.tileCol, vip.tileRow, wt, ws)
      if (pushed) {
        const wx  = p.tileCol    * 2 + 1, wz  = p.tileRow    * 2 + 1
        const vwx = vip.tileCol  * 2 + 1, vwz = vip.tileRow  * 2 + 1
        this.clients.find(c => c.sessionId === sid)
          ?.send('teleport', { x: wx, y: 15.5, z: wz, cx: vwx, cy: 16.5, cz: vwz })
      }
    }
  }

  private moveNpc() {
    const vip = this.state.vip
    if (!vip.active) return
    // Once VIP has reached the safety tile we freeze her in place until the
    // delayed bodyguard-win endGame fires (see triggerVipSafeWin). Without
    // this guard the NPC tick could keep her wandering during the visual
    // interpolation window.
    if (vip.reachedSafe) return

    // Evict any hater co-located with VIP every NPC tick — covers the case
    // where VIP is stationary (no escort, fleeing done) and a hater managed
    // to stand on her tile.
    this.evictHatersFromVipTile(vip)

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
        // Fire immediately when VIP was just hit (< 2 s ago) — she needs to
        // escape right away. Also fire when the hater has been idle for
        // DEAD_END_IDLE_PUSH_MS without attacking (the original condition).
        const justHit  = vip.lastDamageTime > 0 && now - vip.lastDamageTime < 2000
        if (blocker && (justHit || now - blocker.lastDealtTime > this.DEAD_END_IDLE_PUSH_MS)) {
          const beforeCol = blocker.tileCol, beforeRow = blocker.tileRow
          const pushed = this.forceKnockbackToFreeNeighbour(
            blocker, vip.tileCol, vip.tileRow, wt, ws
          )
          if (pushed && (blocker.tileCol !== beforeCol || blocker.tileRow !== beforeRow)) {
            const sid = [...this.state.players.entries()]
              .find(([, p]) => p === blocker)?.[0]
            if (sid) {
              const wx  = blocker.tileCol * 2 + 1, wz  = blocker.tileRow * 2 + 1
              const vwx = vip.tileCol      * 2 + 1, vwz = vip.tileRow      * 2 + 1
              this.clients.find(c => c.sessionId === sid)
                ?.send('teleport', { x: wx, y: 15.5, z: wz, cx: vwx, cy: 16.5, cz: vwz })
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
        // Clear any precomputed route: stepVipNormal moves VIP outside the
        // route's expected path, so a fresh route must be computed after.
        this.vipFleeRoute    = []
        this.vipFleeRouteIdx = 0
        this.vipFleePhase    = 1
        this.stepVipNormal(vip, esc)
        return
      }
    }

    // 1. Bodyguard adjacent → exit flee/bypass, resume escort.
    const adjBGEntry = this.findAdjacentBodyguardEntry(vip.tileCol, vip.tileRow)
    if (this.vipFleeing && adjBGEntry) {
      this.clearVipFlee()
      // VIP exits flee when a bodyguard is adjacent — she stops running.
      // followerId is only set when a bodyguard explicitly clicks VIP (handleFollowVip).
    }

    // 2. Hater adjacent.
    const adjHater = this.findAdjacentHater(vip.tileCol, vip.tileRow, wt, ws)
    if (adjHater) {
      // Compute ALL wall-aware adjacent haters (Chebyshev ≤ 1, L-path check for
      // diagonals) once here — used in step 2a (BG adjacent) and cluster detection.
      const allAdjHaters: PlayerState[] = []
      for (const p of this.state.players.values()) {
        if (p.team !== 'hater' || p.zone !== 'game' || !p.isAlive) continue
        const hdc = Math.abs(p.tileCol - vip.tileCol), hdr = Math.abs(p.tileRow - vip.tileRow)
        if (hdc > 1 || hdr > 1 || hdc + hdr === 0) continue
        if (hdc === 1 && hdr === 1) {
          const vdc = p.tileCol - vip.tileCol, vdr = p.tileRow - vip.tileRow
          const pA = canMoveBetween(vip.tileCol, vip.tileRow, vip.tileCol + vdc, vip.tileRow, wt, ws)
                  && canMoveBetween(vip.tileCol + vdc, vip.tileRow, p.tileCol, p.tileRow, wt, ws)
          const pB = canMoveBetween(vip.tileCol, vip.tileRow, vip.tileCol, vip.tileRow + vdr, wt, ws)
                  && canMoveBetween(vip.tileCol, vip.tileRow + vdr, p.tileCol, p.tileRow, wt, ws)
          if (pA || pB) allAdjHaters.push(p)
          continue
        }
        if (canMoveBetween(vip.tileCol, vip.tileRow, p.tileCol, p.tileRow, wt, ws)) allAdjHaters.push(p)
      }

      if (adjBGEntry) {
        const [, adjBG] = adjBGEntry
        // Step 2a: BG adjacent + hater adjacent → merge onto BG's tile immediately.
        // Previous scoring logic (find cardinal neighbour farther from hater) caused
        // oscillation: when the hater was diagonal between VIP and BG, BG's tile had
        // newHaterDist ≤ curHaterDist and was excluded — VIP moved AWAY from BG instead.
        // Merging is always correct: the bodyguard physically shields VIP by sharing
        // the tile, and the client shows the hitbox of the BG (not VIP) for haters
        // whenever they are co-located.
        if (vip.tileCol !== adjBG.tileCol || vip.tileRow !== adjBG.tileRow) {
          if (canMoveBetween(vip.tileCol, vip.tileRow, adjBG.tileCol, adjBG.tileRow, wt, ws)) {
            this.stepVipNormal(vip, { col: adjBG.tileCol, row: adjBG.tileRow })
          } else {
            // BG is diagonal — need one cardinal step toward BG's tile.
            const haterSet2a = this.haterTileSet()
            const bgPath2a = findPath(
              { col: vip.tileCol, row: vip.tileRow },
              { col: adjBG.tileCol, row: adjBG.tileRow },
              wt, ws, haterSet2a
            )
            if (bgPath2a.length >= 2) this.stepVipNormal(vip, bgPath2a[1])
          }
        }
        return
      }

      // No adjacent BG.
      // Route toward BG directly, avoiding only hater tiles.
      // Do NOT compute a shield tile here — the shield position depends on the
      // live positions of both BG and the hater, which change every tick while
      // VIP is moving.  Chasing a shield tile that shifts each tick is the root
      // cause of VIP oscillating and triggering unnecessary pushbacks.
      // Precise shield positioning (adjBGEntry block) is handled automatically
      // once VIP closes the distance and BG becomes adjacent.
      {
        const follower = vip.followerId ? this.state.players.get(vip.followerId) : null
        if (follower && follower.isAlive && follower.zone === 'game') {
          // VIP is co-located with BG (on the same tile) — findAdjacentBodyguardEntry
          // excludes this case (dc+dr > 0), so adjBGEntry was null above even though
          // BG is literally here.  findPath(same, same) returns length=1, which fails
          // the path.length >= 2 check and would fall through to push logic every tick,
          // causing an endless push cycle whenever a hater is diagonally adjacent.
          // Fix: if already on BG's tile, BG is already shielding VIP — just stay.
          if (vip.tileCol === follower.tileCol && vip.tileRow === follower.tileRow) return

          const haterBlocked = this.haterTileSet()
          const path = findPath(
            { col: vip.tileCol, row: vip.tileRow },
            { col: follower.tileCol, row: follower.tileRow },
            wt, ws, haterBlocked
          )
          if (path.length >= 2) {
            this.stepVipNormal(vip, path[1])
            return
          }
          // Path to BG is fully blocked by hater — fall through to push/flee.
        }
      }
      // Truly blocked — no path around hater exists.
      // allAdjHaters was computed before the adjBGEntry check above — reuse it.

      // A cluster exists when at least two adjacent haters are also within
      // Chebyshev ≤ 1 of EACH OTHER with no wall separating them — i.e. they
      // form a pack that collectively blocks the corridor and cannot be broken
      // with a single push. Two haters in different corridors separated by a
      // wall are NOT a cluster even if they are Chebyshev-adjacent.
      const hasPairedCluster = allAdjHaters.length >= 2 && allAdjHaters.some((ha, i) =>
        allAdjHaters.some((hb, j) => {
          if (j <= i) return false
          const hdx = Math.abs(ha.tileCol - hb.tileCol), hdy = Math.abs(ha.tileRow - hb.tileRow)
          if (hdx > 1 || hdy > 1 || (hdx + hdy) === 0) return false
          if (hdx + hdy === 1) {
            // Cardinal pair — only a cluster when no wall separates them.
            return canMoveBetween(ha.tileCol, ha.tileRow, hb.tileCol, hb.tileRow, wt, ws)
          }
          // Diagonal pair — cluster when at least one L-path around the corner is open.
          const vdc = hb.tileCol - ha.tileCol, vdr = hb.tileRow - ha.tileRow
          const pA = canMoveBetween(ha.tileCol, ha.tileRow, ha.tileCol + vdc, ha.tileRow, wt, ws)
                  && canMoveBetween(ha.tileCol + vdc, ha.tileRow, hb.tileCol, hb.tileRow, wt, ws)
          const pB = canMoveBetween(ha.tileCol, ha.tileRow, ha.tileCol, ha.tileRow + vdr, wt, ws)
                  && canMoveBetween(ha.tileCol, ha.tileRow + vdr, hb.tileCol, hb.tileRow, wt, ws)
          return pA || pB
        })
      )

      if (!hasPairedCluster) {
        // ── No cluster (0–1 hater adjacent, or multiple but spread apart) ───
        // If VIP has an active escort, try to push the hater to clear the path.
        const followerForPush = vip.followerId
          ? this.state.players.get(vip.followerId) : null
        if (followerForPush && followerForPush.isAlive && followerForPush.zone === 'game') {
          const haterToKick = allAdjHaters[0] ?? adjHater
          const pushed = this.forceKnockbackToFreeNeighbour(
            haterToKick, vip.tileCol, vip.tileRow, wt, ws
          )
          if (pushed) {
            const haterSid = [...this.state.players.entries()]
              .find(([, p]) => p === haterToKick)?.[0]
            if (haterSid) {
              const wx  = haterToKick.tileCol * 2 + 1, wz  = haterToKick.tileRow * 2 + 1
              const vwx = vip.tileCol          * 2 + 1, vwz = vip.tileRow          * 2 + 1
              this.clients.find(c => c.sessionId === haterSid)
                ?.send('teleport', { x: wx, y: 15.5, z: wz, cx: vwx, cy: 16.5, cz: vwz })
            }
            haterToKick.lastDealtTime = Date.now()
            // Re-path to follower BG with hater now relocated.
            const haterBlocked2 = this.haterTileSet()
            const target2 = this.pickShieldTile(followerForPush, haterToKick, wt, ws)
              ?? { col: followerForPush.tileCol, row: followerForPush.tileRow }
            const path2 = findPath(
              { col: vip.tileCol, row: vip.tileRow },
              target2, wt, ws, haterBlocked2
            )
            if (path2.length >= 2) {
              this.stepVipNormal(vip, path2[1])
              return
            }
          }
          // Push failed or no clear path after push — fall through to flee if hit.
        }
        // No active escort, or escort push/re-path failed.
        // If VIP was not yet hit, stay in place — no reason to act.
        if (!this.vipWasHitByHater) return
        // fall through → flee block (push handled there as last resort)
      }

      // ── Flee: after VIP was hit by a hater ──────────────────────────────
      if (!this.vipWasHitByHater) return

      // Activate flee on FIRST hit only — do not reset route if already fleeing.
      // Route system (Step 4) handles ALL VIP movement; no greedy step here.
      // The old greedy step caused route oscillation: VIP stepped backward away
      // from the hater, making the precomputed route stale, which triggered
      // repeated back-and-forth movement. Step 4 now handles the push itself.
      if (!this.vipFleeing) {
        this.vipFleeing    = true
        this.vipFleeSteps  = 0
        this.vipFleeRoute  = []
        this.vipFleeRouteIdx = 0
        this.vipFleePhase  = 1
        this.vipFleeOrigin = { col: vip.tileCol, row: vip.tileRow }
      }
      // Fall through — Step 4 runs this same tick and drives movement.
    }

    // 3. No adjacent hater — vipWasHitByHater stays set; flee continues if active.
    // If VIP was hit but flee was never activated (hater was knocked far enough
    // away that adjHater was null when the NPC tick fired), start fleeing now so
    // she doesn't stay frozen waiting for the hater to walk back to her.
    if (this.vipWasHitByHater && !this.vipFleeing) {
      this.vipFleeing    = true
      this.vipFleeSteps  = 0
      this.vipFleeRoute  = []
      this.vipFleeRouteIdx = 0
      this.vipFleePhase  = 1
      this.vipFleeOrigin = this.vipFleeOrigin ?? { col: vip.tileCol, row: vip.tileRow }
    }

    // 4. Flee mode — two-phase route system.
    //
    //    Phase 1 (vipFleeSteps < VIP_FLEE_TILES): escape ≥ 8 tiles from the hit
    //    position following a full A* route. VIP NEVER takes a greedy step —
    //    the route handles all movement, haters blocking the path are pushed.
    //
    //    Phase 2 (vipFleeSteps ≥ VIP_FLEE_TILES): find a SOLID door nearby,
    //    cross it and stand 1 tile past it so the door blocks pursuit.
    //    If no door is available VIP checks safety and either stops or restarts
    //    with a new Phase 1 route.
    //
    //    Safety check uses wall-aware A* (closed doors = real barriers), so VIP
    //    correctly identifies herself as safe when a hater is on the other side
    //    of a door she just blocked.
    if (this.vipFleeing) {
      const VIP_SAFE_RADIUS = 4

      // No haters alive — nothing to flee from
      let nearestHater: PlayerState | null = null
      let nearestDist = Infinity
      for (const p of this.state.players.values()) {
        if (p.team !== 'hater' || !p.isAlive || p.zone !== 'game') continue
        const d = Math.abs(p.tileCol - vip.tileCol) + Math.abs(p.tileRow - vip.tileRow)
        if (d < nearestDist) { nearestDist = d; nearestHater = p }
      }
      if (!nearestHater) { this.clearVipFlee(); return }

      // Helper: push a hater and send their teleport
      const pushHaterAndTeleport = (p: PlayerState): boolean => {
        const bC = p.tileCol, bR = p.tileRow
        const pushed = this.forceKnockbackToFreeNeighbour(p, vip.tileCol, vip.tileRow, wt, ws)
        if (!pushed || (p.tileCol === bC && p.tileRow === bR)) return false
        const sid = [...this.state.players.entries()].find(([, x]) => x === p)?.[0]
        if (sid) {
          const wx = p.tileCol * 2 + 1, wz = p.tileRow * 2 + 1
          this.clients.find(c => c.sessionId === sid)
            ?.send('teleport', { x: wx, y: 15.5, z: wz,
                cx: vip.tileCol * 2 + 1, cy: 16.5, cz: vip.tileRow * 2 + 1 })
        }
        p.lastDealtTime = now
        return true
      }

      // ── Route management ─────────────────────────────────────────────────
      if (this.vipFleeRoute.length === 0 || this.vipFleeRouteIdx >= this.vipFleeRoute.length) {

        if (this.vipFleeSteps < cfg.VIP_FLEE_TILES) {
          // ── Phase 1: escape ≥ VIP_FLEE_TILES steps ─────────────────────
          this.vipFleePhase = 1
          const route1 = this.pickVipFleeRoute(vip, wt, ws)
          if (route1.length >= 2) {
            this.vipFleeRoute    = route1
            this.vipFleeRouteIdx = 1
          } else {
            // Structurally no 8-tile route (very rare) — push nearest hater
            const h = this.findNearestHater(vip.tileCol, vip.tileRow, VIP_SAFE_RADIUS)
            if (h) pushHaterAndTeleport(h)
            else   this.clearVipFlee()
            return
          }
        } else {
          // ── Phase 2: hide in a random dead-end or corridor ──────────────
          // Safety check FIRST: if haters cannot reach VIP (e.g. door blocked
          // between them), Phase 2 is unnecessary — stop fleeing immediately.
          if (this.isVipSafeWallAware(vip, wt, ws, VIP_SAFE_RADIUS)) {
            this.clearVipFlee()
            return
          }
          // Hide in a nearby dead-end or quiet corridor.
          // Phase 2 uses a shorter minDist (half of Phase 1) so VIP picks the
          // nearest available spot rather than running another full 8 tiles.
          // pickVipFleeRoute internally tries hater-avoiding A* first, so VIP
          // will route around threats rather than through them when possible.
          const phase2MinDist = Math.max(2, Math.floor(cfg.VIP_FLEE_TILES / 2))
          const route2 = this.pickVipFleeRoute(vip, wt, ws, phase2MinDist)
          if (route2.length >= 2) {
            this.vipFleeRoute    = route2
            this.vipFleeRouteIdx = 1
            this.vipFleePhase    = 2
          } else {
            // No hiding spot reachable — check with a wider safety radius.
            // If VIP is reasonably clear, just stop; otherwise push last resort.
            if (this.isVipSafeWallAware(vip, wt, ws, VIP_SAFE_RADIUS + 2)) {
              this.clearVipFlee()
            } else {
              const h = this.findNearestHater(vip.tileCol, vip.tileRow, VIP_SAFE_RADIUS)
              if (h) pushHaterAndTeleport(h)
              else   this.clearVipFlee()
            }
            return
          }
        }
      }

      // ── Follow next route step ────────────────────────────────────────────
      const nextStep = this.vipFleeRoute[this.vipFleeRouteIdx]
      if (!nextStep) { this.clearVipFlee(); return }

      // fleeStates: SOLID doors → passable; own BLOCKED doors → still blocked
      // (prevents routing back through just-crossed doors causing backtracking)
      const fleeStates4 = this.vipFleePassableStates(wt, ws)
      const haterTiles4  = this.fleeBlockedSet()

      // Step is free — advance normally
      if (canMoveBetween(vip.tileCol, vip.tileRow, nextStep.col, nextStep.row, wt, fleeStates4)
          && !haterTiles4.has(nextStep.row * GRID_COLS + nextStep.col)
          && !this.isTileOccupied(nextStep.col, nextStep.row)) {
        this.vipFleeRouteIdx++
        this.stepVipFleeing(vip, nextStep)
        return
      }

      // ── Step is blocked ───────────────────────────────────────────────────
      const haterOnStep = [...this.state.players.values()].find(px =>
        px.team === 'hater' && px.isAlive && px.zone === 'game' &&
        px.tileCol === nextStep.col && px.tileRow === nextStep.row
      ) ?? null

      if (haterOnStep) {
        // ── Step 1: find a hater-AVOIDING path to the same destination ────
        // VIP prefers to reroute around the hater rather than push through.
        // Only when no avoidance path exists does she resort to pushing.
        const routeDest = this.vipFleeRoute[this.vipFleeRoute.length - 1]
        if (routeDest) {
          const haterBlocked4 = this.fleeBlockedSet()   // all live haters blocked
          const avoidPath = findPath(
            { col: vip.tileCol, row: vip.tileRow },
            routeDest,
            wt, fleeStates4, haterBlocked4
          )
          if (avoidPath.length >= 2) {
            // Found a clear path around the hater — reroute without pushing
            this.vipFleeRoute    = avoidPath
            this.vipFleeRouteIdx = 1
            return
          }
        }

        // ── Step 2: no avoidance path — push is the last resort ──────────
        const pushed = pushHaterAndTeleport(haterOnStep)
        if (pushed) {
          // Hater moved — take the step this tick
          if (canMoveBetween(vip.tileCol, vip.tileRow, nextStep.col, nextStep.row, wt, fleeStates4)
              && !this.isTileOccupied(nextStep.col, nextStep.row)) {
            this.vipFleeRouteIdx++
            this.stepVipFleeing(vip, nextStep)
          }
          return
        }
        // Push also failed (cluster/surrounded) — try a completely new route
        const vipExits = this._tileExitCount(vip.tileCol, vip.tileRow, wt, fleeStates4)
        if (vipExits >= 2) {
          const alt = this.pickVipFleeRoute(vip, wt, ws)
          if (alt.length >= 2) {
            this.vipFleeRoute    = alt
            this.vipFleeRouteIdx = 1
            return
          }
        }
        // Dead-end with unmovable hater — idle-push (top of moveNpc) will clear.
        return
      }

      // Route step unreachable due to wall-state change (door closed/opened).
      // Reset and recompute from scratch on next tick.
      this.vipFleeRoute    = []
      this.vipFleeRouteIdx = 0
      return
    }

    // 4.5. Dead-end self-escape (no active flee mode, no adjacent hater).
    // If VIP is stuck in a dead-end — either from normal wandering or because a
    // previous flee ended without clearing vipWasHitByHater (e.g. all flee paths
    // were blocked and pickFleeTile returned null every tick) — take one step
    // toward open space so she doesn't freeze there indefinitely.
    // The adjacent-hater check (step 2) already ran above and returned if there
    // was a real threat; reaching here means adjHater === null.
    if (!this.vipFleeing) {
      // Use escape states (allowOwnDoors=true) so VIP can exit a stub corridor
      // even if the only way out is a door she previously claimed. Without this,
      // VIP would be permanently trapped whenever her flee ended in a dead-end
      // behind her own blocked door.
      const escape45 = this.vipFleePassableStates(wt, ws, true)
      const exits45  = this._tileExitCount(vip.tileCol, vip.tileRow, wt, escape45)
      if (exits45 <= 1) {
        // Find the nearest main-labyrinth tile (≥2 exits via escape states).
        const blocked45 = this.haterTileSet()
        let bestTarget: { col: number; row: number } | null = null
        let bestDist = Infinity
        for (let r = 0; r < GRID_ROWS; r++) {
          for (let c = 0; c < GRID_COLS; c++) {
            if (c === vip.tileCol && r === vip.tileRow) continue
            if (blocked45.has(r * GRID_COLS + c)) continue
            if (this._tileExitCount(c, r, wt, escape45) < 2) continue
            const d = Math.abs(c - vip.tileCol) + Math.abs(r - vip.tileRow)
            if (d < bestDist) { bestDist = d; bestTarget = { col: c, row: r } }
          }
        }
        if (bestTarget) {
          const path45 = findPath(
            { col: vip.tileCol, row: vip.tileRow },
            bestTarget, wt, escape45, blocked45
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
      if (manh === 0) {
        // VIP is co-located with BG.  The shield tile is exactly 1 cardinal step
        // away from VIP (since it's adjacent to BG = VIP's current tile), so we
        // can move there directly in a single tick — no pathfinding needed.
        // Only do this when a reachable threat exists; otherwise stay put.
        const threat0 =
          this.findNearestHaterReachable(vip.tileCol, vip.tileRow, 2) ??
          this.findNearestHaterReachable(f.tileCol,   f.tileRow,   2)
        if (threat0) {
          const shield0 = this.pickShieldTile(f, threat0, wt, ws)
          if (shield0 && canMoveBetween(vip.tileCol, vip.tileRow, shield0.col, shield0.row, wt, ws)) {
            this.stepVipNormal(vip, shield0)
          }
        }
        return
      }

      if (canMoveBetween(vip.tileCol, vip.tileRow, f.tileCol, f.tileRow, wt, ws)) {
        // VIP is adjacent to BG (manh=1, no wall between them).
        // Check for a reachable threat using wall-aware A* so diagonal haters
        // behind wall corners don't cause jitter.
        const threatHater =
          this.findNearestHaterReachable(vip.tileCol, vip.tileRow, 2) ??
          this.findNearestHaterReachable(f.tileCol,   f.tileRow,   2)
        if (threatHater) {
          const shield = this.pickShieldTile(f, threatHater, wt, ws)
          if (shield && !(shield.col === vip.tileCol && shield.row === vip.tileRow)) {
            const blockedForShield = new Set(this.haterTileSet())
            const path = findPath({ col: vip.tileCol, row: vip.tileRow }, shield, wt, ws, blockedForShield)
            if (path.length >= 2) {
              // Only take the step when it moves VIP closer to BG (or stays same
              // distance) — prevents routing through adjacent corridors.
              const nxtManh = Math.abs(path[1].col - f.tileCol) + Math.abs(path[1].row - f.tileRow)
              const curManh = Math.abs(vip.tileCol  - f.tileCol) + Math.abs(vip.tileRow  - f.tileRow)
              if (nxtManh <= curManh) { this.stepVipNormal(vip, path[1]); return }
            }
            // Shield path goes away from BG — step directly to BG's tile instead.
            // From BG's tile VIP can reach the shield in one tick (manh=0 handler).
            this.stepVipNormal(vip, { col: f.tileCol, row: f.tileRow }); return
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
    const nearHater = this.findNearestHaterReachable(vip.tileCol, vip.tileRow, 3)
      ?? this.findNearestHaterReachable(f.tileCol, f.tileRow, 3)
    let targetCol = f.tileCol, targetRow = f.tileRow
    if (nearHater) {
      const shield5 = this.pickShieldTile(f, nearHater, wt, ws)
      if (shield5) {
        targetCol = shield5.col; targetRow = shield5.row
        // Do NOT block BG's tile — VIP is allowed to step through BG to reach
        // the shield position on the far side.
      }
    }
    const path5 = findPath(
      { col: vip.tileCol, row: vip.tileRow },
      { col: targetCol,   row: targetRow   },
      wt, ws, blocked5
    )
    if (path5.length >= 2) {
      this.stepVipNormal(vip, path5[1])
      return
    }

    // Shield path failed — unlikely now that BG's tile is no longer blocked,
    // but can still happen if the shield tile itself is a hater tile or is
    // temporarily unreachable (e.g. behind a still-closed door).  Fall back to
    // a direct path toward BG with only hater tiles blocked.
    if (targetCol !== f.tileCol || targetRow !== f.tileRow) {
      const fallbackBlocked = this.haterTileSet()
      const fallback5 = findPath(
        { col: vip.tileCol, row: vip.tileRow },
        { col: f.tileCol,   row: f.tileRow   },
        wt, ws, fallbackBlocked
      )
      if (fallback5.length >= 2) this.stepVipNormal(vip, fallback5[1])
    }
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
    // Release any VIP-corridor door that VIP just crossed (BG opened it for her path).
    if (wallIdx >= 0 && this.vipCorridorDoors.has(wallIdx)) {
      this.vipCorridorDoors.delete(wallIdx)
    }
    vip.facingYaw  = this.tileYaw(next.col - vip.tileCol, next.row - vip.tileRow)
    vip.tileCol    = next.col
    vip.tileRow    = next.row
    vip.lastMoveAt = Date.now()
    this.evictHatersFromVipTile(vip)
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
    // Cardinal neighbours of the bodyguard: checked first, require no wall
    // between BG and the candidate tile (canMoveBetween).
    // Diagonal neighbours: included as tiebreakers when they are farther from
    // the hater than the best cardinal — but only considered when BOTH
    // intermediate cardinal steps exist (BG can reach the diagonal via either
    // of the two 1-step cardinal routes), keeping VIP in the same local area.
    //
    // NOTE: callers in the adjBGEntry / manh≤1 blocks cap the A* path to
    // ≤ 2 steps (path.length ≤ 3) so that a diagonal shield tile in an
    // adjacent corridor is silently skipped rather than triggering a long
    // detour through the maze.
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
      // Only include the diagonal when at least one of the two intermediate
      // cardinal steps from BG is passable — otherwise BG cannot meaningfully
      // stand between VIP and the hater from that diagonal angle.
      const canViaCol = canMoveBetween(bg.tileCol, bg.tileRow, tc,           bg.tileRow, wt, ws)
      const canViaRow = canMoveBetween(bg.tileCol, bg.tileRow, bg.tileCol,   tr,         wt, ws)
      if (!canViaCol && !canViaRow) continue
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
    this.vipFleeSteps++
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
    // Release any VIP-corridor door that VIP just crossed while fleeing.
    if (wallIdx >= 0 && this.vipCorridorDoors.has(wallIdx)) {
      this.vipCorridorDoors.delete(wallIdx)
    }
    this.vipFleeLastDir = [next.col - vip.tileCol, next.row - vip.tileRow] as [number, number]
    vip.facingYaw  = this.tileYaw(next.col - vip.tileCol, next.row - vip.tileRow)
    vip.tileCol = next.col
    vip.tileRow = next.row
    vip.lastMoveAt = now
    this.vipFleeing = true
    // Record dead-end tiles VIP steps into so pickRandomWanderStep can avoid
    // sending her back into the same short corridors on future flee episodes.
    {
      const wt2 = this.state.wallTypes  as unknown as number[]
      const ws2 = this.state.wallStates as unknown as number[]
      if (this._tileExitCount(vip.tileCol, vip.tileRow, wt2, ws2) <= 1) {
        this._vipVisitedDeadEnds.add(vip.tileRow * GRID_COLS + vip.tileCol)
      }
    }
    this.evictHatersFromVipTile(vip)
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
      const st = this.state.wallStates[doorIdx]
      if (st === STATE_DESTROYED) continue
      if (st === STATE_BLOCKED) {
        // Skip doors with an active player or VIP claim — those are locked by
        // a running game action and VIP shouldn't try to re-enter/re-use them.
        // Initially-locked doors have NO doorClaim entry (only wallStates=BLOCKED
        // set in applyMazeConfig) — VIP can force through those.
        const claim = this.doorClaim.get(doorIdx)
        if (claim) continue
      }
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

  // ── clearVipFlee ─────────────────────────────────────────────────────────
  // Single place to reset all flee-related state. Called from every code path
  // that terminates a flee episode (BG arrives, safe after route, no haters, etc.).
  private clearVipFlee() {
    this.vipFleeing       = false
    this.vipFleeSteps     = 0
    this.vipFleeLastDir   = null
    this.vipFleeOrigin    = null
    this.vipAvoidTile     = null
    this.vipWasHitByHater = false
    this.vipDeadEndEscape = null
    this.vipFleeRoute     = []
    this.vipFleeRouteIdx  = 0
    this.vipFleePhase     = 1
  }

  // ── isVipSafeWallAware ───────────────────────────────────────────────────
  // Returns true if every live hater's actual walking distance to VIP (via A*
  // with current wallStates — closed/blocked doors count as barriers) is greater
  // than `radius`. A hater separated from VIP by a door VIP just blocked counts
  // as safe even if their Manhattan distance is only 1 tile.
  private isVipSafeWallAware(
    vip: VIPState, wt: number[], ws: number[], radius: number
  ): boolean {
    for (const p of this.state.players.values()) {
      if (p.team !== 'hater' || !p.isAlive || p.zone !== 'game') continue
      const manhattan = Math.abs(p.tileCol - vip.tileCol) + Math.abs(p.tileRow - vip.tileRow)
      if (manhattan > radius * 2 + 2) continue  // fast-path: definitely too far
      // Use actual wall states (not flee-passable): closed/blocked doors stay
      // closed for haters, so VIP behind her own blocked door is truly safe.
      const path = findPath(
        { col: p.tileCol, row: p.tileRow },
        { col: vip.tileCol, row: vip.tileRow },
        wt, ws
      )
      const dist = path.length === 0 ? Infinity : path.length - 1
      if (dist <= radius) return false
    }
    return true
  }

  // ── pickVipFleeRoute ─────────────────────────────────────────────────────
  // Computes a full A* escape path from VIP's current tile to a randomly chosen
  // dead-end (≤1 exit via flee-passable states) at least `cfg.VIP_FLEE_TILES`
  // BFS steps away. Returns an empty array only when no dead-end exists at that
  // structural distance (very rare — e.g. VIP is in a tiny isolated room).
  //
  // KEY DESIGN: BFS and A* deliberately do NOT block hater positions.
  // The route is computed based on maze structure alone; any hater standing on
  // a route tile is handled by the "push-first" mechanism in the route-following
  // block (step 4). This means VIP always finds a route even when a hater
  // stands between her and the rest of the maze — she walks toward the dead-end
  // and pushes any hater out of the way as she advances.
  //
  // Randomness prevents predictable patterns. `_vipVisitedDeadEnds` ensures VIP
  // does not circle back to the same short corridors on successive flee episodes.
  private pickVipFleeRoute(
    vip: VIPState, wt: number[], ws: number[], minDistOverride?: number
  ): Array<{ col: number; row: number }> {
    const fleeStates = this.vipFleePassableStates(wt, ws)
    const minDist    = minDistOverride ?? cfg.VIP_FLEE_TILES   // default 8

    // BFS from VIP using flee-passable states ONLY — hater positions are NOT
    // obstacles here so we can see the full structural distance to every tile
    // even when haters are blocking the corridor.
    const distances = new Map<number, number>()
    const bfsQueue: Array<{ col: number; row: number; dist: number }> = [
      { col: vip.tileCol, row: vip.tileRow, dist: 0 }
    ]
    distances.set(vip.tileRow * GRID_COLS + vip.tileCol, 0)
    const BFS_DIRS: Array<[number, number]> = [[0,1],[0,-1],[1,0],[-1,0]]
    while (bfsQueue.length > 0) {
      const cur = bfsQueue.shift()!
      for (const [dc, dr] of BFS_DIRS) {
        const nc = cur.col + dc, nr = cur.row + dr
        if (!this.tileInBounds(nc, nr)) continue
        const nk = nr * GRID_COLS + nc
        if (distances.has(nk)) continue
        if (!canMoveBetween(cur.col, cur.row, nc, nr, wt, fleeStates)) continue
        distances.set(nk, cur.dist + 1)
        bfsQueue.push({ col: nc, row: nr, dist: cur.dist + 1 })
      }
    }

    // Helper: true when a tile is blocked by a NON-HATER player (bodyguard).
    // Hater-occupied tiles are valid destinations — the push mechanism handles
    // them during route following. Bodyguards can't be displaced, so we skip.
    const blockedByNonHater = (c: number, r: number): boolean => {
      for (const p of this.state.players.values()) {
        if (!p.isAlive || p.zone !== 'game' || p.team === 'hater') continue
        if (p.tileCol === c && p.tileRow === r) return true
      }
      return false
    }

    // Classify reachable tiles into dead-ends and junctions
    const deadEnds:  Array<{ col: number; row: number; dist: number }> = []
    const junctions: Array<{ col: number; row: number; dist: number }> = []
    for (const [key, dist] of distances) {
      if (dist < minDist) continue
      const c = key % GRID_COLS
      const r = (key / GRID_COLS) | 0
      if (this.safetyTileSet.has(key)) continue
      if (this.vipAvoidTile && c === this.vipAvoidTile.col && r === this.vipAvoidTile.row) continue
      if (blockedByNonHater(c, r)) continue   // bodyguards block: skip
      const exits = this._tileExitCount(c, r, wt, fleeStates)
      if (exits <= 1) {
        // Prefer unvisited dead-ends (fresh hiding spots)
        if (!this._vipVisitedDeadEnds.has(key)) {
          deadEnds.push({ col: c, row: r, dist })
        }
      } else {
        junctions.push({ col: c, row: r, dist })
      }
    }

    // Prefer dead-ends; fall back to junctions when all are exhausted
    let pool = deadEnds.length > 0 ? deadEnds : junctions

    // If all dead-ends were visited, clear the visited set and try again
    if (pool.length === 0) {
      this._vipVisitedDeadEnds.clear()
      for (const [key, dist] of distances) {
        if (dist < minDist) continue
        const c = key % GRID_COLS
        const r = (key / GRID_COLS) | 0
        if (this.safetyTileSet.has(key)) continue
        if (blockedByNonHater(c, r)) continue
        const exits = this._tileExitCount(c, r, wt, fleeStates)
        if (exits <= 1) deadEnds.push({ col: c, row: r, dist })
        else            junctions.push({ col: c, row: r, dist })
      }
      pool = deadEnds.length > 0 ? deadEnds : junctions
    }
    if (pool.length === 0) return []

    // Pick randomly from the pool (not always the furthest) to vary routes
    const pick = pool[(Math.random() * pool.length) | 0]

    // Mark chosen dead-end as visited so VIP picks different spots next time
    this._vipVisitedDeadEnds.add(pick.row * GRID_COLS + pick.col)

    // First try A* WITH hater blocking: prefer a route that avoids pushing.
    // VIP should hide without confrontation when possible.
    const haterBlockedForPath = this.fleeBlockedSet()
    const pathAvoiding = findPath(
      { col: vip.tileCol, row: vip.tileRow },
      { col: pick.col,    row: pick.row    },
      wt, fleeStates, haterBlockedForPath
    )
    if (pathAvoiding.length >= 2) return pathAvoiding

    // No avoidance path — fall back to routing through haters.
    // The push mechanism in Step 4 handles any hater encountered on the path.
    return findPath(
      { col: vip.tileCol, row: vip.tileRow },
      { col: pick.col, row: pick.row },
      wt, fleeStates
    )
  }

  // ── pickVipDoorCrossRoute ────────────────────────────────────────────────
  // Phase 2 of flee: find a SOLID (uncrossed) door on the boundary of
  // VIP's currently accessible area, compute an A* path to the tile that is
  // 1 step PAST that door (on the far side). When VIP crosses the door,
  // `stepVipFleeing` → `vipBlockDoorBehind` automatically blocks it behind
  // her, preventing haters from following immediately.
  //
  // Discovery: BFS with ACTUAL wall states (no flee-passable override) defines
  // VIP's "current area" — tiles she can reach WITHOUT crossing any closed door.
  // SOLID doors at the boundary of that area are candidates. The tile 1 step
  // past each boundary door is the Phase 2 destination.
  //
  // Falls back to [] when no SOLID boundary door exists (e.g. VIP already used
  // all nearby doors in Phase 1). Caller then restarts Phase 1.
  private pickVipDoorCrossRoute(
    vip: VIPState, wt: number[], ws: number[]
  ): Array<{ col: number; row: number }> {
    const DIRS: Array<[number, number]> = [[0,1],[0,-1],[1,0],[-1,0]]

    // BFS with ACTUAL wall states (closed doors stay closed)
    // → all tiles reachable without opening any door
    const onVipSide = new Set<number>()
    const bfsQ: Array<{ col: number; row: number }> = [
      { col: vip.tileCol, row: vip.tileRow }
    ]
    onVipSide.add(vip.tileRow * GRID_COLS + vip.tileCol)
    while (bfsQ.length > 0) {
      const cur = bfsQ.shift()!
      for (const [dc, dr] of DIRS) {
        const nc = cur.col + dc, nr = cur.row + dr
        if (!this.tileInBounds(nc, nr)) continue
        const nk = nr * GRID_COLS + nc
        if (onVipSide.has(nk)) continue
        if (!canMoveBetween(cur.col, cur.row, nc, nr, wt, ws)) continue
        onVipSide.add(nk)
        bfsQ.push({ col: nc, row: nr })
      }
    }

    // Collect candidates: tiles that are exactly 1 step past a SOLID door on
    // the boundary of VIP's current area (= door between onVipSide and outside)
    const candidates: Array<{ col: number; row: number }> = []
    for (const key of onVipSide) {
      const c = key % GRID_COLS, r = (key / GRID_COLS) | 0
      for (const [dc, dr] of DIRS) {
        const nc = c + dc, nr = r + dr
        if (!this.tileInBounds(nc, nr)) continue
        const farKey = nr * GRID_COLS + nc
        if (onVipSide.has(farKey)) continue   // already reachable without door

        const wallIdx = wallIdxBetween({ col: c, row: r }, { col: nc, row: nr })
        if (wallIdx < 0) continue
        if (wt[wallIdx] !== WALL_WOOD_DOOR) continue
        if (ws[wallIdx] !== STATE_SOLID) continue   // only uncrossed SOLID doors

        // (nc, nr) is 1 tile past the door — the Phase 2 destination
        if (this.safetyTileSet.has(farKey)) continue
        // Skip if a non-hater (bodyguard) occupies the far side
        const nonHaterThere = [...this.state.players.values()].some(p =>
          p.isAlive && p.zone === 'game' && p.team !== 'hater' &&
          p.tileCol === nc && p.tileRow === nr
        )
        if (nonHaterThere) continue
        candidates.push({ col: nc, row: nr })
      }
    }

    if (candidates.length === 0) return []

    // Pick randomly so VIP doesn't always pick the same door
    const pick = candidates[(Math.random() * candidates.length) | 0]

    // A* using flee-passable states so VIP can cross the SOLID door
    const fleeStates = this.vipFleePassableStates(wt, ws)
    const path = findPath(
      { col: vip.tileCol, row: vip.tileRow },
      pick,
      wt, fleeStates
      // No hater blocking: push mechanism handles haters on the path
    )
    return path.length >= 2 ? path : []
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
      // Give an 80 % skip chance for dead-end tiles VIP already visited while
      // fleeing — prevents circling back into the same short corridors.
      if (this._vipVisitedDeadEnds.has(nr * GRID_COLS + nc) && Math.random() < 0.8) continue
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

    // Wall-aware hater distance: skip haters that are fully separated by walls
    // (both cardinal and diagonal). Mirrors canAttackTarget / findAdjacentHater:
    // a hater in a parallel corridor with no open L-path is not a real threat.
    const minHaterDist = (c: number, r: number) =>
      Math.min(...haterPos.map(h => {
        const dc = Math.abs(h.col - c)
        const dr = Math.abs(h.row - r)
        // Cardinal — skip if direct passage is blocked.
        if (dc + dr === 1 && !canMoveBetween(c, r, h.col, h.row, wt, ws)) return Infinity
        // Diagonal — skip if both L-paths around the corner are blocked.
        if (dc === 1 && dr === 1) {
          const vdc = h.col - c, vdr = h.row - r
          const pathA = canMoveBetween(c, r, c + vdc, r, wt, ws)
                     && canMoveBetween(c + vdc, r, h.col, h.row, wt, ws)
          const pathB = canMoveBetween(c, r, c, r + vdr, wt, ws)
                     && canMoveBetween(c, r + vdr, h.col, h.row, wt, ws)
          if (!pathA && !pathB) return Infinity
        }
        return dc + dr
      }))

    // Tiles directly on the far side of any UNCROSSED door adjacent to VIP get
    // a bonus so VIP prefers to duck through fresh doors as escape routes.
    // VIP-claimed BLOCKED doors are excluded — those tiles are on the side VIP
    // came from, and adding a bonus would incentivise routing back through them,
    // causing the "same door multiple times" bounce.
    const DOOR_BONUS = 3
    const doorBonusTiles = new Set<number>()
    for (const doorIdx of this.adjacentDoorsTo(vip.tileCol, vip.tileRow)) {
      // Skip doors VIP already claimed (BLOCKED + own claim).
      if (ws[doorIdx] === STATE_BLOCKED) {
        const claimD = this.doorClaim.get(doorIdx)
        if (claimD?.sid === GameRoom.VIP_CLAIM_SID) continue
      }
      const sides = this.wallSidesTiles(doorIdx)
      const vipOnA = sides.a.col === vip.tileCol && sides.a.row === vip.tileRow
      const far = vipOnA ? sides.b : sides.a
      doorBonusTiles.add(far.row * GRID_COLS + far.col)
    }

    // When VIP is inside the spawn room, exclude room tiles as destinations.
    // Room tiles score high when haters are near the doors (far inside = large
    // hDist), but this keeps VIP cycling inside instead of escaping. Forcing
    // only outside-room targets makes her path through a door deterministically.
    const vipInRoom = this.vipRoomTileSet.has(vip.tileRow * GRID_COLS + vip.tileCol)

    // Score every tile; keep top-20 candidates to try pathfinding into.
    // 20 attempts is negligible for A* on a 16×16 grid.
    const candidates: Array<{ col: number; row: number; score: number }> = []
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (c === vip.tileCol && r === vip.tileRow) continue
        if (haterTiles.has(r * GRID_COLS + c))         continue
        if (this.isTileOccupied(c, r))                 continue
        if (doorFree && this.isDoorAdjacent(c, r, wt)) continue
        // Never flee into the safety zone.
        if (this.safetyTileSet.has(r * GRID_COLS + c)) continue
        // Don't target the exact dead-end tile VIP just escaped from.
        if (this.vipAvoidTile && c === this.vipAvoidTile.col && r === this.vipAvoidTile.row) continue
        // While VIP is in the spawn room, only consider outside-room tiles.
        // This prevents her from scoring deep-room tiles as "safest" and keeps
        // her committed to exiting rather than circling inside.
        if (vipInRoom && this.vipRoomTileSet.has(r * GRID_COLS + c)) continue
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

      if (dc === 1 && dr === 1) {
        // Diagonal — only count as an adjacent threat when at least one
        // L-shaped path around the corner is physically open. This prevents
        // VIP from treating a hater in a parallel corridor (fully separated
        // by a solid wall) as an immediate threat and endlessly fleeing along
        // her side of the wall while the hater runs parallel in the next corridor.
        if (wt && ws) {
          const vdc = p.tileCol - col, vdr = p.tileRow - row
          const pathA = canMoveBetween(col, row, col + vdc, row, wt, ws)
                     && canMoveBetween(col + vdc, row, p.tileCol, p.tileRow, wt, ws)
          const pathB = canMoveBetween(col, row, col, row + vdr, wt, ws)
                     && canMoveBetween(col, row + vdr, p.tileCol, p.tileRow, wt, ws)
          if (!pathA && !pathB) continue  // completely walled off — not a real threat
        }
        return p
      }

      // Cardinal hater — only a real threat if no wall blocks the path.
      // If wt/ws not supplied, fall back to "assume threat" (safe default).
      if (wt && ws && !canMoveBetween(col, row, p.tileCol, p.tileRow, wt, ws)) continue

      return p
    }
    return null
  }

  // Build a wall-state view where SOLID doors look OPEN so VIP's flee-tile
  // search can route through closed-but-openable doors. BLOCKED doors stay
  // BLOCKED unless `allowOwnDoors` is true.
  //
  // allowOwnDoors = false (default, "strict" mode):
  //   VIP-claimed BLOCKED doors remain BLOCKED — prevents VIP from pathfinding
  //   BACK through a door she already crossed and blocked behind her. This is
  //   the main safeguard against the "same door multiple times" oscillation.
  //
  // allowOwnDoors = true ("escape" mode):
  //   VIP-claimed BLOCKED doors are opened. Used only in step 4.5 dead-end
  //   self-escape so VIP can exit a stub corridor even if the only way out is
  //   a door she previously claimed.
  private vipFleePassableStates(wt: number[], ws: number[], allowOwnDoors = false): number[] {
    const out = ws.slice()
    for (let i = 0; i < wt.length; i++) {
      if (wt[i] !== WALL_WOOD_DOOR) continue
      if (out[i] === STATE_SOLID) { out[i] = STATE_OPEN; continue }
      if (out[i] === STATE_BLOCKED) {
        const claim = this.doorClaim.get(i)
        // Initially-locked VIP-room door (no doorClaim entry at all): VIP can
        // always force her way through. Haters still can't open them — they are
        // refused in handleDoor regardless of wallStates.
        if (!claim) { out[i] = STATE_OPEN; continue }
        // VIP's own claimed door (vipBlockDoorBehind): passable only in step-4.5
        // escape mode so VIP can exit a stub corridor she locked behind herself.
        if (claim.sid === GameRoom.VIP_CLAIM_SID && allowOwnDoors) out[i] = STATE_OPEN
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
    // Grace period after auto-close: don't immediately re-claim the door so
    // both teams have a fair window to approach and open it.
    const grace = this.doorAutoCloseGrace.get(idx)
    if (grace !== undefined && Date.now() < grace) return

    const isVipRoomDoor      = this.mazeConfig?.vipRoomDoors.includes(idx) ?? false
    const isStillLockedVipDoor = isVipRoomDoor && !this.unlockedVipRoomDoors.has(idx)

    // Still-locked VIP-room doors: always bodyguard-owned for display, but no
    // personal claim (haters are refused in handleDoor regardless of claim).
    if (isStillLockedVipDoor) {
      this.state.wallClaimTeams[idx] = 1
      return
    }

    // Unlocked VIP-room doors skip auto-claiming entirely.
    // Without this, a bodyguard walking adjacent would lock the door
    // (STATE_SOLID → STATE_BLOCKED) before a hater could open it, making the
    // room inaccessible even after the unlock timer fires. Both teams should
    // be able to click-open unlocked VIP room doors freely (single click, no
    // prior claim required).
    if (isVipRoomDoor) return

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
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]
    let min = Infinity
    for (const p of this.state.players.values()) {
      if (p.team !== 'hater' || p.zone !== 'game' || !p.isAlive) continue
      const dc = Math.abs(p.tileCol - col)
      const dr = Math.abs(p.tileRow - row)
      // Cardinal-adjacent: skip if a wall blocks direct passage.
      if (dc + dr === 1 && !canMoveBetween(col, row, p.tileCol, p.tileRow, wt, ws)) continue
      // Diagonal-adjacent (Chebyshev = 1, Manhattan = 2): only count when at
      // least one L-path around the corner is open. Mirrors the canAttackTarget
      // fix — a hater fully separated by solid walls (parallel corridors) must
      // not affect VIP's flee-step guard or she will freeze/refuse valid escapes
      // because of a phantom threat through a wall she already passed.
      if (dc === 1 && dr === 1) {
        const vdc = p.tileCol - col, vdr = p.tileRow - row
        const pathA = canMoveBetween(col, row, col + vdc, row, wt, ws)
                   && canMoveBetween(col + vdc, row, p.tileCol, p.tileRow, wt, ws)
        const pathB = canMoveBetween(col, row, col, row + vdr, wt, ws)
                   && canMoveBetween(col, row + vdr, p.tileCol, p.tileRow, wt, ws)
        if (!pathA && !pathB) continue
      }
      const d = dc + dr
      if (d < min) min = d
    }
    return min
  }

  // Wall-aware version of findNearestHater: only counts haters whose actual
  // walkable path to (col,row) is ≤ maxPathDist steps. Haters that are within
  // Manhattan range but fully blocked by walls are ignored.
  // Used in escort logic so VIP doesn't freeze when a hater stands nearby but
  // is separated by an impassable wall.
  private findNearestHaterReachable(col: number, row: number, maxPathDist: number): PlayerState | null {
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]
    let best: PlayerState | null = null
    let bestDist = Infinity
    for (const p of this.state.players.values()) {
      if (p.team !== 'hater' || p.zone !== 'game' || !p.isAlive) continue
      // Fast pre-filter: Manhattan ≥ path distance, so if Manhattan > max → skip.
      const manDist = Math.abs(p.tileCol - col) + Math.abs(p.tileRow - row)
      if (manDist > maxPathDist) continue
      const path = findPath({ col, row }, { col: p.tileCol, row: p.tileRow }, wt, ws)
      const pathDist = path.length > 1 ? path.length - 1 : (path.length === 1 ? 0 : Infinity)
      if (pathDist <= maxPathDist && pathDist < bestDist) {
        bestDist = pathDist
        best = p
      }
    }
    return best
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
      if (vip.reachedSafe) return

      // ── Damage distribution: VIP + co-located bodyguards ────────────────
      // Bodyguards sharing VIP's tile absorb a share of the incoming damage,
      // shielding her. Knockback on the attacker is suppressed when at least
      // one bodyguard is present (the group absorbs the blow collectively).
      const bgsOnTile: [string, PlayerState][] = []
      for (const [sid, p] of this.state.players.entries()) {
        if (p.team === 'bodyguard' && p.isAlive && p.zone === 'game' &&
            p.tileCol === vip.tileCol && p.tileRow === vip.tileRow) {
          bgsOnTile.push([sid, p])
        }
      }
      const totalVipTargets = 1 + bgsOnTile.length
      const vipSplitDmg = totalVipTargets > 1
        ? Math.max(1, Math.floor(baseDmg / totalVipTargets))
        : baseDmg

      // Apply split damage to VIP
      vip.health = Math.max(0, vip.health - vipSplitDmg)
      vip.lastDamage = vipSplitDmg; vip.lastDamageTime = Date.now()
      this.vipWasHitByHater = true

      // Apply split damage to each co-located bodyguard
      const killedBGs: [string, PlayerState][] = []
      for (const [bgSid, bg] of bgsOnTile) {
        const bgResult = this.applyDamageToPlayer(bg, vipSplitDmg, info.src)
        this.clients.find(c => c.sessionId === bgSid)
          ?.send('hit', { damage: bgResult.hpDmg, attackerId,
                          shield: bgResult.shieldDmg, blocked: bgResult.fullyBlocked })
        if (bg.health <= 0) killedBGs.push([bgSid, bg])
      }

      // Dead-end detection (unchanged)
      const wt2 = this.state.wallTypes  as unknown as number[]
      const ws2 = this.state.wallStates as unknown as number[]
      {
        const dirs2: Array<[number,number]> = [[0,1],[0,-1],[1,0],[-1,0]]
        let exits2 = 0
        for (const [dc2, dr2] of dirs2) {
          const nc2 = vip.tileCol + dc2, nr2 = vip.tileRow + dr2
          if (this.tileInBounds(nc2, nr2) &&
              canMoveBetween(vip.tileCol, vip.tileRow, nc2, nr2, wt2, ws2)) exits2++
        }
        if (exits2 <= 1) {
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
      a.lastDealt = vipSplitDmg; a.lastDealtTime = Date.now()
      this.broadcast('hit_sound', { col: vip.tileCol, row: vip.tileRow })

      // No knockback when bodyguards are absorbing the blow with VIP
      if (!skipKnockback && bgsOnTile.length === 0) {
        const beforeCol = a.tileCol, beforeRow = a.tileRow
        this.tryKnockback(a, vip.tileCol, vip.tileRow)
        const moved = a.tileCol !== beforeCol || a.tileRow !== beforeRow
        if (!moved) {
          this.forceKnockbackToFreeNeighbour(a, vip.tileCol, vip.tileRow, wt2, ws2)
        }
        if (a.tileCol !== beforeCol || a.tileRow !== beforeRow) {
          const wx  = a.tileCol   * 2 + 1, wz  = a.tileRow   * 2 + 1
          const vwx = vip.tileCol * 2 + 1, vwz = vip.tileRow * 2 + 1
          this.clients.find(c => c.sessionId === attackerId)
            ?.send('teleport', { x: wx, y: 15.5, z: wz, cx: vwx, cy: 16.5, cz: vwz })
        }
      }

      if (vip.health <= 0 && !this.tryImmortalSaveVip()) this.endGame('haters', 'vip_killed')

      // Handle bodyguard deaths from the shared damage
      for (const [bgSid, bg] of killedBGs) {
        if (!this.tryImmortalSave(bgSid, bg)) {
          bg.isAlive = false; bg.killerId = attackerId
          this.handlePlayerDeath(bgSid, bg, attackerId)
        }
      }
      if (killedBGs.length > 0) this.checkWinByElimination()
      return
    }

    const t = this.state.players.get(info.targetId)
    if (!t || !t.isAlive || t.zone !== 'game' || !t.connected) return

    // ── Damage distribution: primary target + co-located allies ─────────
    // When multiple players of the same team share a tile, incoming damage
    // from an opponent is split equally between all of them. Knockback is
    // suppressed when there are multiple co-located targets.
    const alliesOnTile: [string, PlayerState][] = []
    for (const [sid, p] of this.state.players.entries()) {
      if (p === t) continue
      if (p.team === t.team && p.isAlive && p.zone === 'game' && p.connected &&
          p.tileCol === t.tileCol && p.tileRow === t.tileRow) {
        alliesOnTile.push([sid, p])
      }
    }
    const totalPlayerTargets = 1 + alliesOnTile.length
    const splitDmg = totalPlayerTargets > 1
      ? Math.max(1, Math.floor(baseDmg / totalPlayerTargets))
      : baseDmg

    // Apply split damage to the primary target
    const result = this.applyDamageToPlayer(t, splitDmg, info.src)
    a.lastDealt = result.hpDmg; a.lastDealtTime = Date.now()
    this.clients.find(c => c.sessionId === info.targetId)
      ?.send('hit',       { damage: result.hpDmg, attackerId, shield: result.shieldDmg, blocked: result.fullyBlocked })
    this.clients.find(c => c.sessionId === attackerId)
      ?.send('hit_dealt', { damage: result.hpDmg, targetId: info.targetId })
    this.broadcast('hit_sound', { col: t.tileCol, row: t.tileRow })

    // Apply split damage to co-located allies
    const killedAllies: [string, PlayerState][] = []
    for (const [allySid, ally] of alliesOnTile) {
      const allyResult = this.applyDamageToPlayer(ally, splitDmg, info.src)
      this.clients.find(c => c.sessionId === allySid)
        ?.send('hit', { damage: allyResult.hpDmg, attackerId,
                        shield: allyResult.shieldDmg, blocked: allyResult.fullyBlocked })
      if (ally.health <= 0) killedAllies.push([allySid, ally])
    }

    // Knockback only when the target is alone (no allied cover on the tile)
    if (t.health > 0 && !skipKnockback && alliesOnTile.length === 0 && !result.fullyBlocked) {
      const beforeCol = t.tileCol, beforeRow = t.tileRow
      this.tryKnockback(t, a.tileCol, a.tileRow)
      if (t.tileCol !== beforeCol || t.tileRow !== beforeRow) {
        const wx  = t.tileCol * 2 + 1, wz  = t.tileRow * 2 + 1
        const awx = a.tileCol * 2 + 1, awz = a.tileRow * 2 + 1
        this.clients.find(c => c.sessionId === info.targetId)
          ?.send('teleport', { x: wx, y: 15.5, z: wz, cx: awx, cy: 16.5, cz: awz })
      }
    }

    // Handle primary target death
    if (t.health <= 0 && !this.tryImmortalSave(info.targetId, t)) {
      t.isAlive = false; t.killerId = attackerId
      this.handlePlayerDeath(info.targetId, t, attackerId)
    }
    // Handle ally deaths
    for (const [allySid, ally] of killedAllies) {
      if (!this.tryImmortalSave(allySid, ally)) {
        ally.isAlive = false; ally.killerId = attackerId
        this.handlePlayerDeath(allySid, ally, attackerId)
      }
    }
    this.checkWinByElimination()
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

  // ── Phase 5: bombs (cfg.BOMB_FUSE_MS fuse, 1-tile radius) ───────────────

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
    if (!this.canPickupBetweenTiles(p.tileCol, p.tileRow, bomb.tileCol, bomb.tileRow)) return
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

  // Throw the player's bomb directly onto an enemy's tile (or VIP's tile for
  // haters). The bomb is always armed (countdown starts immediately).
  // Allowed only when the target is Chebyshev ≤ 1 away (same as attack range).
  private handleThrowBomb(sessionId: string, targetId: string) {
    if (this.state.phase !== 'playing') return
    const p = this.state.players.get(sessionId)
    if (!p || p.zone !== 'game' || !p.isAlive) return
    if (p.leftHand !== 'bomb') return

    let targetCol: number
    let targetRow: number

    if (targetId === '__vip__') {
      // Only haters may throw at VIP.
      if (p.team !== 'hater') return
      const vip = this.state.vip
      if (!vip.active) return
      targetCol = vip.tileCol
      targetRow = vip.tileRow
    } else {
      const target = this.state.players.get(targetId)
      if (!target || target.zone !== 'game' || !target.isAlive) return
      // Must be an enemy (different non-neutral team).
      if (p.team === 'none' || target.team === 'none' || target.team === p.team) return
      targetCol = target.tileCol
      targetRow = target.tileRow
    }

    // Chebyshev ≤ 1: same tile or any of the 8 surrounding tiles — mirrors
    // the attack range used throughout the game.
    const cheb = Math.max(
      Math.abs(p.tileCol - targetCol),
      Math.abs(p.tileRow - targetRow)
    )
    if (cheb > 1) return

    // Don't place a second bomb on a tile that already has one.
    for (const b of this.state.bombs.values()) {
      if (b.tileCol === targetCol && b.tileRow === targetRow) return
    }

    // Remove bomb from thrower's hand.
    p.leftHand = 'none'

    const now = Date.now()
    const key  = `${targetCol}_${targetRow}_thrown_${now}`
    const bomb = new BombState()
    bomb.tileCol        = targetCol
    bomb.tileRow        = targetRow
    bomb.ownerId        = sessionId
    bomb.triggerWallIdx = -1               // not a door-trap
    bomb.armed          = true             // countdown starts immediately
    bomb.fuseEndsAt     = now + cfg.BOMB_FUSE_MS

    this.state.bombs.set(key, bomb)

    this.broadcast('bomb_placed', {
      key,
      col:            bomb.tileCol,
      row:            bomb.tileRow,
      fuseEndsAt:     bomb.fuseEndsAt,
      armed:          bomb.armed,
      triggerWallIdx: bomb.triggerWallIdx,
    })
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

  private detonateBomb(key: string, bomb: BombState, isChain = false) {
    this.state.bombs.delete(key)
    // Release the trapped-door exemption so the door can be claimed normally again.
    if (bomb.triggerWallIdx >= 0) this.trappedDoors.delete(bomb.triggerWallIdx)
    if (this.state.phase !== 'playing') return
    this.runBombBlast(bomb.tileCol, bomb.tileRow, bomb.ownerId, isChain)
  }

  // Execute the damage + visual effects of a bomb centred on (bc, br).
  //
  // isChain=false (normal): blast R0–R2, then scans for nearby bombs / held
  //   bombs / floor-bomb items and may trigger chain detonations.
  //   Chain candidates are evaluated AFTER adjacent-wall damage so that walls
  //   destroyed by the blast (HP → 0) are already passable in the obstacle check.
  // isChain=true  (chain):  blast R0–R3, NO further chain trigger.
  //   Adjacent WALL_CONCRETE walls have BOMB_CHAIN_CONCRETE_DESTROY_CHANCE to
  //   be fully destroyed (overriding their indestructible maxHp guard).
  //   Damage at each radius uses the corresponding BOMB_DMG_*_MULT_R* multiplier.
  private runBombBlast(bc: number, br: number, ownerId: string, isChain: boolean) {
    if (this.state.phase !== 'playing') return

    // wt / ws are LIVE references to the schema arrays — modifications to
    // wallTypes / wallStates in later steps are immediately visible here.
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]
    const maxCheb  = isChain ? 3 : 2
    const rollFull = () => randInt(cfg.BOMB_DAMAGE_MIN, cfg.BOMB_DAMAGE_MAX)
    const getDmgMult = (cheb: number): number => {
      if (cheb <= 1) return isChain ? cfg.BOMB_DMG_CHAIN_MULT_R1 : cfg.BOMB_DMG_MULT_R1
      if (cheb === 2) return isChain ? cfg.BOMB_DMG_CHAIN_MULT_R2 : cfg.BOMB_DMG_MULT_R2
      return cfg.BOMB_DMG_CHAIN_MULT_R3  // cheb === 3, chain only
    }
    const applyMult = (n: number, mult: number) => Math.max(1, Math.ceil(n * mult))
    const now = Date.now()

    // Track which walls have been damaged by this explosion to avoid double-
    // damaging the same wall when multiple players shelter behind it.
    const damagedWallSet = new Set<number>()
    const damageWallOnce = (wi: number) => {
      if (wi < 0 || wi >= WALL_COUNT || damagedWallSet.has(wi)) return
      damagedWallSet.add(wi)
      this.damageWall(wi, 'bomb')
    }

    // ── 1. Always damage the 4 cardinal walls adjacent to the bomb tile ───────
    const adjWalls = [
      hWallIndex(br - 1, bc), hWallIndex(br, bc),
      vWallIndex(br, bc - 1), vWallIndex(br, bc),
    ]
    for (const wi of adjWalls) {
      if (wi >= 0 && wi < WALL_COUNT) damageWallOnce(wi)
    }

    // ── 2. Chain-only: WALL_CONCRETE at R1 may be fully destroyed ────────────
    // Concrete is normally indestructible (maxHp=0). A chain explosion is
    // powerful enough to breach it with BOMB_CHAIN_CONCRETE_DESTROY_CHANCE
    // probability per wall. wt/ws are live — destroyed walls become passable
    // for the player-damage obstacle check in step 4.
    if (isChain) {
      for (const wi of adjWalls) {
        if (wi < 0 || wi >= WALL_COUNT) continue
        if (this.state.wallTypes[wi] !== WALL_CONCRETE) continue
        if (Math.random() >= cfg.BOMB_CHAIN_CONCRETE_DESTROY_CHANCE) continue
        this.state.wallTypes[wi]  = WALL_NONE
        this.state.wallStates[wi] = STATE_SOLID
        this.state.wallHP[wi]     = 0
        this.state.wallMaxHP[wi]  = 0
      }
    }

    // ── 3. Collect chain candidates (normal explosions only) ─────────────────
    // Collected AFTER step 1 so that walls destroyed by this blast (HP → 0 in
    // damageWallOnce) are already passable in bombBlastObstacle.
    // Collected BEFORE step 4 so that player knockback (which changes
    // tileCol/tileRow) does not affect which players are candidates.
    //
    // Chain probability rules:
    //   cheb = 0             — same tile, no obstacle: BOMB_CHAIN_R1_CHANCE (100%)
    //   cheb = 1, clear path — BOMB_CHAIN_R1_CHANCE (100%)
    //   cheb = 2, clear path — BOMB_CHAIN_R2_CHANCE (25%)
    //   cheb = 1, blocked by WALL_CONCRETE  — BOMB_CHAIN_BLOCKED_CONCRETE_CHANCE (12.5%)
    //   cheb = 1, blocked by any other wall — BOMB_CHAIN_BLOCKED_OTHER_CHANCE    (25%)
    //   cheb = 2, blocked (any wall)        — 0% (no chain through walls at R2)
    const chainFns: Array<() => void> = []
    if (!isChain) {
      // Returns the chain-trigger probability for a candidate at (col, row).
      // Uses the live wt ref so walls destroyed in step 1 are already passable.
      const getChainChance = (cheb: number, col: number, row: number): number => {
        if (cheb === 0) return cfg.BOMB_CHAIN_R1_CHANCE
        const blockWi = this.bombBlastObstacle(bc, br, col, row, wt, ws)
        if (blockWi >= 0) {
          // Blocked — only R1 gets a (reduced) chance through the wall.
          if (cheb > 1) return 0
          return wt[blockWi] === WALL_CONCRETE
            ? cfg.BOMB_CHAIN_BLOCKED_CONCRETE_CHANCE
            : cfg.BOMB_CHAIN_BLOCKED_OTHER_CHANCE
        }
        // Clear path
        return cheb <= 1 ? cfg.BOMB_CHAIN_R1_CHANCE : cfg.BOMB_CHAIN_R2_CHANCE
      }

      // 3a. Placed / armed BombState entries in state.bombs
      for (const [ck, cb] of this.state.bombs.entries()) {
        const cheb = Math.max(Math.abs(cb.tileCol - bc), Math.abs(cb.tileRow - br))
        if (cheb > 2) continue
        const chance = getChainChance(cheb, cb.tileCol, cb.tileRow)
        if (chance <= 0 || Math.random() >= chance) continue
        const k = ck
        chainFns.push(() => {
          const b2 = this.state.bombs.get(k)
          if (b2) this.detonateBomb(k, b2, true)
        })
      }
      // 3b. Players holding a bomb in their left hand
      for (const [sid, p] of this.state.players.entries()) {
        if (p.leftHand !== 'bomb' || p.zone !== 'game' || !p.isAlive) continue
        const cheb = Math.max(Math.abs(p.tileCol - bc), Math.abs(p.tileRow - br))
        if (cheb > 2) continue
        const chance = getChainChance(cheb, p.tileCol, p.tileRow)
        if (chance <= 0 || Math.random() >= chance) continue
        const s = sid
        chainFns.push(() => {
          const p2 = this.state.players.get(s)
          if (!p2 || p2.leftHand !== 'bomb' || !p2.isAlive) return
          p2.leftHand = 'none'
          this.runBombBlast(p2.tileCol, p2.tileRow, s, true)
        })
      }
      // 3c. Floor bomb items (type='bomb' in state.items — unplaced / dropped)
      for (const [ik, item] of this.state.items.entries()) {
        if (item.type !== 'bomb' || !item.active) continue
        const cheb = Math.max(Math.abs(item.tileCol - bc), Math.abs(item.tileRow - br))
        if (cheb > 2) continue
        const chance = getChainChance(cheb, item.tileCol, item.tileRow)
        if (chance <= 0 || Math.random() >= chance) continue
        const k = ik
        chainFns.push(() => {
          const it = this.state.items.get(k)
          if (!it || !it.active || it.type !== 'bomb') return
          this.state.items.delete(k)
          this.runBombBlast(it.tileCol, it.tileRow, '', true)
        })
      }
    }

    // ── 4. Players in Chebyshev radius ≤ maxCheb ─────────────────────────────
    //
    // Blast rules:
    //   Chebyshev 0          — full damage, no knockback (on bomb tile)
    //   Chebyshev 1          — full dmg × R1 mult + knockback
    //   Chebyshev 2          — dmg × R2 mult, no knockback
    //   Chebyshev 3 (chain)  — dmg × R3 mult, no knockback
    //   All non-zero: if obstacle on path → wall takes damage, player is safe.
    //   Walls destroyed in steps 1–2 are now passable (live wt/ws refs).
    for (const [sid, p] of this.state.players.entries()) {
      if (!p.isAlive || p.zone !== 'game' || !p.connected) continue
      const dx = p.tileCol - bc, dy = p.tileRow - br
      const cheb = Math.max(Math.abs(dx), Math.abs(dy))
      if (cheb > maxCheb) continue

      if (cheb === 0) {
        const dmg = sid === ownerId ? cfg.BOMB_SELF_DAMAGE : rollFull()
        this.applyBombHitToPlayer(sid, p, dmg, ownerId, false, bc, br)
        continue
      }

      const blockWi = this.bombBlastObstacle(bc, br, p.tileCol, p.tileRow, wt, ws)
      if (blockWi >= 0) { damageWallOnce(blockWi); continue }

      const rawDmg  = sid === ownerId ? cfg.BOMB_SELF_DAMAGE : rollFull()
      const baseDmg = applyMult(rawDmg, getDmgMult(cheb))
      this.applyBombHitToPlayer(sid, p, baseDmg, ownerId, cheb === 1, bc, br)
    }

    // ── 5. VIP in Chebyshev radius ≤ maxCheb ─────────────────────────────────
    const vip = this.state.vip
    if (vip.active) {
      const dx = vip.tileCol - bc, dy = vip.tileRow - br
      const cheb = Math.max(Math.abs(dx), Math.abs(dy))
      if (cheb === 0) {
        this.applyBombHitToVip(rollFull(), now)
      } else if (cheb <= maxCheb) {
        const blockWi = this.bombBlastObstacle(bc, br, vip.tileCol, vip.tileRow, wt, ws)
        if (blockWi >= 0) {
          damageWallOnce(blockWi)
        } else {
          this.applyBombHitToVip(applyMult(rollFull(), getDmgMult(cheb)), now)
        }
      }
    }

    // ── 6. Broadcast visual effect + check win ────────────────────────────────
    this.broadcast('bomb_explode', { col: bc, row: br })
    this.checkWinByElimination()

    // ── 7. Execute chain reactions (only while match is still playing) ────────
    if (chainFns.length > 0 && this.state.phase === 'playing') {
      for (const fn of chainFns) fn()
    }
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

    // ── Chebyshev 3 (chain explosions only — 7×7 ring) ──────────────────────
    // Pure cardinal (single route)
    if (adx === 3 && ady === 0) {
      return this.firstSolidOnPath(
        [[bc, br], [bc + sdx, br], [bc + 2 * sdx, br], [tc, tr]], wt, ws)
    }
    if (adx === 0 && ady === 3) {
      return this.firstSolidOnPath(
        [[bc, br], [bc, br + sdy], [bc, br + 2 * sdy], [tc, tr]], wt, ws)
    }
    // (3,1): X-dominant — Route A: X-first; Route B: Y-first
    if (adx === 3 && ady === 1) {
      const pA = this.firstSolidOnPath(
        [[bc, br], [bc + sdx, br], [bc + 2 * sdx, br], [bc + 3 * sdx, br], [tc, tr]], wt, ws)
      const pB = this.firstSolidOnPath(
        [[bc, br], [bc, br + sdy], [bc + sdx, br + sdy], [bc + 2 * sdx, br + sdy], [tc, tr]], wt, ws)
      if (pA < 0 || pB < 0) return -1
      return pA >= 0 ? pA : pB
    }
    // (1,3): Y-dominant
    if (adx === 1 && ady === 3) {
      const pA = this.firstSolidOnPath(
        [[bc, br], [bc, br + sdy], [bc, br + 2 * sdy], [bc, br + 3 * sdy], [tc, tr]], wt, ws)
      const pB = this.firstSolidOnPath(
        [[bc, br], [bc + sdx, br], [bc + sdx, br + sdy], [bc + sdx, br + 2 * sdy], [tc, tr]], wt, ws)
      if (pA < 0 || pB < 0) return -1
      return pA >= 0 ? pA : pB
    }
    // (3,2): X-dominant — Route A: X then Y; Route B: Y then X
    if (adx === 3 && ady === 2) {
      const pA = this.firstSolidOnPath(
        [[bc, br], [bc + sdx, br], [bc + 2 * sdx, br], [bc + 3 * sdx, br], [bc + 3 * sdx, br + sdy], [tc, tr]], wt, ws)
      const pB = this.firstSolidOnPath(
        [[bc, br], [bc, br + sdy], [bc, br + 2 * sdy], [bc + sdx, br + 2 * sdy], [bc + 2 * sdx, br + 2 * sdy], [tc, tr]], wt, ws)
      if (pA < 0 || pB < 0) return -1
      return pA >= 0 ? pA : pB
    }
    // (2,3): Y-dominant
    if (adx === 2 && ady === 3) {
      const pA = this.firstSolidOnPath(
        [[bc, br], [bc, br + sdy], [bc, br + 2 * sdy], [bc, br + 3 * sdy], [bc + sdx, br + 3 * sdy], [tc, tr]], wt, ws)
      const pB = this.firstSolidOnPath(
        [[bc, br], [bc + sdx, br], [bc + 2 * sdx, br], [bc + 2 * sdx, br + sdy], [bc + 2 * sdx, br + 2 * sdy], [tc, tr]], wt, ws)
      if (pA < 0 || pB < 0) return -1
      return pA >= 0 ? pA : pB
    }
    // (3,3): full diagonal — zig-zag routes
    if (adx === 3 && ady === 3) {
      const pA = this.firstSolidOnPath([
        [bc, br], [bc + sdx, br], [bc + sdx, br + sdy], [bc + 2 * sdx, br + sdy],
        [bc + 2 * sdx, br + 2 * sdy], [bc + 3 * sdx, br + 2 * sdy], [tc, tr],
      ], wt, ws)
      const pB = this.firstSolidOnPath([
        [bc, br], [bc, br + sdy], [bc + sdx, br + sdy], [bc + sdx, br + 2 * sdy],
        [bc + 2 * sdx, br + 2 * sdy], [bc + 2 * sdx, br + 3 * sdy], [tc, tr],
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
        const wx  = p.tileCol * 2 + 1, wz  = p.tileRow * 2 + 1
        const bwx = bc        * 2 + 1, bwz = br        * 2 + 1
        this.clients.find(c => c.sessionId === sid)
          ?.send('teleport', { x: wx, y: 15.5, z: wz, cx: bwx, cy: 16.5, cz: bwz })
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
    if (vip.health <= 0 && !this.tryImmortalSaveVip()) {
      // In solo mode (no haters in this match) a bodyguard's stray bomb is
      // the only thing that can kill VIP. Declaring 'haters' as winner when
      // there are none is confusing — end as a draw ("vip_killed") instead.
      const hadHaters = [...this.state.players.values()].some(p => p.team === 'hater')
      this.endGame(hadHaters ? 'haters' : 'draw', 'vip_killed')
    }
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
      x: 16,  y: 2.1, z: 26.5,
      cx: 16, cy: 3.0, cz: 26,
      spectating: true
    })
  }

  private checkWinByElimination() {
    if (this.state.phase !== 'playing') return

    // Collect all players who participated in this match (team assigned).
    const allTeamed = [...this.state.players.values()].filter(p => p.team !== 'none')
    const hadBg = allTeamed.some(p => p.team === 'bodyguard')
    const hadH  = allTeamed.some(p => p.team === 'hater')

    // ── Solo match (only one team present) ─────────────────────────────────
    // End immediately when the solo player dies — the VIP cannot escort
    // herself to safety, and the NPC AI alone will not reliably reach the
    // safe zone before the timer expires.
    // Disconnected-but-alive players (grace period active) still count as
    // alive so the game waits: the solo player might reconnect and continue.
    if (!hadBg || !hadH) {
      const anyAlive = allTeamed.some(p => p.isAlive)
      if (!anyAlive) {
        // All players on the only team are dead → end right now.
        // Solo bodyguard(s) died → VIP has no escort → haters' side wins.
        // Solo hater(s) died    → VIP is safe         → bodyguards' side wins.
        if (hadBg) this.endGame('haters',     'elimination')
        else        this.endGame('bodyguards', 'elimination')
      }
      return
    }

    // ── Normal match (both teams present) ──────────────────────────────────
    // "Still in the fight" = alive (connected or in disconnect-grace period).
    // Dead players (isAlive=false, zone='spectator') are permanently out.
    // processDisconnectGrace() calls this again once a grace-period player
    // actually dies, so disconnected-but-alive players delay the win trigger
    // correctly — we don't end the match while they could still reconnect.
    const bgAlive = allTeamed.some(p => p.team === 'bodyguard' && p.isAlive)
    const hAlive  = allTeamed.some(p => p.team === 'hater'     && p.isAlive)

    if (!bgAlive && hAlive)  this.endGame('haters',     'elimination')
    if (!hAlive  && bgAlive) this.endGame('bodyguards', 'elimination')
  }

  // Diagonal tiles have no wall between them — always passable for attacks.
  // Cardinal tiles use canMoveBetween to check for blocking walls.
  private canAttackTarget(ac: number, ar: number, tc: number, tr: number): boolean {
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]
    const isDiagonal = Math.abs(ac - tc) === 1 && Math.abs(ar - tr) === 1
    if (isDiagonal) {
      // Diagonal corner attacks are allowed in the maze, but only when at least
      // one of the two L-shaped paths around the corner is physically open.
      // This prevents attacks through solid walls separating parallel corridors
      // (both L-paths blocked) while still allowing corner attacks in the same
      // connected area (at least one L-path is clear).
      const dc = tc - ac, dr = tr - ar
      const pathA = canMoveBetween(ac, ar, ac + dc, ar, wt, ws)
                 && canMoveBetween(ac + dc, ar, tc, tr, wt, ws)
      const pathB = canMoveBetween(ac, ar, ac, ar + dr, wt, ws)
                 && canMoveBetween(ac, ar + dr, tc, tr, wt, ws)
      return pathA || pathB
    }
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
        this.doorAutoCloseMs.set(wallIdx, this.DOOR_CLOSE_ALLY_MS)
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
      this.doorAutoCloseMs.delete(wallIdx)
      this.vipCorridorDoors.delete(wallIdx)
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
    // All doors start with a flat 10 s auto-close timer. The escort hold in
    // autoCloseDoors will extend this while BG / VIP are nearby.
    this.doorAutoCloseMs.set(wallIdx, this.DOOR_CLOSE_ALLY_MS)
    // Non-escort bodyguard opens any door while VIP is actively escorted
    // → mark as VIP-corridor door (held open until VIP crosses it).
    // This includes unlocked VIP-room (spawn room) doors so the escort group
    // can exit the spawn room without the door closing before VIP passes.
    const vip = this.state.vip
    if (p.team === 'bodyguard'
        && vip.active
        && vip.followerId !== ''
        && vip.followerId !== sessionId) {
      this.vipCorridorDoors.add(wallIdx)
    }
    // Opening clears any prior claim — door is now openly passable.
    this.doorClaim.delete(wallIdx)
    this.clearDoorClaimSchema(wallIdx)
    // Trigger any bomb trap: same-side openers are safe, opposite-side triggers.
    this.triggerDoorBombsOnOpen(wallIdx, p.tileCol, p.tileRow)
  }

  // Auto-close open doors. Two behaviours:
  //   • Escort door (BG ≤ 1 tile from either side, or VIP ≤ 2 tiles away):
  //     held open. 2 s countdown once both BG ≥ 2 tiles AND VIP > 2 tiles.
  //     Works whether BG opened the door or just passed through it.
  //   • All other doors: flat 10 s (DOOR_CLOSE_ALLY_MS) from the moment opened.
  // Before closing, a safety check ensures no player on an adjacent tile would
  // be left without an exit; if they would, the close is deferred by 1 s.
  private autoCloseDoors(dt: number) {
    // Purge stale entries for non-open doors (manually closed, destroyed, etc.)
    for (const [wallIdx] of [...this.doorAutoCloseMs.entries()]) {
      if (this.state.wallStates[wallIdx] !== STATE_OPEN) {
        this.doorAutoCloseMs.delete(wallIdx)
        this.doorOpener.delete(wallIdx)
      }
    }
    // Clean up expired grace entries.
    const now = Date.now()
    for (const [wallIdx, expiresAt] of [...this.doorAutoCloseGrace.entries()]) {
      if (now >= expiresAt) this.doorAutoCloseGrace.delete(wallIdx)
    }

    for (let wallIdx = 0; wallIdx < this.state.wallTypes.length; wallIdx++) {
      if (this.state.wallTypes[wallIdx] !== WALL_WOOD_DOOR) continue
      if (this.state.wallStates[wallIdx] !== STATE_OPEN) continue

      const sides = this.wallSidesTiles(wallIdx)

      // ── VIP corridor hold ─────────────────────────────────────────────────
      // Door was opened by a non-escort BG specifically for VIP's path.
      // Hold it open (pin timer) until VIP crosses through it — detected in
      // the escort/flee movement functions which call vipCorridorDoors.delete.
      if (this.vipCorridorDoors.has(wallIdx)) {
        this.doorAutoCloseMs.set(wallIdx, this.DOOR_CLOSE_ALLY_MS)
        continue
      }

      // ── Escort hold (all non-corridor doors, including VIP spawn room) ──────
      // Any open door is "escort-tracked" while the active escort BG is ≤ 1
      // tile from either side, OR VIP herself is ≤ 2 tiles away (she may
      // still be approaching and needs the door open to follow through).
      //
      // Two cases are covered:
      //  A) BG OPENED this door — doorOpener already equals vipFollowerId.
      //  B) BG PASSED THROUGH an already-open door — doorOpener points to
      //     whoever opened it earlier; we take ownership here so the 2 s
      //     countdown starts correctly once BG clears.
      //
      // NOTE: VIP-room (spawn room) doors are intentionally included here.
      // Previously they were excluded via !isUnlockedVipDoor, which caused
      // them to always close after 10 s regardless of the escort's position.
      //
      // Close rule (matches the spec "close when BG moves 2 tiles away"):
      //   sides.a / sides.b are the tiles ADJACENT to the door wall.
      //   dist = 0  → BG is on the adjacent tile (right at the door).
      //   dist = 1  → BG is 1 tile past the door.
      //   dist = 2  → BG is 2 tiles from the door  ← start 2 s countdown.
      const vipFollowerId = this.state.vip.followerId
      if (vipFollowerId && this.state.vip.active) {
        const bg = this.state.players.get(vipFollowerId)
        if (bg && bg.isAlive && bg.zone === 'game') {
          const distA  = Math.abs(bg.tileCol - sides.a.col) + Math.abs(bg.tileRow - sides.a.row)
          const distB  = Math.abs(bg.tileCol - sides.b.col) + Math.abs(bg.tileRow - sides.b.row)
          const bgDist = Math.min(distA, distB)

          const vipS    = this.state.vip
          const vipDistA = Math.abs(vipS.tileCol - sides.a.col) + Math.abs(vipS.tileRow - sides.a.row)
          const vipDistB = Math.abs(vipS.tileCol - sides.b.col) + Math.abs(vipS.tileRow - sides.b.row)
          const vipDist  = Math.min(vipDistA, vipDistB)

          if (bgDist <= 1 || vipDist <= 2) {
            // BG is right at the door (≤ 1 tile) or VIP is nearby (≤ 2 tiles).
            // Take ownership so the 2 s countdown applies when both clear
            // (handles case B — BG walked through an already-open door).
            this.doorOpener.set(wallIdx, vipFollowerId)
            this.doorAutoCloseMs.set(wallIdx, this.DOOR_CLOSE_ALLY_MS)
            continue
          }

          // BG has cleared (≥ 2 tiles from door) and VIP has also cleared.
          // If we own this door (opened by BG or taken over above), apply the
          // short 2 s countdown instead of the standard 10 s.
          if (this.doorOpener.get(wallIdx) === vipFollowerId) {
            const capVal = this.doorAutoCloseMs.get(wallIdx)
            if (capVal === undefined || capVal > 2_000) {
              this.doorAutoCloseMs.set(wallIdx, 2_000)
            }
            // fall through to the standard countdown below (will use the 2 s value)
          }
        }
      }

      // ── Standard countdown for all other cases ───────────────────────────
      // Non-escort doors: DOOR_CLOSE_ALLY_MS (10 s) flat timer.
      // Escort doors after BG clears: already capped to 2 s above.
      const prev      = this.doorAutoCloseMs.get(wallIdx)
      const remaining = prev === undefined ? this.DOOR_CLOSE_ALLY_MS : prev - dt

      if (remaining <= 0) {
        // Safety: only close if every player on an adjacent tile still has at
        // least one exit other than this door (prevents stranding).
        if (this.canSafelyCloseDoor(wallIdx)) {
          this.closeDoorAuto(wallIdx)
        } else {
          // Player would be left with no exit — give them 1 s to step away.
          this.doorAutoCloseMs.set(wallIdx, 1_000)
        }
      } else {
        this.doorAutoCloseMs.set(wallIdx, remaining)
      }
    }
  }

  // Close a door through the auto-close system (as opposed to a manual click).
  private closeDoorAuto(wallIdx: number) {
    this.state.wallStates[wallIdx] = STATE_SOLID
    this.doorOpener.delete(wallIdx)
    this.doorAutoCloseMs.delete(wallIdx)
    // Grace period: prevent immediate re-claiming by a player already standing
    // adjacent. Without this, a bodyguard next to the door would re-block it
    // (SOLID→BLOCKED) on their very next player_tile tick, making it look as
    // if the door never opened for the opposite team.
    this.doorAutoCloseGrace.set(wallIdx, Date.now() + this.DOOR_CLAIM_GRACE_MS)
    // Still-locked VIP-room doors regain bodyguard ownership so haters
    // continue to see red feedback when they click them.
    const stillLocked = (this.mazeConfig?.vipRoomDoors.includes(wallIdx) ?? false)
                     && !this.unlockedVipRoomDoors.has(wallIdx)
    if (stillLocked) {
      this.state.wallClaimTeams[wallIdx] = 1
      this.state.wallClaimAck[wallIdx]   = 0
    }
  }

  // True if closing wallIdx would NOT strand any alive in-game player on its
  // adjacent tiles. Each such player must have at least one passable exit that
  // does NOT go through the door being closed.
  private canSafelyCloseDoor(wallIdx: number): boolean {
    const { a, b } = this.wallSidesTiles(wallIdx)
    // Simulate the door as closed so canMoveBetween gives correct results.
    const wt = [...this.state.wallTypes]
    const ws = [...this.state.wallStates]
    ws[wallIdx] = STATE_SOLID
    const dirs: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]]

    for (const side of [a, b]) {
      for (const p of this.aliveGamePlayersOnTile(side.col, side.row)) {
        let hasExit = false
        for (const [dc, dr] of dirs) {
          const nc = p.tileCol + dc, nr = p.tileRow + dr
          if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue
          // Skip the direction that passes through the door we're closing.
          if (this.moveCrossesDoor(p.tileCol, p.tileRow, nc, nr, wallIdx)) continue
          if (canMoveBetween(p.tileCol, p.tileRow, nc, nr, wt, ws)) {
            hasExit = true; break
          }
        }
        if (!hasExit) return false
      }
    }
    return true
  }

  // True if the step from (fc,fr)→(tc,tr) crosses the specific wall wallIdx.
  private moveCrossesDoor(fc: number, fr: number, tc: number, tr: number, wallIdx: number): boolean {
    const { a, b } = this.wallSidesTiles(wallIdx)
    return (fc === a.col && fr === a.row && tc === b.col && tr === b.row)
        || (fc === b.col && fr === b.row && tc === a.col && tr === a.row)
  }

  // All alive in-game players on a specific tile.
  private aliveGamePlayersOnTile(col: number, row: number): PlayerState[] {
    const out: PlayerState[] = []
    for (const p of this.state.players.values()) {
      if (p.zone === 'game' && p.isAlive && p.tileCol === col && p.tileRow === row) out.push(p)
    }
    return out
  }

  // All alive in-game players on any of the given tiles.
  private aliveGamePlayersOnTiles(tiles: Array<{ col: number; row: number }>): PlayerState[] {
    const out: PlayerState[] = []
    for (const p of this.state.players.values()) {
      if (p.zone !== 'game' || !p.isAlive) continue
      for (const t of tiles) {
        if (p.tileCol === t.col && p.tileRow === t.row) { out.push(p); break }
      }
    }
    return out
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
      // Use tileHasItem (scans by tileCol/tileRow) rather than items.has(key).
      // Death-drops and hand-drops use compound keys like "{col}_{row}_death_…"
      // so items.has("{col}_{row}") would miss them and allow two items to land
      // on the same tile.
      if (!this.tileHasItem(t.col, t.row) && !this.isTileOccupied(t.col, t.row)) {
        const item = new ItemState()
        item.tileCol = t.col; item.tileRow = t.row; item.type = type; item.active = true
        this.state.items.set(`${t.col}_${t.row}`, item)
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

  /**
   * Returns true if a player at (pCol, pRow) may pick up an item at (iCol, iRow).
   * Rules:
   *   • Same tile              → always allowed.
   *   • Cardinal neighbour     → allowed when the wall slot between them is
   *     either empty (WALL_NONE) or fully destroyed (STATE_DESTROYED).
   *     An OPEN door still blocks pickup — the door frame physically separates
   *     the tiles even when slid down; "open" is a game-mechanic state, not
   *     the absence of the wall structure.
   *   • Any other distance     → not allowed.
   */
  private canPickupBetweenTiles(pCol: number, pRow: number, iCol: number, iRow: number): boolean {
    if (pCol === iCol && pRow === iRow) return true
    if (Math.abs(pCol - iCol) + Math.abs(pRow - iRow) !== 1) return false
    const wallIdx = wallIdxBetween({ col: pCol, row: pRow }, { col: iCol, row: iRow })
    if (wallIdx < 0) return true
    const wt = this.state.wallTypes  as unknown as number[]
    const ws = this.state.wallStates as unknown as number[]
    // WALL_NONE = no wall ever placed here → free.
    // STATE_DESTROYED = wall was there but is now rubble → free passage.
    // STATE_OPEN door = door exists but slid down; still blocks pickup.
    return wt[wallIdx] === WALL_NONE || ws[wallIdx] === STATE_DESTROYED
  }

  private handlePickup(sessionId: string, key: string) {
    const item = this.state.items.get(key)
    const p = this.state.players.get(sessionId)
    if (!item || !item.active || !p || p.zone !== 'game' || !p.isAlive) return
    if (!this.canPickupBetweenTiles(p.tileCol, p.tileRow, item.tileCol, item.tileRow)) return

    if (item.type === 'baton') {
      // Drop currently held baton (if any), then take the new one.
      // Same-tile pickup: the item being picked up occupies this tile and will
      // be deleted below, so the player's tile stays at ≤1 item — drop here.
      // Adjacent-tile pickup: the player's tile may ALREADY have another item,
      // so find the nearest free tile instead of blindly dropping at p.tileCol/row.
      if (p.rightHand === 'baton') {
        const sameTile = (p.tileCol === item.tileCol && p.tileRow === item.tileRow)
        const dropTile = sameTile
          ? { col: p.tileCol, row: p.tileRow }
          : (this.findItemDropTileExcluding(p.tileCol, p.tileRow, new Set()) ?? { col: p.tileCol, row: p.tileRow })
        const dropKey = `${dropTile.col}_${dropTile.row}_drop_${Date.now()}`
        const drop = new ItemState()
        drop.tileCol = dropTile.col; drop.tileRow = dropTile.row; drop.type = 'baton'; drop.active = true
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
    } else {
      // No free adjacent tile — item is silently lost. Intentional edge case:
      // if every reachable tile is already occupied there is nowhere to place
      // the item. Extremely rare in normal play.
      console.warn(`[GameRoom] dropLeftHandIfNeeded: no free tile near (${p.tileCol},${p.tileRow}) — "${droppedType}" lost`)
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
    if (cfg.ALLOW_ALL_TILE_OVERLAP) return false

    // Main direction: from VIP toward hater — this is the direction "where the
    // hater came from". Pushing the hater further in this direction (dot > 0)
    // is the primary goal: hater ends up 2+ tiles from VIP and is no longer
    // adjacent next tick, preventing the bounce-back cycle that lateral pushes
    // caused (lateral push left hater at Chebyshev=1 from VIP's new tile).
    const mainDc = Math.sign(target.tileCol - awayFromCol)
    const mainDr = Math.sign(target.tileRow - awayFromRow)

    type Cand = { col: number; row: number }
    const away: Cand[]    = []   // same direction as main (where hater came from)
    const lateral: Cand[] = []   // perpendicular
    const reverse: Cand[] = []   // last resort — back toward VIP

    // ── Cardinal neighbours ──────────────────────────────────────────────
    const dirs4: Array<[number,number]> = [[0,1],[0,-1],[1,0],[-1,0]]
    for (const [dc, dr] of dirs4) {
      const nc = target.tileCol + dc, nr = target.tileRow + dr
      if (!this.tileInBounds(nc, nr)) continue
      if (!canMoveBetween(target.tileCol, target.tileRow, nc, nr, wt, ws)) continue
      if (this.isTileOccupied(nc, nr)) continue
      const dot = dc * mainDc + dr * mainDr
      if      (dot > 0) away.push({ col: nc, row: nr })
      else if (dot === 0) lateral.push({ col: nc, row: nr })
      else    reverse.push({ col: nc, row: nr })
    }

    // Diagonal push removed: avatar movement on the client interpolates diagonally
    // through wall corners even when an L-path exists, looking like the hater
    // passes through an obstacle. Cardinal-only push is visually clean.

    // Priority: where hater came from → lateral → reverse
    const pool = away.length    > 0 ? away    :
                 lateral.length > 0 ? lateral :
                 reverse
    if (pool.length === 0) return false

    const picked  = pool[Math.floor(Math.random() * pool.length)]
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
                isAlive: boolean; inQueue: boolean } | null
    wasReconnect: boolean
  } {
    let restored: {
      tileCol: number; tileRow: number; team: string; zone: string;
      health: number; maxHealth: number;
      rightHand: string; leftHand: string; shieldHP: number; shieldMaxHP: number;
      isAlive: boolean; inQueue: boolean
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
          isAlive:     other.isAlive,
          inQueue:     false
        }
      } else if (this.state.phase === 'countdown' && other.inQueue) {
        // Player disconnected during countdown while queued — re-queue them.
        restored = {
          tileCol: 0, tileRow: 0, team: 'none', zone: 'lobby',
          health: 100, maxHealth: 100,
          rightHand: 'none', leftHand: 'none', shieldHP: 0, shieldMaxHP: 0,
          isAlive: true, inQueue: true
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
          isAlive: snap.isAlive, inQueue: false
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
