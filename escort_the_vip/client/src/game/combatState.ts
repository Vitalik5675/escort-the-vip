// Client-side attack gate — mirrors server ATTACK_COOLDOWN_MS (config.json).
//
// The server silently ignores any attack that arrives within ATTACK_COOLDOWN_MS
// of the previous one. Without a matching client-side gate, the player can spam
// clicks and see nothing happen — the server discards every message except the
// first. Adding the same gate here makes the click behaviour predictable:
// the first click always fires; subsequent clicks within the window are
// dropped locally with a toast hint ("Attack on cooldown").
//
// The client-side value is set EQUAL to the server value (1000ms). If the
// server config changes via hot-reload, the game must be reloaded to pick up
// the new value — keeping this simple constant avoids an extra server message.
//
// The cooldown is PER-ATTACKER (local player only) and shared across ALL attack
// targets (player, VIP, wall), matching the server's single per-session timer.

import { patchLocalState } from '../state/localState'

const ATTACK_CLIENT_COOLDOWN_MS = 1000

let _lastAttackSentMs = 0

/**
 * Returns true and records the attack time if the player is not in cooldown.
 * Returns false (and shows a toast) if the cooldown has not expired yet.
 *
 * Call this before every `sendToRoom('attack' | 'attack_vip' | 'attack_wall', ...)`
 * so rapid clicks are gated client-side instead of silently dropped by the server.
 */
export function tryGateAttack(): boolean {
  const now = Date.now()
  if (now - _lastAttackSentMs < ATTACK_CLIENT_COOLDOWN_MS) {
    // Don't spam the toast — only show it when ≥ 200ms since last refusal
    // so holding the mouse doesn't flood the screen with messages.
    if (now - _lastAttackSentMs > 200) {
      patchLocalState({ toastText: 'Still swinging...', toastExpiresAt: now + 800 })
    }
    return false
  }
  _lastAttackSentMs = now
  return true
}

/** Reset the cooldown (e.g. after respawn / match start). */
export function resetAttackCooldown(): void {
  _lastAttackSentMs = 0
}
