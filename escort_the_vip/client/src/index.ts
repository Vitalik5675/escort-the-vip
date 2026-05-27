// IMPORTANT: polyfills must be first — before any @colyseus/sdk import
import './polyfills'

import { engine, Entity, Transform, AvatarShape, InputModifier, AvatarLocomotionSettings, VirtualCamera, MainCamera, MaterialTransparencyMode, TextureWrapMode, PlayerIdentityData } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4, Color3 } from '@dcl/sdk/math'
import { getPlayer, onEnterScene, onLeaveScene } from '@dcl/sdk/players'
import { movePlayerTo } from '~system/RestrictedActions'

import { connectToServer, disconnectFromServer, checkAndReconnect, getRoom, setRoomCallbacks, getLastPingMs, setLocalIdentity, setPlayerInScene, isLocalPlayer } from './colyseus-client'
import { getLocalState, patchLocalState, setSpectateSwitchCallback, PlayerEntry } from './state/localState'
import { createEntity } from './utils/entityFactory'
import { initSounds, playSound, loopSound, stopSound, setAudioZone } from './audio/soundManager'
import { initVipAudio } from './audio/vipAudio'
import { buildLobby }         from './zones/lobby'
import { buildSpectatorZone, updateButtonState, updateHistoryBoard } from './zones/spectatorZone'
import { buildGameZone, applySceneConfig }          from './zones/gameZone'
import { setupZoneTriggers, isInsideGameZone }  from './zones/zoneTriggers'
import { buildMaze, createGameFloor, syncWall, syncItems, setMazeVisible, setSafetyTiles, syncWallHP, clearWallHPOverlays, spawnBombOverlay, removeBombOverlay, tickBombOverlays, clearAllBombOverlays, refreshJunctionsAroundWall, refreshDoorMaterials, flashVipDoorCross, syncStripeColor, refreshWallEKeyLabels, spawnExplosionEffect, anyAllyInSafetyZone } from './game/maze'
import { wallSidesTiles, WALL_HEDGE } from './game/constants'
import { setHeldItem, clearPlayerHands, clearAllHands, HandItem } from './game/attachedItems'
import { setupCombatInput } from './game/combatInput'
import { upsertVip, setVipVisible, getVipEntity, updateVipClickable, setVipFacingYaw }  from './game/npcRenderer'
import { upsertHealthBar, removeHealthBar, showHealthBar } from './game/healthBar'
import { upsertEnemyHitbox, removeEnemyHitbox, syncEnemyHitboxTeams, syncAllEnemyHitboxesForOverlap } from './game/playerHitboxes'
import { triggerHitFlash }    from './game/screenEffects'
import { notifyVipHit, updateVipLight, updateEndGameLight, countNearbyHaters, getStripeColor, resetAllLightEffects, updateSafetyBeacon } from './game/lightEffects'
import { setupAllUI }         from './ui'
import { GAME_FLOOR_Y, tileToWorldX, tileToWorldZ, worldToTileCol, worldToTileRow } from './game/constants'

// ── Config ────────────────────────────────────────────────────────────────────

const SERVER_URL = 'wss://YOUR-SUBDOMAIN.duckdns.org'

const DISCONNECTED_TIMEOUT_MS = 8_000   // teleport to lobby after 8s offline

// ── Damage HUD ────────────────────────────────────────────────────────────────
// Per-session damage accumulators driven by Colyseus state diffs (NOT by the
// local 'hit' / 'hit_dealt' messages) so spectators see the same numbers for
// the player they're watching as that player sees first-hand. Hits arriving
// within DAMAGE_WINDOW_MS sum into a single value — matches server
// ATTACK_RESOLVE_DELAY_MS so a same-tick counter-attack is reported once.
const DAMAGE_WINDOW_MS  = 700     // accumulation window (hits within this sum)
const DAMAGE_VISIBLE_MS = 3_000   // total visible time after last hit (incl. fade)

interface DmgBucket { amount: number; untilMs: number; shownMs: number }
interface SessionDmg { dealt: DmgBucket; recv: DmgBucket }

const _dmgBySession = new Map<string, SessionDmg>()
const _emptyBucket = (): DmgBucket => ({ amount: 0, untilMs: 0, shownMs: 0 })
function _bucketFor(sid: string): SessionDmg {
  let s = _dmgBySession.get(sid)
  if (!s) { s = { dealt: _emptyBucket(), recv: _emptyBucket() }; _dmgBySession.set(sid, s) }
  return s
}

function _accumulate(b: DmgBucket, amount: number, now: number): void {
  const within = now < b.untilMs
  b.amount  = within ? b.amount + amount : amount
  b.untilMs = now + DAMAGE_WINDOW_MS
  b.shownMs = now + DAMAGE_VISIBLE_MS
}

/** sessionId currently displayed in the bottom-centre damage HUD. */
function _currentWatchedSession(): string {
  const s = getLocalState()
  if (s.isSpectating) {
    const sid = s.spectatedIds[s.spectateIndex]
    if (sid && sid !== '__vip__') return sid
    return ''
  }
  return s.mySessionId
}

/** Push the watched session's buckets into localState so ui.tsx can render them. */
function _publishWatchedDmg(): void {
  const sid = _currentWatchedSession()
  const b   = sid ? _dmgBySession.get(sid) : undefined
  patchLocalState({
    dmgDealtAmount:  b?.dealt.amount  ?? 0,
    dmgDealtUntilMs: b?.dealt.untilMs ?? 0,
    dmgDealtShownMs: b?.dealt.shownMs ?? 0,
    dmgRecvAmount:   b?.recv.amount   ?? 0,
    dmgRecvUntilMs:  b?.recv.untilMs  ?? 0,
    dmgRecvShownMs:  b?.recv.shownMs  ?? 0,
  })
}

// (Звуки управляються через src/audio/soundManager.ts)

// ── Tracking ─────────────────────────────────────────────────────────────────

let posTimer = 0       // tile position report interval (seconds)
let healthTimer = 0    // connection health-check interval (seconds)
let playerListRefreshTimer = 0  // refresh death countdown / ping every second

// VirtualCamera spectator state
const LERP_SPEED = 8
const CAM_BACK   = 3.0
const CAM_PITCH  = 25
let _camSnapNeeded      = true
let _lastSpectateTarget = ''
let _lastHiddenBarId    = ''
let _smoothCamX = 0, _smoothCamZ = 0
let _camHeadX = 0, _camHeadZ = 1
let _tgtHeadX = 0, _tgtHeadZ = 1
let _prevTargetX = 0, _prevTargetZ = 0
let knownWallTypes:  number[] = new Array(480).fill(0)
let knownWallStates: number[] = new Array(480).fill(0)
let knownWallHP:     number[] = new Array(480).fill(0)
let knownWallMaxHP:  number[] = new Array(480).fill(0)
// Last-seen lastDamageTime / lastDealtTime per session and for the VIP.
// Used to trigger one-shot HUD damage accumulators per server-confirmed event
// (state diff — fires for every client, so spectators see the same numbers).
const _prevPlayerHitTime   = new Map<string, number>()
const _prevPlayerDealtTime = new Map<string, number>()
let _prevVipHitTime = 0
// Per-item signature cache (key → "col|row|type|active") for the
// item-map diff fallback in onStateChange.
let knownItemKeys: Map<string, string> = new Map()
// Per-bomb signature cache (key → "col|row|fuseEndsAt|armed") for the same
// MapSchema-callback fallback used for items / walls.
let knownBombSigs: Map<string, string> = new Map()

// ── Spectator avatar lookup ───────────────────────────────────────────────────
// In DCL SDK 7 every connected player is an ECS entity with AvatarShape.
// Matching by display name lets us read their real-time Transform each frame.

function findPlayerAvatarEntity(displayName: string): Entity | null {
  if (!displayName) return null
  for (const [entity, shape] of engine.getEntitiesWith(AvatarShape)) {
    if (shape.name === displayName) return entity
  }
  return null
}

// ── Тест: предмети у лобі ─────────────────────────────────────────────────────
// Guard запобігає дублюванню якщо main() викличеться повторно (hot-reload тощо).
// Структура кожного предмета:
//   parent       — Transform (позиція/поворот/масштаб)
//   color front  — площина кольору, Z = 0
//   color back   — площина кольору, Z = 0, повернута 180°Y
//   tex front    — зображення з альфа-змішуванням, Z = +0.003 (перед кольором)
//   tex back     — зображення з альфа-змішуванням, Z = -0.003 (позаду з боку глядача)
// ── Main ──────────────────────────────────────────────────────────────────────

