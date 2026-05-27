// Keyboard handling for E (use / stop defend / place bomb) and F (defending stance).
//
// Decentraland SDK 7 maps:
//   InputAction.IA_PRIMARY   = E
//   InputAction.IA_SECONDARY = F
//
// inputSystem.isTriggered fires true only on the single frame the key goes
// down (built-in edge detection — no manual _held tracking needed).
//
// Wall-specific E-key interactions (bomb on wall, baton attack) are handled
// directly by pointerEventsSystem.onPointerDown callbacks in maze.ts.
// Those callbacks call consumeWallEKey() to suppress the global handler here.

import { engine, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { getLocalState, patchLocalState } from '../state/localState'
import { sendToRoom } from '../colyseus-client'

// Set by wall onPointerDown(IA_PRIMARY) callbacks in maze.ts.
// Prevents the global handler from double-firing when E is pressed on a wall.
let _wallEConsumed = false
export function consumeWallEKey(): void { _wallEConsumed = true }

export function setupCombatInput() {
  engine.addSystem(() => {
    const s = getLocalState()
    if (s.zone !== 'game' || s.phase !== 'playing') return

    if (inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN)) {
      const consumed = _wallEConsumed
      _wallEConsumed = false
      if (!consumed) onEPressed()
    }
    if (inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN)) onFPressed()
  })
}

function onEPressed() {
  const s = getLocalState()

  // Priority 1: exit defending stance (works anywhere, even near walls).
  if (s.myDefending) {
    sendToRoom('toggle_defend', { defending: false })
    patchLocalState({ myDefending: false })
    return
  }

  // Priority 2: place bomb in empty space (no wall targeted).
  // Wall-targeted bomb placement is handled by each wall's onPointerDown
  // callback; those consume the E key so we never reach this branch when
  // the cursor is on a destructible wall or door.
  if (s.myLeftHand === 'bomb') {
    sendToRoom('place_bomb', {})
    return
  }

  // Wall attacks (baton) are handled by wall callbacks — nothing to do here.
}

function onFPressed() {
  const s = getLocalState()
  if (s.myDefending) return   // already defending — toggling off is via E
  sendToRoom('toggle_defend', { defending: true })
  patchLocalState({ myDefending: true })
}
