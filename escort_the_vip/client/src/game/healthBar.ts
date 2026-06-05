import { engine, Entity, Transform, BillboardMode, Material, TextShape } from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { createEntity, setVisible, removeEntity, removeEntityAndChildren } from '../utils/entityFactory'
import { GAME_FLOOR_Y } from './constants'

// ── Health bar for a world entity (players, VIP) ──────────────────────────────
//
// Structure (all in world space, Billboard on root floats over avatar):
//   root  [Billboard, at avatar pos + yOffset]
//     bg    [gray box, full width]
//     fillRoot [pivot at left edge: x = -BAR_W/2]
//       fill  [colored box, scale.x = frac scales bar left-to-right]
//     label [text "HP / maxHP"]
//     dmgLabel [text "-DMG", fades after 2s]

const Y_OFFSET  = 2.8  // metres above tile floor
const BAR_W     = 1.2
const BAR_H     = 0.12
const BAR_DEPTH = 0.01
const FONT_SIZE = 1.6
const DMG_FONT  = 2.0
const DMG_LINGER_MS = 2500

export interface HealthBarHandle {
  root:        Entity
  fillRoot:    Entity
  fill:        Entity
  label:       Entity
  dmgLabel:    Entity
  dmgTimer:    number   // ms remaining for damage label
  lastDmg:     number
  displayName: string
  _hp:         number   // cached for future use
  _maxHp:      number
}

const handles = new Map<string, HealthBarHandle>()

/** Create or update the health bar anchored to the given world position. */
export function upsertHealthBar(
  id: string,
  worldX: number, worldZ: number,
  hp: number, maxHp: number,
  lastDmg: number, lastDmgTime: number,
  teamColor: Color4 = Color4.create(0.2, 0.8, 0.2, 1),
  displayName = '',
  yOffset    = Y_OFFSET,
): HealthBarHandle {
  let h = handles.get(id)

  if (!h) {
    // Root — Billboard so it always faces camera
    const root = createEntity({
      position: Vector3.create(worldX, GAME_FLOOR_Y + yOffset, worldZ),
      billboard: BillboardMode.BM_Y,
      collider: false
    })

    // Background bar — opaque + matte (no glare).
    createEntity({
      parent:   root,
      position: Vector3.create(0, 0, 0),
      scale:    Vector3.create(BAR_W + 0.06, BAR_H + 0.04, BAR_DEPTH),
      mesh:     'box',
      material: { color: Color4.create(0.15, 0.15, 0.15, 1), roughness: 1, metallic: 0 },
      collider: false
    })

    // fillRoot is a zero-scale pivot at left edge; scaling fillRoot.x by frac grows bar left→right
    const fillRoot = createEntity({
      parent:   root,
      position: Vector3.create(-BAR_W / 2, 0, -0.005),
      scale:    Vector3.create(1, 1, 1),
      collider: false
    })
    const fill = createEntity({
      parent:   fillRoot,
      position: Vector3.create(BAR_W / 2, 0, 0),
      scale:    Vector3.create(BAR_W, BAR_H, BAR_DEPTH),
      mesh:     'box',
      material: { color: teamColor, roughness: 1, metallic: 0 },
      collider: false
    })

    // HP label
    const label = createEntity({
      parent:   root,
      position: Vector3.create(0, BAR_H + 0.12, -0.01),
      text:     { value: `${hp}/${maxHp}`, fontSize: FONT_SIZE, color: Color4.White() },
      collider: false
    })

    // Damage label
    const dmgLabel = createEntity({
      parent:   root,
      position: Vector3.create(0, BAR_H + 0.35, -0.01),
      text:     { value: '', fontSize: DMG_FONT, color: Color4.Red() },
      collider: false,
      visible:  false
    })

    h = { root, fillRoot, fill, label, dmgLabel, dmgTimer: 0, lastDmg: 0, displayName, _hp: hp, _maxHp: maxHp }
    handles.set(id, h)
  }

  h._hp = hp; h._maxHp = maxHp; h.displayName = displayName || h.displayName

  // Update root position (bar floats above avatar tile)
  const rt = Transform.getMutableOrNull(h.root)
  if (rt) { rt.position.x = worldX; rt.position.z = worldZ }

  // Scale fillRoot.x by frac — this scales the fill bar left-to-right from the left edge
  const frac = maxHp > 0 ? Math.max(0, hp / maxHp) : 0
  const fillRootT = Transform.getMutableOrNull(h.fillRoot)
  if (fillRootT) fillRootT.scale = Vector3.create(frac, 1, 1)

  // Colour: green → orange → red based on HP fraction
  const barColor = hpColor(frac, teamColor)
  Material.setPbrMaterial(h.fill, { albedoColor: barColor, roughness: 1, metallic: 0, castShadows: false })

  // Update label
  const ts = TextShape.getMutableOrNull(h.label)
  if (ts) ts.text = `${hp}/${maxHp}`

  // Damage label
  const now = Date.now()
  if (lastDmg > 0 && lastDmgTime > 0 && now - lastDmgTime < DMG_LINGER_MS) {
    if (h.lastDmg !== lastDmg) {
      h.lastDmg = lastDmg
      h.dmgTimer = DMG_LINGER_MS
      const dts = TextShape.getMutableOrNull(h.dmgLabel)
      if (dts) dts.text = `-${lastDmg}`
      setVisible(h.dmgLabel, true)
    }
  }

  return h
}

/** Remove health bar by id. */
export function removeHealthBar(id: string) {
  const h = handles.get(id)
  if (!h) return
  // removeEntityAndChildren removes root + bg, fillRoot, fill, label, dmgLabel
  removeEntityAndChildren(h.root)
  handles.delete(id)
}

/** Show/hide health bar. */
export function showHealthBar(id: string, visible: boolean) {
  const h = handles.get(id)
  if (!h) return
  setVisible(h.root, visible)
}

// ── Fade damage labels each frame ─────────────────────────────────────────────

engine.addSystem((dt: number) => {
  for (const h of handles.values()) {
    if (h.dmgTimer > 0) {
      h.dmgTimer -= dt * 1000
      if (h.dmgTimer <= 0) {
        h.dmgTimer = 0
        setVisible(h.dmgLabel, false)
      }
    }
  }
})

// ── Colour helper ─────────────────────────────────────────────────────────────

function hpColor(frac: number, teamColor: Color4): Color4 {
  if (frac > 0.6) return teamColor
  if (frac > 0.3) return Color4.create(1, 0.7, 0, 1)   // orange
  return Color4.create(1, 0.1, 0.1, 1)                  // red
}