export function main() {
  // ── Build world ────────────────────────────────────────────────────────────
  buildLobby()
  buildSpectatorZone()
  buildGameZone()
  createGameFloor()

  // ── Sound manager — pre-allocate all sound entities once ──────────────────
  initSounds()

  // ── VIP ambient audio — timer-driven reactive sounds ──────────────────────
  initVipAudio()

  // ── Zone triggers (TriggerArea for lobby / spectator / game zone) ───────────
  setupZoneTriggers()

  // ── UI renderer ─────────────────────────────────────────────────────────────
  setupAllUI()

  // ── Combat input (E / F keyboard polling) ───────────────────────────────────
  setupCombatInput()

  // ── Bomb-countdown overlay refresher ───────────────────────────────────────
  engine.addSystem(() => { tickBombOverlays(Date.now()) })

  // ── Audio zone tracking ──────────────────────────────────────────────────
  // Runs every frame, fires only on zone change (cheap string comparison).
  //
  // Responsibilities:
  //   1. setAudioZone(zone) → soundManager filters 'lobby'-tagged sounds
  //      (button_click, lobby_ambient) for non-lobby players automatically.
  //   2. lobby_ambient loop:
  //      - zone → 'lobby'     : start loop (loopSound respects zone filter → OK)
  //      - zone → other       : stopSound to silence the running loop
  //
  // Zone rules summary:
  //   lobby     → all sounds (game sounds + lobby sounds)
  //   spectator → game sounds only (lobby sounds filtered by soundManager)
  //   game      → game sounds only (lobby sounds filtered by soundManager)
  let _audioZone = ''
  engine.addSystem(() => {
    const zone = getLocalState().zone
    if (zone === _audioZone) return
    const leaving = _audioZone
    _audioZone = zone
    setAudioZone(zone)

    // lobby_ambient is disabled
  })

  // ── Player lifecycle ────────────────────────────────────────────────────────
  //
  // onEnterScene / onLeaveScene fire for ALL players in the scene, not just
  // the local one. We use isLocalPlayer() to filter — it compares against the
  // cached identity (set just before connectToServer) and falls back to
  // getPlayer() for the very first call before identity is cached.

  onLeaveScene((userId) => {
    if (!isLocalPlayer(userId)) return   // another player left — ignore
    console.log('[Scene] Local player left scene — disconnecting')
    setPlayerInScene(false)
    void disconnectFromServer()
  })

  // onEnterScene fires on first scene load and on every re-entry after the
  // player walked out and back in. We set identity + mark player as in-scene
  // BEFORE calling connectToServer so the connection module has everything it
  // needs synchronously in the first _doConnect call.
  //
  // Mobile fix: getPlayer() may return null during onEnterScene on mobile
  // because its data source is loaded asynchronously by the DCL kernel.
  // PlayerIdentityData on engine.PlayerEntity is populated synchronously by
  // the ECS runtime before main() runs — use it as the primary source.
  onEnterScene((player) => {
    // ECS source: address field populated before main() — reliable on mobile
    // (PBPlayerIdentityData uses 'address' = ethereum addr, same as userId for non-guests)
    const ecsAddr = PlayerIdentityData.getOrNull(engine.PlayerEntity)?.address
    // Kernel source: may be null on first call on mobile
    const liveId  = getPlayer()?.userId
    // Best available local player ID (address matches userId for non-guests)
    const localId = (ecsAddr && ecsAddr.length > 0 ? ecsAddr : null) || liveId

    if (localId && localId.toLowerCase() !== player.userId.toLowerCase()) return  // confirmed: not the local player
    // localId null = neither ECS nor kernel ready yet (mobile race condition).
    // Safe to proceed: on scene load the local player always fires first.

    console.log(`[Scene] Local player entered: ${player.name} (${player.userId}) [ecs=${ecsAddr ?? 'null'} live=${liveId ?? 'null'}]`)
    setLocalIdentity(player.userId, player.name ?? '')
    setPlayerInScene(true)
    connectToServer(SERVER_URL)
  })

  // ── ECS systems ─────────────────────────────────────────────────────────────
  engine.addSystem((dt: number) => {
    healthTimer += dt
    if (healthTimer >= 5) { healthTimer = 0; checkAndReconnect() }

    posTimer += dt
    if (posTimer >= 0.5) { posTimer = 0; reportTilePosition() }

    // Refresh death countdown for disconnected players + local ping every second.
    playerListRefreshTimer += dt
    if (playerListRefreshTimer >= 1) {
      playerListRefreshTimer = 0
      const r = getRoom()
      if (r) rebuildPlayerList(r)
      patchLocalState({ myPing: getLastPingMs() })
    }

    checkDisconnectTimeout(dt)
  })

  // ── World light effects (VIP halo + end-game pulse) ───────────────────────
  // Cheap per-frame tick. VIP halo state is derived from server snapshot
  // (vip tile + nearby hater count); end-game pulse keys on phase+timer.
  engine.addSystem(() => {
    const r = getRoom()
    const ls = getLocalState()
    if (!r || !r.state) {
      updateVipLight({ active: false, col: 0, row: 0, hpFrac: 0, haterTilesNearby: 0 })
      syncStripeColor(null)
      updateEndGameLight(0, 'lobby')
      return
    }
    const vip = r.state.vip
    if (vip?.active) {
      const players = r.state.players ? [...r.state.players.values()] : []
      // Beacon: HP-colour (cylinder shows VIP health state)
      const hatersNear2 = countNearbyHaters(vip.tileCol, vip.tileRow, players as any, 2)
      const hpFrac = (vip.maxHealth ?? 0) > 0 ? (vip.health ?? 0) / vip.maxHealth : 0
      updateVipLight({
        active:           true,
        col:              vip.tileCol,
        row:              vip.tileRow,
        hpFrac,
        haterTilesNearby: hatersNear2
      })
      // Stripes: proximity-alert colour (white→yellow→orange→red)
      const hatersFar4 = countNearbyHaters(vip.tileCol, vip.tileRow, players as any, 4)
      syncStripeColor(getStripeColor(true, hatersNear2, hatersFar4))
    } else {
      updateVipLight({ active: false, col: 0, row: 0, hpFrac: 0, haterTilesNearby: 0 })
      syncStripeColor(null)
    }
    updateEndGameLight(ls.timeRemaining ?? 0, ls.phase ?? 'lobby')

    // Safety-zone beacon: green column visible per per-player rules (2-min all,
    // ally-on-tile team-wide, 3-min VIP-follower). Needs the full player list
    // for the ally-presence check, which we already have above when VIP exists;
    // re-fetch it cheaply when VIP is inactive so the beacon still works during
    // countdown/edge cases.
    const playersForBeacon = r.state.players ? [...r.state.players.values()] : []
    updateSafetyBeacon({
      phase:          ls.phase ?? 'lobby',
      timeRemaining:  ls.timeRemaining ?? 0,
      myTeam:         ls.myTeam,
      mySessionId:    ls.mySessionId,
      vipFollowerId:  ls.vipFollowerId,
      alliesInSafety: anyAllyInSafetyZone(ls.myTeam, playersForBeacon as any),
    })

    // Keep the bottom-centre damage HUD pointing at whoever we're currently
    // watching, including when the spectator presses Next/Prev between hits.
    _publishWatchedDmg()
  })

  // ── InputModifier: spectator-lock + jump-disable in game zone ──────────────
  // Only one InputModifier can be active per entity, so combine both rules into
  // a single state machine:
  //   • isSpectating              → disableAll (lock everything in spectator cage)
  //   • zone='game' & playing     → disableJump (no hopping over walls)
  //   • zone='game' & ended       → disableAll (frozen for results screen)
  //   • otherwise                 → no modifier
  type ModState = 'none' | 'spectator' | 'gameJump' | 'gameFrozen'
  let modState: ModState = 'none'
  engine.addSystem(() => {
    const s = getLocalState()
    let desired: ModState = 'none'
    if (s.isSpectating)                                             desired = 'spectator'
    else if (s.zone === 'game' && s.phase === 'ended')              desired = 'gameFrozen'
    else if (s.zone === 'game' && s.phase === 'playing')            desired = 'gameJump'

    if (desired === modState) return

    if (desired === 'spectator' || desired === 'gameFrozen') {
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: true })
      })
    } else if (desired === 'gameJump') {
      // Block all vertical motion forms — disableJump alone leaves double-jump
      // and gliding available, which still let players hop over walls.
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({
          disableJump:       true,
          disableDoubleJump: true,
          disableGliding:    true
        })
      })
    } else {
      InputModifier.deleteFrom(engine.PlayerEntity)
    }
    modState = desired
  })

  // ── Maze + VIP visibility driven by match phase ────────────────────────────
  // Walls and VIP appear during countdown (when the match-specific maze is
  // generated server-side) and stay visible through 'playing'. On 'lobby' or
  // 'ended' the arena is visually empty — the platform itself stays visible
  // because gameZone perimeter+platform are never hidden.
  let mazeShown = false
  engine.addSystem(() => {
    const s = getLocalState()
    const shouldShow = s.phase === 'countdown' || s.phase === 'playing' || s.phase === 'ended'
    if (shouldShow !== mazeShown) {
      setMazeVisible(shouldShow)
      setVipVisible(shouldShow)
      mazeShown = shouldShow
    }
  })

  // ── Lobby evict: don't let players linger in the game zone when no match ───
  // `isInsideGameZone()` reads the engine's `TriggerAreaResult` component
  // directly — the authoritative state of "is PlayerEntity inside this trigger
  // area" — which doesn't suffer from the Stay/Exit ordering races a derived
  // flag does. After ~1 s of being inside with no match active (and not
  // spectating), bounce the player back to the lobby spawn.
  let _evictAccum = 0
  engine.addSystem((dt: number) => {
    const s = getLocalState()
    const matchActive = s.phase === 'countdown' || s.phase === 'playing' || s.phase === 'ended'
    if (matchActive || s.isSpectating || !isInsideGameZone()) {
      _evictAccum = 0
      return
    }
    _evictAccum += dt
    if (_evictAccum < 1.0) return
    _evictAccum = 0
    movePlayerTo({ newRelativePosition: Vector3.create(8, 1.1, 4) })
    patchLocalState({ zone: 'lobby' })
    console.log('[Lobby] Evicted from game zone (no match running)')
  })

  // ── AvatarLocomotionSettings: slow movement in game zone during play ─────────
  const GAME_WALK_SPEED   = 2   // m/s — restrict to walk pace, no jogging/running
  const DEFEND_WALK_SPEED = 1   // m/s — half-speed while in defending stance (F)
  let locomotionAppliedSpeed: number | null = null
  engine.addSystem(() => {
    const s = getLocalState()
    const inGamePlay = s.zone === 'game' && s.phase === 'playing'
    if (!inGamePlay) {
      if (locomotionAppliedSpeed !== null) {
        AvatarLocomotionSettings.deleteFrom(engine.PlayerEntity)
        locomotionAppliedSpeed = null
      }
      return
    }
    const target = s.myDefending ? DEFEND_WALK_SPEED : GAME_WALK_SPEED
    if (locomotionAppliedSpeed !== target) {
      AvatarLocomotionSettings.createOrReplace(engine.PlayerEntity, {
        walkSpeed: target,
        jogSpeed:  target,
        runSpeed:  target,
      })
      locomotionAppliedSpeed = target
    }
  })

  // ── VirtualCamera spectator: avatar stays in spectator zone, camera tracks target ─
  // VirtualCamera.Transition.Time(0) = instant snap, no cinematic glide on activation.
  // After activation, Transform updates each frame give direct per-frame tracking.
  const specCamEntity = engine.addEntity()
  Transform.create(specCamEntity, { position: Vector3.create(16, GAME_FLOOR_Y + 1.6, 16) })
  VirtualCamera.create(specCamEntity, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0) }
  })

  let vcamActive = false
  engine.addSystem((dt: number) => {
    const s = getLocalState()

    if (!s.isSpectating) {
      if (vcamActive) {
        MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = undefined
        vcamActive = false
      }
      if (_lastHiddenBarId) { showHealthBar(_lastHiddenBarId, true); _lastHiddenBarId = '' }
      patchLocalState({ watchedName: '', watchedHp: 0, watchedMaxHp: 0 })
      _camSnapNeeded = true; _lastSpectateTarget = ''
      return
    }

    if (s.spectatedIds.length === 0) return
    const safeIdx = Math.min(s.spectateIndex, s.spectatedIds.length - 1)
    const targetId = s.spectatedIds[safeIdx]
    if (!targetId) return

    // On target switch: snap + watched HP + restore previous bar
    if (targetId !== _lastSpectateTarget) {
      _camSnapNeeded = true
      if (_lastHiddenBarId) showHealthBar(_lastHiddenBarId, true)

      const switchRoom = getRoom()
      if (targetId !== '__vip__' && switchRoom) {
        const np = switchRoom.state.players.get(targetId)
        if (np) patchLocalState({ watchedName: np.displayName || targetId.slice(0, 8), watchedHp: np.health, watchedMaxHp: np.maxHealth })
      } else {
        patchLocalState({ watchedName: '', watchedHp: 0, watchedMaxHp: 0 })
      }
      _lastSpectateTarget = targetId
    }

    // Hide current target's world-space health bar every frame while spectating.
    // For player targets this hides the Billboard HP bar; for '__vip__' the VIP
    // has no world-space bar (HP is shown in the right-side 2D panel instead),
    // so showHealthBar('vip', false) is a no-op — kept for structural symmetry.
    const barId = targetId === '__vip__' ? 'vip' : targetId
    showHealthBar(barId, false)
    _lastHiddenBarId = barId

    const room = getRoom()
    if (!room) return

    // Compute target position first so we can pre-position before activating vcam
    let targetX = 0, targetZ = 0, gotTarget = false

    if (targetId === '__vip__') {
      const vipEnt: Entity | null = getVipEntity()
      const vipT = vipEnt !== null ? Transform.getOrNull(vipEnt) : null
      if (vipT) { targetX = vipT.position.x; targetZ = vipT.position.z; gotTarget = true }
    } else {
      const p = room.state.players.get(targetId)
      if (p && p.zone === 'game') {
        const avatarEnt = findPlayerAvatarEntity(p.displayName || '')
        const avatarT   = avatarEnt !== null ? Transform.getOrNull(avatarEnt) : null
        targetX = avatarT ? avatarT.position.x : tileToWorldX(p.tileCol)
        targetZ = avatarT ? avatarT.position.z : tileToWorldZ(p.tileRow)
        gotTarget = true
      }
    }
    if (!gotTarget) return

    // Pre-position specCamEntity before activating to prevent any glide
    if (!vcamActive) {
      const ct = Transform.getMutable(specCamEntity)
      ct.position.x = targetX; ct.position.y = GAME_FLOOR_Y + 2.5; ct.position.z = targetZ
      MainCamera.getMutable(engine.CameraEntity).virtualCameraEntity = specCamEntity
      vcamActive = true
    }

    const camT = Transform.getMutable(specCamEntity)

    if (targetId === '__vip__') {
      const vipEnt: Entity | null = getVipEntity()
      const vipT = vipEnt !== null ? Transform.getOrNull(vipEnt) : null
      if (!vipT) return

      // Forward from pure-Y quaternion
      const q = vipT.rotation
      const fwdX = 2 * q.w * q.y, fwdZ = 1 - 2 * q.y * q.y
      const fLen = Math.sqrt(fwdX * fwdX + fwdZ * fwdZ)
      const nfwdX = fLen > 0.001 ? fwdX / fLen : 0
      const nfwdZ = fLen > 0.001 ? fwdZ / fLen : 1

      camT.position.x = vipT.position.x - nfwdX * CAM_BACK
      camT.position.y = GAME_FLOOR_Y + 2.5
      camT.position.z = vipT.position.z - nfwdZ * CAM_BACK
      camT.rotation   = Quaternion.fromEulerDegrees(CAM_PITCH, Math.atan2(nfwdX, nfwdZ) * (180 / Math.PI), 0)

    } else {
      const p = room.state.players.get(targetId)
      if (!p || p.zone !== 'game') return
      const avatarEnt = findPlayerAvatarEntity(p.displayName || '')
      const avatarT   = avatarEnt !== null ? Transform.getOrNull(avatarEnt) : null
      const tx = avatarT ? avatarT.position.x : tileToWorldX(p.tileCol)
      const tz = avatarT ? avatarT.position.z : tileToWorldZ(p.tileRow)

      if (_camSnapNeeded) {
        _smoothCamX = tx; _smoothCamZ = tz
        _prevTargetX = tx; _prevTargetZ = tz
        _camHeadX = 0; _camHeadZ = 1; _tgtHeadX = 0; _tgtHeadZ = 1
        _camSnapNeeded = false
      } else {
        const mdx = tx - _prevTargetX, mdz = tz - _prevTargetZ
        if (Math.abs(mdx) > 0.005 || Math.abs(mdz) > 0.005) {
          const mLen = Math.sqrt(mdx * mdx + mdz * mdz)
          _tgtHeadX = mdx / mLen; _tgtHeadZ = mdz / mLen
        }
        _prevTargetX = tx; _prevTargetZ = tz

        if (avatarT) {
          _smoothCamX = tx; _smoothCamZ = tz
        } else {
          const posAlpha = Math.min(1, dt * LERP_SPEED)
          _smoothCamX += (tx - _smoothCamX) * posAlpha
          _smoothCamZ += (tz - _smoothCamZ) * posAlpha
        }

        const headAlpha = Math.min(1, dt * 4)
        _camHeadX += (_tgtHeadX - _camHeadX) * headAlpha
        _camHeadZ += (_tgtHeadZ - _camHeadZ) * headAlpha
      }

      const hLen = Math.sqrt(_camHeadX * _camHeadX + _camHeadZ * _camHeadZ)
      const nhX  = hLen > 0.001 ? _camHeadX / hLen : 0
      const nhZ  = hLen > 0.001 ? _camHeadZ / hLen : 1

      camT.position.x = _smoothCamX - nhX * CAM_BACK
      camT.position.y = GAME_FLOOR_Y + 2.5
      camT.position.z = _smoothCamZ - nhZ * CAM_BACK
      camT.rotation   = Quaternion.fromEulerDegrees(CAM_PITCH, Math.atan2(nhX, nhZ) * (180 / Math.PI), 0)
    }
  })

  // ── Spectate switch callback ─────────────────────────────────────────────────
  setSpectateSwitchCallback(teleportToSpectatedPlayer)

  // ── Mobile fallback connect ──────────────────────────────────────────────────
  // On some mobile DCL versions onEnterScene fires before PlayerIdentityData is
  // ready and setPlayerInScene(true) is never called. This system polls once
  // per second; as soon as ECS identity is available it triggers the connection.
  // It is a no-op after the first successful onEnterScene (setPlayerInScene is
  // idempotent, connectToServer is safe to call multiple times).
  let _mobileConnectCheckDone = false
  engine.addSystem((() => {
    let _acc = 0
    return (dt: number) => {
      if (_mobileConnectCheckDone) return
      _acc += dt
      if (_acc < 1.0) return
      _acc = 0
      const ecsAddr = PlayerIdentityData.getOrNull(engine.PlayerEntity)?.address
      const live    = getPlayer()
      const localId = (ecsAddr && ecsAddr.length > 0 ? ecsAddr : null) || live?.userId
      if (!localId) return  // player not ready yet
      _mobileConnectCheckDone = true
      console.log(`[Scene] Mobile fallback connect triggered: ${localId}`)
      setLocalIdentity(localId, live?.name ?? localId)
      setPlayerInScene(true)
      connectToServer(SERVER_URL)
    }
  })())

  // ── Wire server callbacks ────────────────────────────────────────────────────
  setRoomCallbacks(onRoomJoined, onRoomLeft)

  console.log('[Scene] Built — waiting for player to enter scene')
}

