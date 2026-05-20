/**
 * VIP ambient audio system — timer-driven reactive sounds.
 *
 * All logic runs per-frame in a single ECS system. Each client independently
 * evaluates conditions from the shared Colyseus room state, so sounds fire
 * consistently across all connected clients.
 *
 * ── Sound schedule ────────────────────────────────────────────────────────────
 *
 *  vip_complain  — 5 s after game start; then every 45 s.
 *                  Timer PAUSES while any hater is within Chebyshev-2 of VIP.
 *                  When last hater leaves that radius, the 45 s timer resets
 *                  from that exact moment (not from when complain last played).
 *
 *  radio_check   — 10 s after each vip_complain.
 *
 *  vip_spotted   — edge-trigger when any hater ENTERS Chebyshev-2 of VIP.
 *                  Hard cooldown: not more than once per 20 s.
 *
 *  suspicious    — 10 s after each vip_spotted.
 *
 *  security / vip_help (alternating toggle)
 *                — triggered by EITHER of two conditions:
 *                    A) VIP HP decreases (hater landed a hit on VIP)
 *                    B) Any hater stays within Chebyshev-1 of VIP for 5 s
 *                  After each play a 2 s cooldown prevents burst spamming.
 *                  Condition B resets its 5 s accumulator after playing.
 *
 * ── Distance metric ──────────────────────────────────────────────────────────
 * Uses Chebyshev distance (max of |Δcol|, |Δrow|) — same as the combat
 * isLocalNearTileDiag helper — so "radius 2" means the 5×5 tile square
 * centred on VIP, and "radius 1" is the 3×3 square.
 */

import { engine } from '@dcl/sdk/ecs'
import { getLocalState } from '../state/localState'
import { getRoom } from '../colyseus-client'
import { playSound } from './soundManager'
import { getVipTile } from '../game/npcRenderer'

// ── State ──────────────────────────────────────────────────────────────────────

let _phase = ''                // last observed phase — for change detection

// vip_complain / radio_check
let _complainTimer    = 5      // seconds until next vip_complain
let _haterNear2       = false  // is any hater currently within Chebyshev-2 of VIP
let _radioCheckTimer  = -1     // > 0: seconds until radio_check fires (-1 = idle)

// vip_spotted / suspicious
let _prevHaterNear2      = false  // previous frame's haterNear2 — for edge detection
let _vipSpottedCooldown  = 0      // remaining cooldown (s) before next spotted can fire
let _suspiciousTimer     = -1     // > 0: seconds until suspicious fires (-1 = idle)

// security / vip_help (proximity 1 tile, 5 s)
let _hater1TileAccum = 0      // accumulated seconds a hater has been within 1 tile of VIP
let _svToggle        = false  // false → next play is 'security'; true → 'vip_help'
let _svCooldown      = 0      // remaining cooldown (s) after last security/vip_help play

// VIP HP tracking for attack detection
let _lastVipHp = -1           // -1 = uninitialised (never fires attack sound on init)

// ── Helper: Chebyshev distance ─────────────────────────────────────────────────

function chebDist(col1: number, row1: number, col2: number, row2: number): number {
  return Math.max(Math.abs(col1 - col2), Math.abs(row1 - row2))
}

// ── Helper: check if any hater is within N Chebyshev tiles of VIP ─────────────

function anyHaterWithin(vipCol: number, vipRow: number, maxDist: number): boolean {
  const room = getRoom()
  if (!room?.state?.players) return false
  let found = false
  room.state.players.forEach?.((p: any) => {
    if (!found && p.team === 'hater' && p.zone === 'game' && p.isAlive) {
      if (chebDist(p.tileCol | 0, p.tileRow | 0, vipCol, vipRow) <= maxDist) {
        found = true
      }
    }
  })
  return found
}

// ── Reset all counters when a new game begins ─────────────────────────────────

function resetForNewGame(): void {
  _complainTimer      = 5
  _haterNear2         = false
  _radioCheckTimer    = -1
  _prevHaterNear2     = false
  _vipSpottedCooldown = 0
  _suspiciousTimer    = -1
  _hater1TileAccum    = 0
  _svToggle           = false
  _svCooldown         = 0
  _lastVipHp          = -1
}

// ── ECS system ────────────────────────────────────────────────────────────────

