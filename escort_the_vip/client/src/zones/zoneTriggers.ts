import { engine, Transform, TriggerArea, triggerAreaEventsSystem } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { patchLocalState, getLocalState } from '../state/localState'
import {
  GAME_ZONE_Y, WALL_HEIGHT,
  ARENA_WIDTH, ARENA_DEPTH, ARENA_CX, ARENA_CZ
} from '../game/constants'

// Authoritative "is the local player inside this trigger area" — derived from
// Enter/Stay/Exit callbacks (the documented SDK pattern). Stay fires every
// frame while inside; Exit fires when the avatar leaves. These two getters
// expose the flags so other systems (like the lobby evictor) can query the
// current state without re-reading TriggerAreaResult themselves.
export function isInsideGameZone(): boolean { return _insideGame }

// ── Zone detection (purely client-side, server-independent) ──────────────────
// Three SDK 7 callbacks drive this:
//   onTriggerEnter — fires once when an entity crosses INTO the area.
//   onTriggerStay  — fires every frame while the entity remains INSIDE. This
//                    is what makes detection self-healing: if the avatar is
//                    already inside at scene-load (e.g. after a server restart
//                    that left them floating in the game zone), Stay fires on
//                    frame 1 and establishes zone without an Enter event.
//   onTriggerExit  — fires once when the entity leaves.
//
// `isSpectating` overrides everything — while watching the spectator camera,
// zone='spectator' is locked regardless of the avatar's physical position.
//
// We deliberately avoid a per-frame fallback that resets to 'lobby' because
// that races with the Stay callback (system order is unspecified; if our
// fallback runs before Stay, it would flip-flop zone every frame and kill
// the InputModifier). Exit handlers are sufficient to leave the zone.

const GAME_CENTER = Vector3.create(ARENA_CX, GAME_ZONE_Y + WALL_HEIGHT / 2, ARENA_CZ)
const GAME_SIZE   = Vector3.create(ARENA_WIDTH, WALL_HEIGHT, ARENA_DEPTH)

// Spectator zone — fixed 16×4×4 m strip near the north edge of the arena.
const SPEC_CENTER = Vector3.create(ARENA_CX, 2, ARENA_DEPTH - 4)
const SPEC_SIZE   = Vector3.create(16, 4, 4)

// Track which area Stay last fired in this frame so Exit handlers can pick
// the correct destination (e.g. exiting game zone but still inside spectator
// box → zone='spectator', not 'lobby').
let _insideGame = false
let _insideSpec = false

export function setupZoneTriggers() {
  // ── Game zone ─────────────────────────────────────────────────────────────
  const gameArea = engine.addEntity()
  Transform.create(gameArea, { position: GAME_CENTER, scale: GAME_SIZE })
  TriggerArea.setBox(gameArea)

  triggerAreaEventsSystem.onTriggerEnter(gameArea, (event) => {
    if (event.trigger?.entity !== engine.PlayerEntity) return
    _insideGame = true
    if (getLocalState().isSpectating) return
    if (getLocalState().zone !== 'game') {
      patchLocalState({ zone: 'game' })
      console.log('[Zone] Entered game zone')
    }
  })

  triggerAreaEventsSystem.onTriggerStay(gameArea, (event) => {
    if (event.trigger?.entity !== engine.PlayerEntity) return
    _insideGame = true
    if (getLocalState().isSpectating) return
    // Self-healing: forces zone=game whenever the avatar is physically inside,
    // even if the Enter event was missed (e.g. avatar already inside at load).
    // No-op when zone is already 'game'.
    if (getLocalState().zone !== 'game') {
      patchLocalState({ zone: 'game' })
      console.log('[Zone] Stay → game zone (recovered)')
    }
  })

  triggerAreaEventsSystem.onTriggerExit(gameArea, (event) => {
    if (event.trigger?.entity !== engine.PlayerEntity) return
    _insideGame = false
    if (getLocalState().isSpectating) return
    const next = _insideSpec ? 'spectator' : 'lobby'
    if (getLocalState().zone !== next) {
      patchLocalState({ zone: next })
      console.log(`[Zone] Left game zone → ${next}`)
    }
  })

  // ── Spectator zone ────────────────────────────────────────────────────────
  const specArea = engine.addEntity()
  Transform.create(specArea, { position: SPEC_CENTER, scale: SPEC_SIZE })
  TriggerArea.setBox(specArea)

  triggerAreaEventsSystem.onTriggerEnter(specArea, (event) => {
    if (event.trigger?.entity !== engine.PlayerEntity) return
    _insideSpec = true
    if (getLocalState().isSpectating) return
    if (getLocalState().zone !== 'spectator') {
      patchLocalState({ zone: 'spectator' })
      console.log('[Zone] Entered spectator zone')
    }
  })

  triggerAreaEventsSystem.onTriggerStay(specArea, (event) => {
    if (event.trigger?.entity !== engine.PlayerEntity) return
    _insideSpec = true
    if (getLocalState().isSpectating) return
    if (getLocalState().zone !== 'spectator') {
      patchLocalState({ zone: 'spectator' })
      console.log('[Zone] Stay → spectator zone (recovered)')
    }
  })

  triggerAreaEventsSystem.onTriggerExit(specArea, (event) => {
    if (event.trigger?.entity !== engine.PlayerEntity) return
    _insideSpec = false
    if (getLocalState().isSpectating) return
    const next = _insideGame ? 'game' : 'lobby'
    if (getLocalState().zone !== next) {
      patchLocalState({ zone: next })
      console.log(`[Zone] Left spectator zone → ${next}`)
    }
  })

  console.log('[ZoneTriggers] Set up (Enter + Stay + Exit, self-healing)')
}