// ── Connection callback (called by colyseus-client when room is ready) ─────────

export function onRoomJoined(room: ReturnType<typeof getRoom>) {
  if (!room) return

  // userId/displayName were already authenticated by the server via /auth + onAuth.
  // Reading them from getPlayer() here is just to populate the local UI state.
  const player = getPlayer()
  if (player) {
    patchLocalState({ myUserId: player.userId, mySessionId: room.sessionId })
  }

  patchLocalState({ connected: true, disconnectedMs: 0 })

  // ── State sync ───────────────────────────────────────────────────────────
  // Set up collection listeners on FIRST state change to avoid race where
  // room.state.players is not yet populated right after joinOrCreate resolves.

  let stateReady = false
  let lastVipKey  = ''   // dirty-key: sync VIP only when state actually changed
  let _lastMyTeam      = ''   // dirty-key: heavy hitbox ops only when team changes
  let _lastInventoryKey = ''  // dirty-key: refresh door E-key labels on inventory change

  room.onStateChange((state: any) => {
    if (!state) return

    // Phase/timer mirror (every update)
    patchLocalState({
      phase:         state.phase,
      timeRemaining: state.timeRemaining,
      countdown:     state.countdown,
      winner:        state.winner
    })

    const me = state.players?.get?.(room.sessionId)
    if (me) {
      // Mirror EVERY field combatInput.ts / wood-door click logic / HUD reads
      // out of localState. The per-player p.onChange callback isn't reliable
      // for nested string fields in Colyseus 0.17, so without this onStateChange
      // mirror `myRightHand` / `myLeftHand` stay stale at 'none' even after a
      // baton / bomb pickup — making the wood-door click toggle (no attack)
      // and E (no bomb-place) silently no-op.
      patchLocalState({
        myTeam:        me.team,
        myHealth:      me.health,
        myMaxHealth:   me.maxHealth,
        myRightHand:   me.rightHand   ?? 'none',
        myLeftHand:    me.leftHand    ?? 'none',
        myShieldHP:    me.shieldHP    ?? 0,
        myShieldMaxHP: me.shieldMaxHP ?? 0,
        myDefending:   !!me.defending,
      })
      // Heavy hitbox ops only when team actually changes
      if (me.team !== _lastMyTeam) {
        _lastMyTeam = me.team
        updateVipClickable()
        syncEnemyHitboxTeams()
        rebuildEnemyHitboxes(room)
      }
      // Refresh door E-key labels when inventory changes (bomb → пастка, baton → зруйнувати)
      const invKey = (me.rightHand ?? 'none') + '|' + (me.leftHand ?? 'none')
      if (invKey !== _lastInventoryKey) {
        _lastInventoryKey = invKey
        refreshWallEKeyLabels(me.rightHand ?? 'none', me.leftHand ?? 'none')
      }
    }
    // Use me?.zone from server state — always consistent with inQueue in same snapshot
    updateButtonState(state.phase, me?.inQueue ?? false, me?.zone === 'game', state.countdown ?? 0)

    // Damage accumulation: scan every player's lastDamage(Time) / lastDealt(Time)
    // and feed per-session buckets. The watched session's bucket is republished
    // into localState so ui.tsx's bottom-centre HUD always shows the correct
    // figures whether the viewer is the player or a spectator following them.
    const allPlayers = state.players
    if (allPlayers) {
      const nowMs = Date.now()
      for (const [sid, p] of allPlayers as Iterable<[string, {
        lastDamage:     number; lastDamageTime: number;
        lastDealt:      number; lastDealtTime:  number;
      }]>) {
        const ldt  = p.lastDamageTime ?? 0
        const prev = _prevPlayerHitTime.get(sid) ?? 0
        if (ldt > prev) {
          _prevPlayerHitTime.set(sid, ldt)
          if (prev > 0 && (p.lastDamage ?? 0) > 0) {
            _accumulate(_bucketFor(sid).recv, p.lastDamage, nowMs)
          }
        }
        const ldealt = p.lastDealtTime ?? 0
        const pdealt = _prevPlayerDealtTime.get(sid) ?? 0
        if (ldealt > pdealt) {
          _prevPlayerDealtTime.set(sid, ldealt)
          if (pdealt > 0 && (p.lastDealt ?? 0) > 0) {
            _accumulate(_bucketFor(sid).dealt, p.lastDealt, nowMs)
          }
        }
      }
      _publishWatchedDmg()
    }

    // VIP: sync on every state change using a dirty key so we don't call upsertVip
    // unnecessarily but also don't miss updates when schema fields don't diff
    // (e.g. first game where initial VIPState values equal startGame values).
    const vip = state.vip
    if (vip) {
      // HP and escort-name are UI-only fields — update them on every state
      // change so the right-side panel stays current even when VIP is standing
      // still and only taking damage (position unchanged → vipKey unchanged).
      patchLocalState({
        vipFollowingName:  vip.active ? (vip.targetName ?? '') : '',
        vipHp:             vip.active ? (vip.health    ?? 0) : 0,
        vipMaxHp:          vip.active ? (vip.maxHealth ?? 0) : 0,
        vipAppearanceMode: vip.appearanceMode ?? 'random',
        vipPlayerWallet:   (vip.playerWallet  ?? '').toLowerCase()
      })

      // VIP hit detection (same diff trick as for players).
      const vipLdt = vip.lastDamageTime ?? 0
      if (vipLdt > _prevVipHitTime) {
        if (_prevVipHitTime > 0 && vip.active) notifyVipHit()
        _prevVipHitTime = vipLdt
      }

      // Track VIP follower changes to update hitbox visibility and apply the
      // 15-second cooldown for non-escorting bodyguards.
      const newFollowerId = vip.active ? (vip.followerId ?? '') : ''
      const lsCur = getLocalState()
      if (newFollowerId !== lsCur.vipFollowerId) {
        // Another BG (not us) just claimed VIP → start cooldown for this player
        if (lsCur.myTeam === 'bodyguard'
            && newFollowerId !== ''
            && newFollowerId !== lsCur.mySessionId) {
          patchLocalState({ vipFollowCooldownUntil: Date.now() + 15_000 })
        }
        // VIP became unescorted or we are now escorting → clear cooldown
        if (newFollowerId === '' || newFollowerId === lsCur.mySessionId) {
          patchLocalState({ vipFollowCooldownUntil: 0 })
        }
        patchLocalState({ vipFollowerId: newFollowerId })
        updateVipClickable()
      }


      // Rendering key: only fields that actually affect what players SEE.
      // Excludes health, lastDamageTime and targetName — those are gameplay
      // state that must not re-trigger position animation or entity re-creation.
      // Always update idle facing — facingYaw changes every server tick.
      if (vip.active) setVipFacingYaw(vip.facingYaw ?? 0)

      const vipKey = `${vip.active},${vip.tileCol},${vip.tileRow},${vip.female},${vip.outfitIndex},${vip.skinIndex},${vip.hairIndex},${vip.eyeIndex},${(vip.playerAvatarJson ?? '').slice(0, 40)},${(vip.playerWallet ?? '')}`
      if (vipKey !== lastVipKey) {
        lastVipKey = vipKey
        upsertVip(vip.tileCol, vip.tileRow, vip.active,
                  {
                    female:      vip.female      ?? false,
                    outfitIndex: vip.outfitIndex ?? 0,
                    skinIndex:   vip.skinIndex   ?? 0,
                    hairIndex:   vip.hairIndex   ?? 0,
                    eyeIndex:    vip.eyeIndex    ?? 0
                  },
                  vip.playerAvatarJson ?? '',
                  (vip.playerWallet    ?? '').toLowerCase())
        updateVipClickable()   // re-apply after upsertVip may have just created the hitbox

        // Rebuild spectatedIds when VIP active state flips
        const inGameIds = [...room.state.players.keys()].filter((sid: string) => {
          const pl = room.state.players.get(sid)
          return pl?.zone === 'game' && pl?.isAlive
        })
        if (vip.active) inGameIds.push('__vip__')
        const cur = getLocalState()
        const curTarget = cur.spectatedIds[cur.spectateIndex]
        const newIdx = inGameIds.indexOf(curTarget)
        patchLocalState({
          spectatedIds:   inGameIds,
          spectateIndex:  newIdx >= 0 ? newIdx : Math.max(0, Math.min(cur.spectateIndex, inGameIds.length - 1))
        })
      }
    }

    rebuildPlayerList(room)

    // Mirror match history to the spectator-cube board.
    // Server pushes newest to the END of the array → reverse so the board
    // shows newest first. Use Array.from + iterator to handle both ArraySchema
    // and plain arrays gracefully (forEach on ArraySchema with destructured
    // shape can miss fields in some Colyseus versions).
    if (state.history) {
      const raw: any[] = []
      try {
        for (const h of state.history) raw.push(h)
      } catch (_) {
        state.history.forEach?.((h: any) => raw.push(h))
      }
      const arr = raw.slice().reverse().map(h => ({
        winner:    h.winner    ?? '',
        reason:    h.reason    ?? '',
        endedAt:   h.endedAt   ?? 0,
        durationS: h.durationS ?? 0
      }))
      updateHistoryBoard(arr)
    }

    // Sync all enemy hitboxes from the latest server state every change.
    // Relying on per-PlayerState `p.onChange` proved unreliable in practice
    // (initial spawn tile never shifted from the default), so we authoritatively
    // mirror tileCol/tileRow each tick. upsertEnemyHitbox is a no-op when the
    // tile didn't change, so this is cheap.
    syncAllEnemyHitboxes(room)
    syncAllHandItems(room, room.sessionId)

    // Wall diff sync — Colyseus 0.17 ArraySchema doesn't expose a `.onChange`
    // method (silent no-op via `?.`), so this state-change handler is the only
    // place we can detect wall mutations. Compare current wallTypes/wallStates
    // with `knownWallTypes/knownWallStates` and fire syncWall on every diff.
    // This is what actually removes destroyed walls (type → NONE) from the scene.
    if (state.wallTypes && state.wallStates) {
      const wt = state.wallTypes, ws = state.wallStates
      const len = wt.length | 0
      for (let i = 0; i < len; i++) {
        const newType  = wt[i] | 0
        const newState = ws[i] | 0
        if (newType !== knownWallTypes[i] || newState !== knownWallStates[i]) {
          knownWallTypes[i]  = newType
          knownWallStates[i] = newState
          syncWall(i, newType, newState)
          // Adjacent junction posts (concrete columns at wall intersections) need
          // to disappear if all 4 walls around them are gone — otherwise they
          // float in mid-air after a bomb clears the surrounding hedges.
          refreshJunctionsAroundWall(i, knownWallTypes, knownWallStates)
        }
      }
    }

    // Wall HP sync — feeds into syncWallHP() which updates E-key hint
    // visibility for hedges/doors (baton only works below 50% HP).
    if (state.wallHP && state.wallMaxHP) {
      const hp    = state.wallHP
      const maxHp = state.wallMaxHP
      const wt    = state.wallTypes
      const len   = (hp.length | 0)
      for (let i = 0; i < len; i++) {
        const h = hp[i] | 0, m = maxHp[i] | 0
        if (h !== knownWallHP[i] || m !== knownWallMaxHP[i]) {
          knownWallHP[i]    = h
          knownWallMaxHP[i] = m
          syncWallHP(i, wt ? (wt[i] | 0) : knownWallTypes[i], h, m)
        }
      }
    }

    // Per-team door colour refresh — claim ownership, blocked-team
    // acknowledgement and "is enemy adjacent on the other side" change every
    // tick, so we re-tint doors against the latest snapshot. Cheap: only door
    // entities are re-materialled (a few % of total walls).
    if (state.wallStates && state.wallClaimTeams && state.wallClaimAck) {
      const tileTeams = new Map<number, Set<string>>()
      const players = state.players
      if (players) {
        for (const p of players.values()) {
          if (p.zone !== 'game' || !p.isAlive) continue
          if (p.team !== 'bodyguard' && p.team !== 'hater') continue
          const key = (p.tileRow | 0) * 16 + (p.tileCol | 0)
          let s = tileTeams.get(key)
          if (!s) { s = new Set(); tileTeams.set(key, s) }
          s.add(p.team)
        }
      }
      const isEnemyAdjacent = (idx: number, claimTeam: number): boolean => {
        const enemy = claimTeam === 1 ? 'hater' : 'bodyguard'
        const sides = wallSidesTiles(idx)
        const ka = sides.a.row * 16 + sides.a.col
        const kb = sides.b.row * 16 + sides.b.col
        return !!tileTeams.get(ka)?.has(enemy) || !!tileTeams.get(kb)?.has(enemy)
      }
      refreshDoorMaterials({
        myTeam:         me?.team ?? 'none',
        wallStates:     state.wallStates,
        wallClaimTeams: state.wallClaimTeams,
        wallClaimAck:   state.wallClaimAck,
        isEnemyAdjacent,
      })
    }

    // Item-map diff fallback. MapSchema.onAdd/onRemove are unreliable in
    // Colyseus 0.17 (the `?.` chain silently no-ops on some setups), so we
    // also reconcile item entities here against state.items every tick.
    // Cheap: <= ITEM_MAX (~6) entries, only fires syncItems when something
    // actually changed.
    if (state.items) {
      let dirty = false
      const seen = new Set<string>()
      state.items.forEach?.((v: any, k: string) => {
        seen.add(k)
        const known = knownItemKeys.get(k)
        const sig = `${v.tileCol}|${v.tileRow}|${v.type}|${v.active}`
        if (known !== sig) { knownItemKeys.set(k, sig); dirty = true }
      })
      for (const k of [...knownItemKeys.keys()]) {
        if (!seen.has(k)) { knownItemKeys.delete(k); dirty = true }
      }
      if (dirty) refreshItems(room)
    }

    // Bombs diff fallback — same Colyseus 0.17 reason as items / walls. The
    // map's onAdd/onRemove sometimes silently miss entries, leaving placed
    // bombs invisible until detonation. We mirror state.bombs against the
    // local activeBombs list every tick.
    if (state.bombs) {
      const localState = getLocalState()
      const seen = new Set<string>()
      let dirty = false
      const next: typeof localState.activeBombs = []
      state.bombs.forEach?.((b: any, k: string) => {
        seen.add(k)
        next.push({ key: k, col: b.tileCol | 0, row: b.tileRow | 0, fuseEndsAt: Number(b.fuseEndsAt), armed: !!b.armed, triggerWallIdx: b.triggerWallIdx | 0 })
        const sig = `${b.tileCol}|${b.tileRow}|${b.fuseEndsAt}|${b.armed ? 1 : 0}`
        if (knownBombSigs.get(k) !== sig) {
          knownBombSigs.set(k, sig)
          dirty = true
          // (Re-)spawn the world overlay. spawnBombOverlay short-circuits if
          // the key already has an entity, so we tear-down-then-spawn for
          // changed bombs (e.g. a door-trap arming).
          removeBombOverlay(k)
          // NOTE: fuseEndsAt must NOT use bitwise | 0 — it is a Unix timestamp
          // in milliseconds (~1.75 × 10¹²) which overflows a 32-bit signed int
          // (max ~2.1 × 10⁹), producing a large negative number. tickBombOverlays
          // then computes (negativeNumber - Date.now()) / 1000 which is always ≤ 0,
          // so Math.max(0, …) returns 0 and the countdown never shows correctly.
          spawnBombOverlay(k, b.tileCol | 0, b.tileRow | 0, Number(b.fuseEndsAt), !!b.armed)
        }
      })
      for (const k of [...knownBombSigs.keys()]) {
        if (!seen.has(k)) {
          knownBombSigs.delete(k)
          removeBombOverlay(k)
          dirty = true
        }
      }
      if (dirty) patchLocalState({ activeBombs: next })
    }

    // One-time: attach MapSchema listeners and do initial rebuild
    if (!stateReady) {
      stateReady = true

      state.players?.onAdd?.((p: any, sessionId: string) => {
        p.onChange(() => onPlayerChanged(sessionId, p))
      })
      state.players?.onRemove?.((_p: any, sessionId: string) => {
        removeHealthBar(sessionId)
        removeEnemyHitbox(sessionId)
        clearPlayerHands(sessionId)
        _prevPlayerHitTime.delete(sessionId)
        _prevPlayerDealtTime.delete(sessionId)
        _dmgBySession.delete(sessionId)
      })

      // Wall changes are synced via diff inside this onStateChange handler
      // below — Colyseus 0.17 ArraySchema does NOT expose a `.onChange` method
      // on the array itself (the `?.` chain silently no-ops), so the previous
      // `state.wallTypes.onChange(...)` registration was a no-op and walls
      // never disappeared after HP=0. See the diff loop after the `if
      // (!stateReady)` block.

      state.items?.onAdd?.   ((_: any, _key: string) => refreshItems(room))
      state.items?.onRemove?.  ((_: any, _key: string) => refreshItems(room))

      // Bombs replicate as a MapSchema. Each entry triggers a world
      // overlay (sphere + countdown text). Removed entries → tear down overlay.
      state.bombs?.onAdd?.((b: any, key: string) => {
        // Number(b.fuseEndsAt) — обов'язково: timestamp ~1.75×10¹² переповнює int32
        // якщо передати як є; | 0 для col/row безпечний (малі числа).
        spawnBombOverlay(key, b.tileCol | 0, b.tileRow | 0, Number(b.fuseEndsAt), !!b.armed)
        patchLocalState({
          activeBombs: [...getLocalState().activeBombs, { key, col: b.tileCol | 0, row: b.tileRow | 0, fuseEndsAt: Number(b.fuseEndsAt), armed: !!b.armed, triggerWallIdx: b.triggerWallIdx | 0 }]
        })
      })
      state.bombs?.onRemove?.((_: any, key: string) => {
        removeBombOverlay(key)
        patchLocalState({
          activeBombs: getLocalState().activeBombs.filter(b => b.key !== key)
        })
      })

      rebuildFromState(room)
    }

    // Mirror VIP-room lock + maze metadata into local state every tick (cheap).
    if (state.vipRoomLocked !== undefined) {
      patchLocalState({
        vipRoomLocked:    !!state.vipRoomLocked,
        mazeTemplateId:   state.mazeTemplateId   ?? '',
      })
    }
  })

  // ── Server messages ──────────────────────────────────────────────────────

  room.onMessage('teleport', (data: { x: number; y: number; z: number; cx?: number; cy?: number; cz?: number; spectating?: boolean }) => {
    movePlayerTo({
      newRelativePosition: Vector3.create(data.x, data.y, data.z),
      cameraTarget: data.cx !== undefined ? Vector3.create(data.cx, data.cy ?? data.y, data.cz ?? data.z) : undefined
    })
    if (data.spectating === true) {
      // Populate spectatedIds immediately so the VirtualCamera system has a
      // target on the very first frame — don't wait for the next p.onChange
      // or vipKey change (could be several seconds away during quiet periods).
      const specRoom = getRoom()
      const specIds: string[] = specRoom
        ? [...specRoom.state.players.keys()].filter((sid: string) => {
            const pl = specRoom.state.players.get(sid)
            return pl?.zone === 'game' && pl?.isAlive && sid !== specRoom.sessionId
          })
        : []
      if (specRoom?.state.vip?.active) specIds.push('__vip__')
      const curS = getLocalState()
      const curTarget = curS.spectatedIds[curS.spectateIndex]
      const newIdx = specIds.indexOf(curTarget)
      patchLocalState({
        isSpectating: true,
        zone:         'spectator',
        spectatedIds: specIds,
        spectateIndex: newIdx >= 0 ? newIdx : 0
      })
    } else if (data.spectating === false) {
      patchLocalState({ isSpectating: false, zone: data.y > 14 ? 'game' : 'lobby' })
    } else {
      const newZone = data.y > 14 ? 'game' : data.y < 5 ? 'lobby' : 'spectator'
      patchLocalState({ zone: newZone as any })
    }

    // Якщо телепорт переніс нас у game zone (reconnect-restore чи knockback) —
    // переконатися що сцена видима. Без цього після identify-restore сервер
    // переносить аватар у game zone, а вона залишається невидимою бо
    // rebuildFromState ще не бачив phase=playing у локальному state.
    if (data.y > 14) {
      setMazeVisible(true)
      setVipVisible(true)
      // Update myTileCol/myTileRow одразу, щоб reportTilePosition не послав
      // зайве "player_tile" з застарілою плиткою на наступному тіку.
      const newCol = worldToTileCol(data.x)
      const newRow = worldToTileRow(data.z)
      patchLocalState({ myTileCol: newCol, myTileRow: newRow, savedTileCol: newCol, savedTileRow: newRow })
    }
  })

  // Authoritative full-maze rebuild — fired by the server after every
  // prepareMazeForMatch / resetToLobby. Triggers a full client-side teardown
  // of walls + junction posts so that junction posts and safety-tile overlays
  // are rebuilt from the new layout instead of mutating the old one wall-by-
  // wall.
  room.onMessage('maze_rebuild', (data: {
    wallTypes:    number[]
    wallStates:   number[]
    wallHP?:      number[]
    wallMaxHP?:   number[]
    templateId?:  string
    safetyTiles?: Array<{ col: number; row: number }>
    vipRoomTiles?: Array<{ col: number; row: number }>
    vipRoomDoors?: number[]
    vipRoomLocked?: boolean
  }) => {
    knownWallTypes  = data.wallTypes.slice()
    knownWallStates = data.wallStates.slice()
    knownWallHP     = (data.wallHP    ?? []).slice()
    knownWallMaxHP  = (data.wallMaxHP ?? []).slice()
    knownItemKeys.clear()
    knownBombSigs.clear()
    clearAllHands()
    clearWallHPOverlays()
    clearAllBombOverlays()
    patchLocalState({ activeBombs: [] })
    buildMaze(knownWallTypes, knownWallStates)
    // Re-apply E-key hints for any walls that accept the player's current
    // inventory (bare hands can always attack wood walls, etc.).
    { const s = getLocalState(); refreshWallEKeyLabels(s.myRightHand, s.myLeftHand) }
    setSafetyTiles(data.safetyTiles ?? [])
    // Re-emit any HP info for the fresh layout. The maze is frozen for the
    // whole match (no regen) but server sends current HP / maxHP arrays so
    // that a reconnecting client sees walls already damaged at their actual
    // mid-match state rather than full health.
    const hp    = data.wallHP    ?? []
    const maxHp = data.wallMaxHP ?? []
    const types = data.wallTypes ?? []
    for (let i = 0; i < hp.length; i++) syncWallHP(i, types[i] ?? 0, hp[i] ?? 0, maxHp[i] ?? 0)
    console.log(`[Scene] Maze fully rebuilt (${data.templateId ?? 'lobby'})`)
  })

  // The door state itself flips via the wallStates onChange path; we just log
  // so debugging is easier.
  room.onMessage('vip_room_unlocked', () => {
  })

  room.onMessage('vip_door_crossed', (data: { wallIdx: number }) => {
    flashVipDoorCross(data.wallIdx)
  })

  // Server tells us why a wall attack didn't land (e.g. hand vs hedge).
  // Shown as a brief toast so the player knows what to do instead of clicking
  // forever with no feedback.
  room.onMessage('attack_blocked', (data: { reason: string }) => {
    if (!data?.reason) return
    patchLocalState({ toastText: data.reason, toastExpiresAt: Date.now() + 2500 })
  })

  room.onMessage('hit', (_data: { damage: number; attackerId?: string; shield?: number; blocked?: boolean }) => {
    // Visual feedback only — the damage HUD is fed from state diffs in
    // onStateChange so spectators see the watched player's numbers too.
    triggerHitFlash()
    patchLocalState({ lastHitTimeMs: Date.now() })
  })

  room.onMessage('hit_sound', (_data: { col: number; row: number }) => {
    playSound('hit')
  })

  room.onMessage('game_ended', (data: { winner: string; reason: string }) => {
    patchLocalState({ phase: 'ended', winner: data.winner, winReason: data.reason ?? '' })
    // Play win/lose sound for everyone in the room (global — heard from any zone).
    // Spectators / lobby players (myTeam='none') hear win-sound when bodyguards win
    // (positive outcome: VIP is safe) and lose-sound when haters win.
    // game_end_win / game_end_lose sounds are disabled
  })

  // Server broadcasts bomb_placed to ALL clients so everyone hears the arming click.
  room.onMessage('bomb_placed', (_data: { col: number; row: number }) => {
    playSound('bomb_place')
  })

  room.onMessage('bomb_explode', (data: { col: number; row: number }) => {
    // Hit-flash (red screen) is intentionally restricted to the game zone —
    // lobby / spectator players should not have their screen flash on every explosion.
    if (getLocalState().zone === 'game') triggerHitFlash()
    playSound('explosion')   // global=true → audible from lobby & spectator zone too
    // 3D ефект: емісивна сфера на тайлі вибуху розширюється і згасає (~0.7 с).
    spawnExplosionEffect(data.col, data.row)
  })

  room.onMessage('welcome', (data: { phase: string }) => {
    patchLocalState({ phase: data.phase })
  })

  // Налаштування сцени від сервера (ENABLE_GAME_ZONE_FIRST_PERSON /
  // ENABLE_ROOF_PHYSICS_COLLIDER / ALLOW_ALL_TILE_OVERLAP у server/config.json).
  // Надсилається одразу після 'welcome' при кожному підключенні, а також при
  // кожному hot-reload config.json (server broadcast).
  room.onMessage('scene_config', (data: { firstPerson: boolean; roofPhysics: boolean; allowAllTileOverlap?: boolean }) => {
    applySceneConfig(data.firstPerson, data.roofPhysics)
    const overlap = data.allowAllTileOverlap ?? false
    if (getLocalState().allowAllTileOverlap !== overlap) {
      patchLocalState({ allowAllTileOverlap: overlap })
      // Tear down all enemy hitboxes — they'll be re-created on the next state
      // sync with the new flag in effect (so allies + everyone alike get no
      // physicsBox when overlap is on).
      syncAllEnemyHitboxesForOverlap()
      // Re-evaluate VIP hitbox layer (drops CL_PHYSICS for haters when on).
      updateVipClickable()
    }
  })

  // Death handover: switch into spectator mode and focus the killer.
  room.onMessage('you_died', (data: { killerId: string }) => {
    const r = getRoom()
    if (!r) return
    const killerId = data.killerId || ''

    // Build current spectatable target list (alive game-zone players + VIP if active)
    const inGameIds = [...r.state.players.keys()].filter((sid: string) => {
      const pl = r.state.players.get(sid)
      return pl?.zone === 'game' && pl?.isAlive && sid !== r.sessionId
    })
    if (r.state.vip?.active) inGameIds.push('__vip__')

    // Prefer the killer if still spectatable, else first available.
    let idx = killerId ? inGameIds.indexOf(killerId) : -1
    if (idx < 0) idx = inGameIds.length > 0 ? 0 : 0

    // Spectator-list and isSpectating are set; the actual avatar teleport into
    // the spectator zone is performed by the server via a `teleport` message
    // (spectating: true), which both moves the avatar and updates p.zone server-side.
    // The spectator camera locks onto the killer through the spectatedIds/index
    // we just set.
    patchLocalState({
      isSpectating:  true,
      zone:          'spectator',
      spectatedIds:  inGameIds,
      spectateIndex: idx
    })
  })

}

