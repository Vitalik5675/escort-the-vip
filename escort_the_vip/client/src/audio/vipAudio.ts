/**
 * VIP ambient audio — 3-tier proximity system.
 *
 * ── Tiers ─────────────────────────────────────────────────────────────────────
 *
 *  Tier 0 (calm)    — no haters near VIP
 *    sounds : vip_complain | radio_check  (random pick)
 *    period : 20 s   first play : t = 5 s from game start
 *
 *  Tier 1 (warning) — hater within 6 Chebyshev tiles
 *    sounds : vip_spotted | suspicious   (random pick)
 *    period : 20 s
 *
 *  Tier 2 (danger)  — hater within 2 Chebyshev tiles
 *    sounds : vip_help | security        (random pick)
 *    period : 10 s
 *
 * ── Rules ─────────────────────────────────────────────────────────────────────
 *  • Only ONE sound plays at a time.
 *  • When tier increases (higher danger): stop current sound; play new tier
 *    immediately if its cooldown has elapsed, otherwise wait.
 *  • Cooldown counts down independently of whether the tier is active.
 *    If a hater retreats and re-enters, the sound only replays once the
 *    cooldown for that tier has fully elapsed (20 s or 10 s from last play).
 */

import { engine } from '@dcl/sdk/ecs'
import { getLocalState } from '../state/localState'
import { getRoom } from '../colyseus-client'
import { playSound, stopSound, SoundName } from './soundManager'
import { getVipTile } from '../game/npcRenderer'

// ── Config ─────────────────────────────────────────────────────────────────────

const TIER_SOUNDS: readonly (readonly SoundName[])[] = [
  ['vip_complain', 'radio_check'],   // 0 — calm
  ['vip_spotted',  'suspicious'],    // 1 — warning (r ≤ 6)
  ['vip_help',     'security'],      // 2 — danger  (r ≤ 2)
] as const

const TIER_PERIOD  = [20, 20, 10]   // seconds between plays per tier
const TIER_RADIUS  = [0,   6,  3]   // Chebyshev radius that activates tier 1 / 2
const TIER0_DELAY  = 5              // initial delay before tier-0 first plays

// ── Module state ────────────────────────────────────────────────────────────────

let _phase       = ''
let _currentTier = 0

// Per-tier countdown until next allowed play (≤ 0 means ready).
const _cooldown  = [TIER0_DELAY, 0, 0]

// Global guard: seconds until any new sound can start.
// Prevents two tiers from overlapping when tier changes mid-sound.
// Set to the approximate max VIP sound duration after each play.
const SOUND_DURATION_S = 10
let _anyPlaying = 0

// ── Helpers ────────────────────────────────────────────────────────────────────

function _cheb(c1: number, r1: number, c2: number, r2: number): number {
  return Math.max(Math.abs(c1 - c2), Math.abs(r1 - r2))
}

function _anyHaterWithin(vipCol: number, vipRow: number, radius: number): boolean {
  const room = getRoom()
  if (!room?.state?.players) return false
  let found = false
  room.state.players.forEach?.((p: any) => {
    if (!found && p.team === 'hater' && p.zone === 'game' && p.isAlive) {
      if (_cheb(p.tileCol | 0, p.tileRow | 0, vipCol, vipRow) <= radius) found = true
    }
  })
  return found
}

function _pickRandom(pool: readonly SoundName[]): SoundName {
  return pool[Math.floor(Math.random() * pool.length)]
}

/** Stop every managed VIP ambient sound immediately. */
function _stopAll(): void {
  for (const pool of TIER_SOUNDS) for (const s of pool) stopSound(s)
}

function _resetForNewGame(): void {
  _cooldown[0]  = TIER0_DELAY
  _cooldown[1]  = 0
  _cooldown[2]  = 0
  _currentTier  = 0
  _anyPlaying   = 0
  _stopAll()
}

// ── ECS system ─────────────────────────────────────────────────────────────────

export function initVipAudio(): void {
  engine.addSystem((dt: number) => {
    const s = getLocalState()

    // ── Phase tracking ──────────────────────────────────────────────────────
    if (s.phase !== _phase) {
      const wasPlaying = _phase === 'playing'
      _phase = s.phase
      if (s.phase === 'playing') {
        _resetForNewGame()
      } else if (wasPlaying) {
        _stopAll()
        _cooldown[0] = TIER0_DELAY
        _cooldown[1] = 0
        _cooldown[2] = 0
      }
    }

    if (s.phase !== 'playing') return

    const vip = getVipTile()
    if (vip.col < 0 || vip.row < 0) return

    // ── Tick timers ─────────────────────────────────────────────────────────
    if (_anyPlaying > 0) _anyPlaying = Math.max(0, _anyPlaying - dt)
    for (let t = 0; t < 3; t++) {
      if (_cooldown[t] > 0) _cooldown[t] = Math.max(0, _cooldown[t] - dt)
    }

    // ── Determine active tier ───────────────────────────────────────────────
    const newTier = _anyHaterWithin(vip.col, vip.row, TIER_RADIUS[2]) ? 2
                  : _anyHaterWithin(vip.col, vip.row, TIER_RADIUS[1]) ? 1
                  : 0

    _currentTier = newTier

    // Don't START new sounds in the last 15 s (already-playing sounds finish).
    if ((s.timeRemaining ?? 999) <= 15) return

    // ── Play if cooldown expired and no sound is currently playing ──────────
    if (_cooldown[_currentTier] <= 0 && _anyPlaying <= 0) {
      playSound(_pickRandom(TIER_SOUNDS[_currentTier]))
      _cooldown[_currentTier] = TIER_PERIOD[_currentTier]
      _anyPlaying = SOUND_DURATION_S
    }
  })
}