export function initVipAudio(): void {
  engine.addSystem((dt: number) => {
    const s = getLocalState()

    // ── Phase change ────────────────────────────────────────────────────────
    if (s.phase !== _phase) {
      const wasPlaying = _phase === 'playing'
      _phase = s.phase
      if (s.phase === 'playing') {
        resetForNewGame()
      } else if (wasPlaying) {
        // Game ended — cancel all pending timers so no lingering sounds fire
        _radioCheckTimer    = -1
        _suspiciousTimer    = -1
        _complainTimer      = 999
        _vipSpottedCooldown = 0
      }
    }

    if (s.phase !== 'playing') return

    // Silence all VIP ambient sounds during the last 15 seconds of the match.
    // timeRemaining is mirrored from the server every onStateChange tick.
    if (s.timeRemaining > 0 && s.timeRemaining <= 15) return

    const vip = getVipTile()
    if (vip.col < 0 || vip.row < 0) return  // VIP not yet spawned

    // ── Tick cooldown timers ────────────────────────────────────────────────
    if (_svCooldown > 0)          _svCooldown          = Math.max(0, _svCooldown - dt)
    if (_vipSpottedCooldown > 0)  _vipSpottedCooldown  = Math.max(0, _vipSpottedCooldown - dt)

    // ── Proximity checks ────────────────────────────────────────────────────
    const haterNear2 = anyHaterWithin(vip.col, vip.row, 2)
    const haterNear1 = anyHaterWithin(vip.col, vip.row, 1)

    // ── vip_complain + radio_check ──────────────────────────────────────────
    //
    // While hater is within 2 tiles: freeze the complain timer.
    // When hater leaves: reset the 45 s interval from this moment.
    // When timer hits 0: play vip_complain, reset to 45 s, schedule radio_check.

    if (haterNear2) {
      // Hater is nearby — mark flag, timer is frozen (we simply don't decrement)
      _haterNear2 = true
    } else {
      if (_haterNear2) {
        // Hater just left the 2-tile radius — restart 45 s interval from NOW
        _haterNear2    = false
        _complainTimer = 45
      }
      // Decrement only while no hater nearby
      _complainTimer -= dt
      if (_complainTimer <= 0) {
        _complainTimer = 45
        playSound('vip_complain')
        _radioCheckTimer = 10  // schedule radio_check 10 s from now
      }
    }

    // radio_check countdown runs independently of hater proximity
    if (_radioCheckTimer > 0) {
      _radioCheckTimer -= dt
      if (_radioCheckTimer <= 0) {
        _radioCheckTimer = -1
        playSound('radio_check')
      }
    }

    // ── vip_spotted + suspicious ────────────────────────────────────────────
    //
    // Edge-trigger: fires only on the frame the first hater enters the radius.
    // Cooldown 20 s prevents repeated triggers if hater walks in/out quickly.

    const haterJustEntered = haterNear2 && !_prevHaterNear2
    _prevHaterNear2 = haterNear2

    if (haterJustEntered && _vipSpottedCooldown <= 0) {
      playSound('vip_spotted')
      _vipSpottedCooldown = 20
      _suspiciousTimer    = 10  // schedule suspicious 10 s from now
    }

    if (_suspiciousTimer > 0) {
      _suspiciousTimer -= dt
      if (_suspiciousTimer <= 0) {
        _suspiciousTimer = -1
        playSound('suspicious')
      }
    }

    // ── security / vip_help — proximity (1 tile, 5 s accumulation) ─────────
    //
    // Accumulate time while any hater is within Chebyshev-1 of VIP.
    // Resets immediately when hater leaves. At 5 s threshold, play and reset.

    if (haterNear1) {
      _hater1TileAccum += dt
      if (_hater1TileAccum >= 5 && _svCooldown <= 0) {
        playSound(_svToggle ? 'vip_help' : 'security')
        _svToggle        = !_svToggle
        _svCooldown      = 2
        _hater1TileAccum = 0  // reset so it fires again after another 5 s of proximity
      }
    } else {
      _hater1TileAccum = 0  // hater left 1-tile radius — reset accumulator
    }

    // ── security / vip_help — VIP HP decrease (hater hit VIP) ─────────────
    //
    // Compares current vipHp to the previous frame's value.
    // A decrease (damage landed) triggers the alternating sound immediately.
    // Shares the same toggle + 2 s cooldown as the proximity trigger so
    // rapid consecutive hits don't spam.

    const curVipHp = s.vipHp
    if (_lastVipHp >= 0 && curVipHp < _lastVipHp && _svCooldown <= 0) {
      playSound(_svToggle ? 'vip_help' : 'security')
      _svToggle        = !_svToggle
      _svCooldown      = 2
      _hater1TileAccum = 0  // also reset proximity accumulator to avoid double-trigger
    }
    _lastVipHp = curVipHp
  })
}