// ── Called from colyseus-client on disconnect ──────────────────────────────────

export function onRoomLeft() {
  const s = getLocalState()
  patchLocalState({ connected: false, disconnectedMs: Date.now() })

  // Save tile so a mid-game reconnect can restore us. Hide maze + VIP — but
  // keep the game-zone perimeter and under-platform visible (they're part of
  // the world structure, not match-specific scenery).
  if (s.zone === 'game' || s.zone === 'spectator') {
    patchLocalState({ savedTileCol: s.myTileCol, savedTileRow: s.myTileRow })
    setMazeVisible(false)
    setVipVisible(false)
  }

  // Clear VIP light / end-game pulse — the per-frame system will rebuild them
  // once the next match starts. Damage trackers also reset so the HUD is
  // empty on reconnect.
  resetAllLightEffects()
  _prevPlayerHitTime.clear()
  _prevPlayerDealtTime.clear()
  _dmgBySession.clear()
  _prevVipHitTime = 0
  _publishWatchedDmg()
}

// ── Disconnect timeout ─────────────────────────────────────────────────────────

let _disconnectAccum = 0

function checkDisconnectTimeout(dt: number) {
  const s = getLocalState()
  if (s.connected) { _disconnectAccum = 0; return }

  // If was in game zone and disconnected long enough → teleport to lobby
  if ((s.zone === 'game' || s.zone === 'spectator') && s.disconnectedMs > 0) {
    _disconnectAccum += dt * 1000
    if (_disconnectAccum >= DISCONNECTED_TIMEOUT_MS) {
      _disconnectAccum = 0
      patchLocalState({ zone: 'lobby' })
      movePlayerTo({ newRelativePosition: Vector3.create(8, 1.1, 4) })
    }
  }
}

