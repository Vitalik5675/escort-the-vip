// Keyboard handling for E (use / stop defend / place bomb) and F (defending stance).
//
// Decentraland SDK 7 maps:
//   InputAction.IA_PRIMARY   = E
//   InputAction.IA_SECONDARY = F
//
// inputSystem.isTriggered fires true only on the single frame the key goes
// down (built-in edge detection — no manual _held tracking needed).

import { engine, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { getLocalState, patchLocalState } from '../state/localState'
import { sendToRoom } from '../colyseus-client'

export function setupCombatInput() {
  engine.addSystem(() => {
    const s = getLocalState()
    if (s.zone !== 'game' || s.phase !== 'playing') return

    if (inputSystem.isTriggered(InputAction.IA_PRIMARY,   PointerEventType.PET_DOWN)) onEPressed()
    if (inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN)) onFPressed()
  })
}

function onEPressed() {
  const s = getLocalState()

  // Priority 1: exit defending stance.
  if (s.myDefending) {
    sendToRoom('toggle_defend', { defending: false })
    patchLocalState({ myDefending: false })
    return
  }

  // Priority 2: place bomb if holding one in left hand.
  // If the cursor is over a destructible wall / door, the bomb targets that
  // wall — the server uses the wall type to decide between an immediate
  // countdown (hedge / fence / wood-door) or a door-trap (any door, no
  // countdown until the door opens from the opposite side).
  if (s.myLeftHand === 'bomb') {
    const wallIdx = s.bombTargetWallIdx
    sendToRoom('place_bomb', wallIdx >= 0 ? { wallIdx } : {})
    return
  }

  // Otherwise E is a no-op when there's no adjacent target. Attacks against
  // players / walls are click-driven (keeping the existing click-to-target UX).
}

function onFPressed() {
  const s = getLocalState()
  if (s.myDefending) return   // already defending — toggling off is via E
  sendToRoom('toggle_defend', { defending: true })
  patchLocalState({ myDefending: true })
}
