import { engine, Entity, Transform, Tween, EasingFunction, tweenSystem } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

export function lerpV3(a: Vector3, b: Vector3, t: number): Vector3 {
  return Vector3.create(
    a.x + (b.x - a.x) * t,
    a.y + (b.y - a.y) * t,
    a.z + (b.z - a.z) * t
  )
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

// ─────────────────────────────────────────────────────────────────────────────
// Tween completion scheduler
// ─────────────────────────────────────────────────────────────────────────────
//
// A single shared ECS system checks tweenSystem.tweenCompleted() each frame
// for every registered pending tween and fires the callback exactly once.
//
// Safety nets:
//   • Entity Transform gone → drop silently (entity was deleted mid-tween).
//   • Hard timeout (durationMs + GRACE) → drop without firing, covers the case
//     where the tween was replaced mid-flight and the SDK completion signal
//     will never arrive for the original tween.

const COMPLETE_GRACE_MS = 2_000

interface PendingComplete {
  entity:    Entity
  cb:        () => void
  expiresAt: number
}

const _pending: PendingComplete[] = []
let   _schedulerStarted = false

function _startScheduler(): void {
  if (_schedulerStarted) return
  _schedulerStarted = true
  engine.addSystem(() => {
    if (_pending.length === 0) return
    const now = Date.now()
    for (let i = _pending.length - 1; i >= 0; i--) {
      const p = _pending[i]
      if (Transform.getOrNull(p.entity) === null) {
        _pending.splice(i, 1)
        continue
      }
      if (tweenSystem.tweenCompleted(p.entity)) {
        _pending.splice(i, 1)
        try { p.cb() } catch (_) {}
        continue
      }
      if (now >= p.expiresAt) {
        _pending.splice(i, 1)
      }
    }
  })
}

function _onComplete(entity: Entity, durationMs: number, cb: () => void): void {
  _startScheduler()
  _pending.push({ entity, cb, expiresAt: Date.now() + durationMs + COMPLETE_GRACE_MS })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tween helpers — animated Transform changes via the DCL Tween component
// ─────────────────────────────────────────────────────────────────────────────
//
// NOTE: These use the DCL built-in Tween system.
// Do NOT use followRoute() on an entity that has an active Tween — the
// DCL Tween system runs after user systems and will overwrite manual position
// mutations. Use cancelTween() first if switching from Tween to manual control.

/**
 * Smoothly move an entity from its current position to `target`.
 * @param onComplete Optional callback fired when the tween finishes.
 */
export function tweenMoveTo(
  entity:     Entity,
  target:     Vector3,
  durationMs: number,
  easing:     EasingFunction = EasingFunction.EF_LINEAR,
  onComplete?: () => void
): void {
  const start = Transform.getOrNull(entity)?.position ?? Vector3.Zero()
  Tween.createOrReplace(entity, {
    mode:          Tween.Mode.Move({ start, end: target }),
    duration:      durationMs,
    easingFunction: easing
  })
  if (onComplete) _onComplete(entity, durationMs, onComplete)
}

/**
 * Smoothly scale an entity from its current scale to `target`.
 * @param onComplete Optional callback fired when the tween finishes.
 */
export function tweenScaleTo(
  entity:     Entity,
  target:     Vector3,
  durationMs: number,
  easing:     EasingFunction = EasingFunction.EF_LINEAR,
  onComplete?: () => void
): void {
  const start = Transform.getOrNull(entity)?.scale ?? Vector3.One()
  Tween.createOrReplace(entity, {
    mode:          Tween.Mode.Scale({ start, end: target }),
    duration:      durationMs,
    easingFunction: easing
  })
  if (onComplete) _onComplete(entity, durationMs, onComplete)
}

/**
 * Smoothly rotate an entity from its current rotation to `target`.
 * @param onComplete Optional callback fired when the tween finishes.
 */
export function tweenRotateTo(
  entity:     Entity,
  target:     Quaternion,
  durationMs: number,
  easing:     EasingFunction = EasingFunction.EF_LINEAR,
  onComplete?: () => void
): void {
  const start = Transform.getOrNull(entity)?.rotation ?? Quaternion.Identity()
  Tween.createOrReplace(entity, {
    mode:          Tween.Mode.Rotate({ start, end: target }),
    duration:      durationMs,
    easingFunction: easing
  })
  if (onComplete) _onComplete(entity, durationMs, onComplete)
}

/**
 * Cancel any active Tween on an entity.
 * Call before taking manual control of the entity's Transform (e.g. followRoute).
 */
export function cancelTween(entity: Entity): void {
  Tween.deleteFrom(entity)
  // Also remove from pending scheduler so the stale onComplete doesn't fire.
  for (let i = _pending.length - 1; i >= 0; i--) {
    if (_pending[i].entity === entity) _pending.splice(i, 1)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Waypoint-route system — manual frame-by-frame position control
// ─────────────────────────────────────────────────────────────────────────────
//
// followRoute() moves an entity by directly mutating Transform each frame.
// It is INCOMPATIBLE with an active Tween on the same entity — call
// cancelTween(entity) before switching from tween-driven to route-driven motion.

export interface Route {
  waypoints:  Vector3[]
  loop:       boolean
  speedMps:   number   // metres per second
  currentWP:  number
  elapsed:    number   // ms elapsed since the last waypoint was reached
}

export function createRoute(waypoints: Vector3[], speedMps = 2, loop = false): Route {
  return { waypoints: [...waypoints], loop, speedMps, currentWP: 0, elapsed: 0 }
}

/**
 * Advance entity along its route by `dt` seconds.
 * Call inside an ECS system. Returns true when the full route completes (non-loop).
 *
 * IMPORTANT: cancel any active Tween on this entity before calling this.
 * DCL's Tween system runs after user systems and will overwrite the position
 * set here if a Tween component is still present.
 */
export function followRoute(entity: Entity, route: Route, dt: number): boolean {
  if (route.waypoints.length < 2) return true

  const from     = route.waypoints[route.currentWP]
  const nextIdx  = (route.currentWP + 1) % route.waypoints.length
  const to       = route.waypoints[nextIdx]
  const dist     = Vector3.distance(from, to)
  const segMs    = dist > 0 ? (dist / route.speedMps) * 1000 : 0

  route.elapsed += dt * 1000
  const t = segMs > 0 ? clamp01(route.elapsed / segMs) : 1

  const transform = Transform.getMutableOrNull(entity)
  if (transform) transform.position = lerpV3(from, to, t)

  if (t >= 1) {
    route.currentWP = nextIdx
    route.elapsed   = 0
    // Route complete (non-looping) when we just reached the last waypoint
    if (!route.loop && nextIdx === 0) return true
  }

  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Game-specific animation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn a wall by rising it from below the game zone up to its final Y.
 * Immediately snaps the entity to `finalY - 6` then tweens to `finalY`.
 */
export function animateWallRise(entity: Entity, finalY: number, durationMs = 600): void {
  const transform = Transform.getMutableOrNull(entity)
  if (!transform) return
  const { x, z } = transform.position
  // Snap to start position (below game zone)
  transform.position = Vector3.create(x, finalY - 6, z)
  // Tween reads the snapped position as its start point
  tweenMoveTo(entity, Vector3.create(x, finalY, z), durationMs, EasingFunction.EF_EASEOUTQUAD)
}

/**
 * Slide a door to `targetY` (down to open, up to close).
 */
export function animateDoorSlide(entity: Entity, targetY: number, durationMs = 400): void {
  const t = Transform.getOrNull(entity)
  if (!t) return
  tweenMoveTo(
    entity,
    Vector3.create(t.position.x, targetY, t.position.z),
    durationMs,
    EasingFunction.EF_EASEQUAD
  )
}