// ── Player list sync for right-side UI panel ──────────────────────────────────

// Mirror server-side DISCONNECT_DEATH_MS so the HUD countdown matches the
// moment the server actually flips isAlive. Keep these constants in sync.
// Server: DISCONNECT_DEATH_MS = 60_000 (constants.ts)
const DISCONNECT_DEATH_MS_CLIENT = 60_000


function rebuildPlayerList(room: any) {
  if (!room?.state?.players) return
  const list: PlayerEntry[] = []
  const now = Date.now()
  room.state.players.forEach((p: any, sid: string) => {
    // Include all match participants regardless of zone:
    // alive players stay in 'game', dead players move to 'spectator', but
    // both should appear in the scoreboard. team='none' means lobby/non-participant.
    if (p.team !== 'none') {
      const connected      = p.connected ?? true
      const disconnectedAt = p.disconnectedAt ?? 0
      let secondsUntilDead = 0
      if (!connected && disconnectedAt > 0 && p.isAlive) {
        secondsUntilDead = Math.max(0, Math.ceil((DISCONNECT_DEATH_MS_CLIENT - (now - disconnectedAt)) / 1000))
      }
      list.push({
        sessionId:        sid,
        name:             p.displayName || sid.slice(0, 8),
        team:             p.team        || 'none',
        hp:               p.health      ?? 0,
        maxHp:            p.maxHealth   ?? 100,
        isAlive:          p.isAlive     ?? false,
        connected,
        ping:             p.ping ?? 0,
        secondsUntilDead
      })
    }
  })
  patchLocalState({ playerList: list })
}

