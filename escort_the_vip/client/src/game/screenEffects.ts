import { engine } from '@dcl/sdk/ecs'

// ── Screen hit-flash state ─────────────────────────────────────────────────────

let hitFlashMs   = 0
let _flashAlpha  = 0
const HIT_FLASH_DURATION = 400  // ms

export function triggerHitFlash() {
  hitFlashMs = HIT_FLASH_DURATION
}

export function getFlashAlpha(): number { return _flashAlpha }

engine.addSystem((dt: number) => {
  if (hitFlashMs > 0) {
    hitFlashMs -= dt * 1000
    _flashAlpha = Math.max(0, hitFlashMs / HIT_FLASH_DURATION) * 0.35
  } else {
    _flashAlpha = 0
  }
})