// ── Enemy hitbox rebuild (called when local team is set or changes) ───────────

function rebuildEnemyHitboxes(room: any) {
  if (!room?.state?.players) return
  const s = getLocalState()
  room.state.players.forEach((p: any, sid: string) => {
    if (sid === s.mySessionId) return
    // Disconnected players are frozen by the server (no damage, no movement);
    // remove their hitbox so attackers don't hit empty space and waste a swing.
    const live = (p.connected ?? true)
    if (p.zone === 'game' && p.isAlive && live) {
      upsertEnemyHitbox(sid, p.tileCol, p.tileRow, p.team, p.displayName || sid.slice(0, 8), true, p.userId || '')
    } else {
      removeEnemyHitbox(sid)
    }
  })
}

// Authoritative per-tick mirror of server tileCol/tileRow → hitbox position.
// Same as rebuildEnemyHitboxes, but called from every onStateChange so the
// hitbox keeps following the player even if individual p.onChange callbacks
// don't fire for nested schema field updates.
function syncAllEnemyHitboxes(room: any) {
  rebuildEnemyHitboxes(room)
}

// Mirror each player's rightHand/leftHand schema fields to a small mesh
// attached to that player's avatar via AvatarAttach. Run every onStateChange
// because per-player p.onChange callbacks aren't reliable for nested string
// fields in Colyseus 0.17. setHeldItem itself short-circuits when nothing
// changed, so this is cheap.
function syncAllHandItems(room: any, mySessionId: string) {
  const players = room?.state?.players
  if (!players) return
  players.forEach?.((p: any, sid: string) => {
    if (!p) return
    if (p.zone !== 'game' || !p.isAlive) {
      clearPlayerHands(sid)
      return
    }
    // Local player → omit avatarId so AvatarAttach defaults to local user.
    // Remote players → use p.userId; skip if it's not yet populated (the
    // schema lands it asynchronously after auth).
    const userId = sid === mySessionId ? '' : (p.userId ?? '')
    if (sid !== mySessionId && !userId) {
      clearPlayerHands(sid)
      return
    }
    setHeldItem(sid, userId, 'right', (p.rightHand ?? 'none') as HandItem)
    setHeldItem(sid, userId, 'left',  (p.leftHand  ?? 'none') as HandItem)
  })
}

// ── Player state sync ─────────────────────────────────────────────────────────

function onPlayerChanged(sessionId: string, p: any) {
  const s = getLocalState()

  // Update my own local state
  // zone is NOT patched here — it's managed by teleport messages and TriggerArea events.
  // Patching zone from p.onChange would overwrite the local zone with a stale server
  // value whenever any property (health, weapon, …) changes, causing brief zone mismatch.
  if (sessionId === s.mySessionId) {
    const teamChanged = p.team !== s.myTeam
    patchLocalState({
      myTeam:        p.team,
      myHealth:      p.health,
      myMaxHealth:   p.maxHealth,
      myRightHand:   p.rightHand   ?? 'none',
      myLeftHand:    p.leftHand    ?? 'none',
      myShieldHP:    p.shieldHP    ?? 0,
      myShieldMaxHP: p.shieldMaxHP ?? 0,
      myDefending:   !!p.defending,
    })
    if (teamChanged) {
      updateVipClickable()
      syncEnemyHitboxTeams()
      const ownRoom = getRoom()
      if (ownRoom) rebuildEnemyHitboxes(ownRoom)
    }
    const ownRoom = getRoom()
    if (ownRoom) rebuildPlayerList(ownRoom)
    return
  }

  // Other players: show health bar when in game zone AND connected.
  // Disconnected players keep their entry in the right-side list (with the
  // ⌛ countdown), but their world hitbox is removed so attacks don't land
  // on empty space — server also rejects damage on connected=false.
  const live = (p.connected ?? true)
  if (p.zone === 'game' && p.isAlive && live) {
    const wx = tileToWorldX(p.tileCol), wz = tileToWorldZ(p.tileRow)
    const teamColor = p.team === 'bodyguard'
      ? { r: 0.2, g: 0.6, b: 1.0, a: 1.0 }
      : { r: 1.0, g: 0.2, b: 0.2, a: 1.0 }
    upsertHealthBar(sessionId, wx, wz, p.health, p.maxHealth, p.lastDamage, p.lastDamageTime, teamColor as any, p.displayName || sessionId.slice(0, 8))
    upsertEnemyHitbox(sessionId, p.tileCol, p.tileRow, p.team, p.displayName || sessionId.slice(0, 8), true, p.userId || '')
    // Keep bar hidden if we're currently spectating this player
    if (s.isSpectating && s.spectatedIds[s.spectateIndex] === sessionId) {
      showHealthBar(sessionId, false)
      patchLocalState({ watchedName: p.displayName || sessionId.slice(0, 8), watchedHp: p.health, watchedMaxHp: p.maxHealth })
    }
  } else {
    showHealthBar(sessionId, false)
    removeEnemyHitbox(sessionId)
  }

  // Update spectated player list (include VIP entry if active)
  const room = getRoom()
  if (room) {
    const inGameIds = [...room.state.players.keys()].filter((sid: string) => {
      const pl = room.state.players.get(sid)
      return pl?.zone === 'game' && pl?.isAlive
    })
    if (room.state.vip?.active) inGameIds.push('__vip__')
    // Preserve the current spectate target so the camera doesn't snap when an
    // unrelated player property (e.g. tileCol) triggers a list rebuild.
    const cur = getLocalState()
    const curTarget = cur.spectatedIds[cur.spectateIndex]
    const newIdx = inGameIds.indexOf(curTarget)
    patchLocalState({
      spectatedIds:  inGameIds,
      spectateIndex: newIdx >= 0 ? newIdx : Math.max(0, Math.min(cur.spectateIndex, inGameIds.length - 1))
    })
    rebuildPlayerList(room)
  }
}

// ── Tile position reporting ───────────────────────────────────────────────────

function reportTilePosition() {
  const s = getLocalState()
  if (s.zone !== 'game') return
  const room = getRoom()
  if (!room) return

  // Use PlayerEntity (avatar ground position) — CameraEntity is offset in third-person view
  const playerT = Transform.getOrNull(engine.PlayerEntity)
  if (!playerT) return
  const col = worldToTileCol(playerT.position.x)
  const row = worldToTileRow(playerT.position.z)

  if (col !== s.myTileCol || row !== s.myTileRow) {
    patchLocalState({ myTileCol: col, myTileRow: row })
    room.send('player_tile', { col, row })
  }
}

// ── Spectator teleport ────────────────────────────────────────────────────────

function teleportToSpectatedPlayer(_idx: number) {
  // VirtualCamera system detects target change every frame — no teleport needed.
}

// ── Full rebuild on reconnect ─────────────────────────────────────────────────

function rebuildFromState(room: any) {
  const state = room.state
  if (!state || state.wallTypes == null) return

  knownWallTypes  = Array.from(state.wallTypes  as Iterable<number>)
  knownWallStates = Array.from(state.wallStates as Iterable<number>)
  buildMaze(knownWallTypes, knownWallStates)
  { const s = getLocalState(); refreshWallEKeyLabels(s.myRightHand, s.myLeftHand) }

  const vip = state.vip
  if (vip?.active) upsertVip(vip.tileCol, vip.tileRow, true,
    {
      female:      vip.female      ?? false,
      outfitIndex: vip.outfitIndex ?? 0,
      skinIndex:   vip.skinIndex   ?? 0,
      hairIndex:   vip.hairIndex   ?? 0,
      eyeIndex:    vip.eyeIndex    ?? 0
    },
    vip.playerAvatarJson ?? '',
    (vip.playerWallet    ?? '').toLowerCase())
  updateVipClickable()
  rebuildEnemyHitboxes(room)

  // Sync local zone with the server's view, but DON'T forcibly teleport lobby
  // players — they should be free to move where they want. The maze/VIP
  // visibility is driven by phase (see ECS system in main()), and the avatar
  // position is owned by the local TriggerArea logic.
  const room2 = room
  const me = room2.state.players?.get?.(room2.sessionId)
  const serverZone: 'game' | 'spectator' | 'lobby' =
    (me?.zone === 'game' || me?.zone === 'spectator') ? me.zone : 'lobby'

  const s = getLocalState()
  if (state.phase === 'playing' && serverZone === 'game' && s.zone === 'game') {
    // Genuine reconnect mid-game — restore the player to their saved tile.
    setMazeVisible(true)
    setVipVisible(true)
    const wx = tileToWorldX(s.savedTileCol), wz = tileToWorldZ(s.savedTileRow)
    movePlayerTo({ newRelativePosition: Vector3.create(wx, GAME_FLOOR_Y + 1.6, wz) })
  } else if (serverZone === 'lobby') {
    // Sync our local zone label with the server, but DO NOT teleport. Lobby
    // players keep whatever position they had.
    patchLocalState({ zone: 'lobby', isSpectating: false })
  }
}

// ── Items sync helper ─────────────────────────────────────────────────────────

function refreshItems(room: any) {
  const itemMap = new Map<string, any>()
  room.state.items.forEach((v: any, k: string) => itemMap.set(k, v))
  syncItems(itemMap)
}
