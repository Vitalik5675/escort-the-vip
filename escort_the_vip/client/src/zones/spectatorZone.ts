import { engine, Entity, Transform, ColliderLayer, AvatarModifierType, TextShape, MeshCollider } from '@dcl/sdk/ecs'
import { Vector3, Color4, Quaternion } from '@dcl/sdk/math'
import {
  createEntity, makeClickable, removeClickable, setVisible, delay, createModifierArea
} from '../utils/entityFactory'
import { sendToRoom } from '../colyseus-client'
import { getLocalState, patchLocalState } from '../state/localState'
import { playSound } from '../audio/soundManager'

// ── Spectator zone — wide box (16×4×4 m), moved north ────────────────────────
// Centre: (16, 2, 28)  →  X = 8…24,  Z = 26…30
//
// Front face (south, Z = 22) — outer face visible to players:
//   LEFT  (X ≈ 10.5)  — "How to Play" panel  (clickable → opens modal)
//   CENTRE (X = 16)   — status text + Join/Cancel/Spectate buttons  (6 m wide)
//   RIGHT  (X ≈ 21.5) — "Last matches" history board
//
// Panels are 5 m wide each, flush with the cube's west/east walls.

const SPEC_CENTER = Vector3.create(16, 2, 28)
const SPEC_SIZE   = Vector3.create(16, 4, 4)

// Geometry helpers
// South outer face sits at Z = 26.0  (wall block: centre Z=26.05, half-depth 0.05)
const FRONT_Z      = 26.0

const BTN_D        = 0.25
const BTN_W        = 1.8                   // button width (green / red)
const BTN_H        = 0.75
const BTN_Y        = 2.2
const BTN_Z        = FRONT_Z - BTN_D / 2   // 25.875 — button centres, flush against wall

const TEXT_Y       = 3.4
const TEXT_Z       = FRONT_Z - 0.01        // 25.99 — status text, right on face

const PANEL_D      = 0.06                  // panel depth (slightly proud of south wall)
const PANEL_Z      = FRONT_Z - PANEL_D / 2 // 25.97 — panel box centre
const PANEL_TXT_Z  = FRONT_Z - 0.10        // 25.90 — text sits in front of panel

// Cube X = 8…24  (16 m wide).
// Left panel:  centre X=10.5, width=5 → spans X=8…13   (flush with west wall)
// Centre zone: blue bg X=16 width=5 → spans X=13.5…18.5  (~0.5 m gap to side panels)
//              green/red have 0.3 m inset from blue bg edges
// Right panel: centre X=21.5, width=5 → spans X=19…24  (flush with east wall)
const HTP_X        = 10.5
const HIST_X       = 21.5
const PANEL_W      = 5.0
const PANEL_H      = 3.5
const PANEL_TITLE_Y = 3.55
const PANEL_BODY_Y  = 2.15

type BtnState = 'green' | 'red' | 'blue' | 'none'
let currentBtn: BtnState = 'green'

let greenBtn:         Entity | null = null
let redBtn:           Entity | null = null
let blueBtn:          Entity | null = null
let statusTextEntity: Entity | null = null
let historyBodyEntity:  Entity | null = null

export function buildSpectatorZone() {

  // ── Outer box walls ────────────────────────────────────────────────────────
  const boxWalls: Array<{ pos: Vector3; scale: Vector3 }> = [
    // South (front face) — players face this
    { pos: Vector3.create(16, 2, 26.05), scale: Vector3.create(16, 4, 0.1) },
    // North (back face)
    { pos: Vector3.create(16, 2, 29.95), scale: Vector3.create(16, 4, 0.1) },
    // West  (outer face at X = 8.0)
    { pos: Vector3.create( 8.05, 2, 28), scale: Vector3.create(0.1, 4, 3.8) },
    // East  (outer face at X = 24.0)
    { pos: Vector3.create(23.95, 2, 28), scale: Vector3.create(0.1, 4, 3.8) },
    // Ceiling
    { pos: Vector3.create(16, 4.05, 28), scale: Vector3.create(16, 0.1, 4) },
  ]
  for (const w of boxWalls) {
    createEntity({
      position: w.pos,
      scale:    w.scale,
      mesh:     'box',
      material: { color: Color4.create(0.1, 0.12, 0.16, 1), roughness: 1.0, metallic: 0 },
      collider: 'box',
      colliderLayer: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
    })
  }

  // ── Inner cage: physics walls to keep spectator near south face ───────────
  // Cage pocket: X 15.3–16.7 × Z 22.1–23.5 (south box wall = south boundary)
  const cageWalls: Array<{ pos: Vector3; scale: Vector3 }> = [
    { pos: Vector3.create(15.3, 2, 26.8),  scale: Vector3.create(0.1, 4.2, 1.3) },  // west
    { pos: Vector3.create(16.7, 2, 26.8),  scale: Vector3.create(0.1, 4.2, 1.3) },  // east
    { pos: Vector3.create(16,   2, 27.45), scale: Vector3.create(1.4, 4.2, 0.1) },  // north
  ]
  for (const w of cageWalls) {
    createEntity({
      position: w.pos,
      scale:    w.scale,
      collider: 'box',
      colliderLayer: ColliderLayer.CL_PHYSICS
    })
  }

  // ── Avatar modifier: disable passports inside ──────────────────────────────
  createModifierArea(undefined, SPEC_CENTER, SPEC_SIZE, [AvatarModifierType.AMT_DISABLE_PASSPORTS])

  // ════════════════════════════════════════════════════════════════════════════
  // FRONT FACE — LEFT PANEL: "How to Play" button
  // ════════════════════════════════════════════════════════════════════════════
  // Compact clickable button — no body text; clicking opens the HTP modal.
  const htpBg = createEntity({
    position: Vector3.create(HTP_X, 2.5, PANEL_Z),
    scale:    Vector3.create(3.5, 0.9, PANEL_D),
    mesh:     'box',
    material: {
      color:     Color4.create(0.18, 0.12, 0.07, 1),
      roughness: 1,
      metallic:  0
    },
    collider:      'box',
    colliderLayer: ColliderLayer.CL_POINTER
  })
  makeClickable(htpBg, 'How to play', () => {
    playSound('button_click')
    patchLocalState({ showHowToPlay: !getLocalState().showHowToPlay })
  }, 6)

  // Label centred on the button, emoji at the end
  createEntity({
    position: Vector3.create(HTP_X, 2.5, PANEL_TXT_Z),
    text: {
      value:    'How to play ❓',
      fontSize: 2.0,
      color:    Color4.create(1, 0.85, 0.3, 1),
    },
    collider: false
  })


  // ════════════════════════════════════════════════════════════════════════════
  // FRONT FACE — CENTRE: status text + buttons
  // ════════════════════════════════════════════════════════════════════════════
  statusTextEntity = createEntity({
    position: Vector3.create(16, TEXT_Y, TEXT_Z),
    text: {
      value:    'Join the game!',
      fontSize: 2.6,
      color:    Color4.White(),
    },
    collider: false
  })

  // Blue bg: X=13.5…18.5  (5 m wide).
  // green: centre 14.7, spans 13.8–15.6  (0.3 m inset from blue left edge 13.5)
  // red:   centre 17.3, spans 16.4–18.2  (0.3 m inset from blue right edge 18.5)
  // gap between green and red: 16.4 – 15.6 = 0.8 m
  greenBtn = createButtonEntity(
    Vector3.create(14.7, BTN_Y, BTN_Z),
    Vector3.create(BTN_W, BTN_H, BTN_D),
    Color4.create(0.1, 0.85, 0.2, 1)
  )
  redBtn = createButtonEntity(
    Vector3.create(17.3, BTN_Y, BTN_Z),
    Vector3.create(BTN_W, BTN_H, BTN_D),
    Color4.create(0.85, 0.1, 0.1, 1)
  )
  blueBtn = createButtonEntity(
    Vector3.create(16, BTN_Y, BTN_Z),
    Vector3.create(5.0, BTN_H, BTN_D),
    Color4.create(0.1, 0.35, 0.9, 1)
  )

  // Initial state: only green visible
  setVisible(redBtn,  false)
  setVisible(blueBtn, false)
  MeshCollider.deleteFrom(redBtn)
  MeshCollider.deleteFrom(blueBtn)
  currentBtn = 'green'
  makeClickable(greenBtn, 'Join game', onGreenClick, 6)

  // ════════════════════════════════════════════════════════════════════════════
  // FRONT FACE — RIGHT PANEL: "Last matches" history
  // ════════════════════════════════════════════════════════════════════════════
  const histBg = createEntity({
    position: Vector3.create(HIST_X, 2.3, PANEL_Z),
    scale:    Vector3.create(PANEL_W, PANEL_H, PANEL_D),
    mesh:     'box',
    material: {
      color:     Color4.create(0.07, 0.10, 0.18, 1),   // dark cool-blue
      roughness: 1,
      metallic:  0
    },
    collider: false
  })
  void histBg  // referenced only for layout; no click needed

  // History title
  createEntity({
    position: Vector3.create(HIST_X, PANEL_TITLE_Y, PANEL_TXT_Z),
    text: {
      value:    '🏆 Last matches',
      fontSize: 2.2,
      color:    Color4.create(1, 0.85, 0.3, 1),
    },
    collider: false
  })

  // History body (updated externally via updateHistoryBoard)
  historyBodyEntity = createEntity({
    position: Vector3.create(HIST_X, PANEL_BODY_Y, PANEL_TXT_Z),
    text: {
      value:     'No matches played yet',
      fontSize:  1.55,
      color:     Color4.White(),
      lineCount: 7,
    },
    collider: false
  })

  console.log('[SpectatorZone] Built — cube 12×4×4 m at Z=24, front panels L/C/R')
}

// ── History board update (called from index.ts on state change) ───────────────

interface HistoryEntry {
  winner:    string
  reason:    string
  endedAt:   number
  durationS: number
}

function reasonLabel(winner: string, reason: string): string {
  if (winner === 'bodyguards') {
    if (reason === 'vip_safe')    return 'VIP reached safety'
    if (reason === 'elimination') return 'Haters eliminated'
  }
  if (winner === 'draw') {
    return 'Timeout — VIP survived'
  }
  if (winner === 'haters') {
    if (reason === 'vip_killed')  return 'VIP killed'
    if (reason === 'elimination') return 'BG eliminated'
  }
  return reason
}

function fmtDur(s: number): string {
  const m = Math.floor(s / 60), sec = s % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export function updateHistoryBoard(history: HistoryEntry[]): void {
  if (!historyBodyEntity) return
  const body = TextShape.getMutableOrNull(historyBodyEntity)
  if (!body) return
  if (!history || history.length === 0) {
    body.text = 'No matches played yet'
    return
  }
  const lines = history.slice(0, 5).map((h, i) => {
    const winnerSign = h.winner === 'bodyguards' ? '[BG]' : h.winner === 'draw' ? '[=]' : '[H]'
    return `${i + 1}. ${winnerSign} ${reasonLabel(h.winner, h.reason)}  (${fmtDur(h.durationS)})`
  })
  body.text = lines.join('\n')
}

// ── Button entity factory ─────────────────────────────────────────────────────

function createButtonEntity(pos: Vector3, scale: Vector3, color: Color4): Entity {
  return createEntity({
    position: pos,
    scale,
    mesh:     'box',
    material: {
      color,
      emissiveColor:     { r: color.r * 0.6, g: color.g * 0.6, b: color.b * 0.6 },
      emissiveIntensity: 0.6,
      roughness:         1,
      metallic:          0
    },
    collider:      'box',
    colliderLayer: ColliderLayer.CL_POINTER
  })
}

// ── Click handlers ────────────────────────────────────────────────────────────

const BTN_ANIM_MS = 300

function pressAnim(btn: Entity | null, onDone: () => void) {
  if (!btn) return onDone()
  const t = Transform.getMutableOrNull(btn)
  if (!t) return onDone()
  const ox = t.scale.x, oy = t.scale.y, oz = t.scale.z
  t.scale = Vector3.create(ox * 0.9, oy * 0.85, oz)
  delay(BTN_ANIM_MS, () => {
    const t2 = Transform.getMutableOrNull(btn)
    if (t2) t2.scale = Vector3.create(ox, oy, oz)
    onDone()
  })
}

function onGreenClick() { playSound('button_click'); pressAnim(greenBtn, () => { sendToRoom('join_game', {}) }) }
function onRedClick()   { playSound('button_click'); pressAnim(redBtn,   () => { sendToRoom('cancel_join', {}) }) }
function onBlueClick()  { playSound('button_click'); pressAnim(blueBtn,  () => { sendToRoom('spectate', {}) }) }

// ── Visibility + collider switch ──────────────────────────────────────────────

type BtnDef = { btn: Entity | null; hoverText: string; cb: () => void }

function activateBtn(def: BtnDef, active: boolean) {
  if (!def.btn) return
  setVisible(def.btn, active)
  if (active) {
    MeshCollider.setBox(def.btn, ColliderLayer.CL_POINTER)
    makeClickable(def.btn, def.hoverText, def.cb, 6)
  } else {
    MeshCollider.deleteFrom(def.btn)
    removeClickable(def.btn)
  }
}

function switchTo(next: BtnState) {
  if (next === currentBtn) return
  activateBtn({ btn: greenBtn, hoverText: 'Join game', cb: onGreenClick }, next === 'green')
  activateBtn({ btn: redBtn,   hoverText: 'Cancel',    cb: onRedClick   }, next === 'red')
  activateBtn({ btn: blueBtn,  hoverText: 'Spectate',  cb: onBlueClick  }, next === 'blue')
  currentBtn = next
}

// ── Deferred button-state update (collapses rapid Colyseus patches) ───────────

let _pendingPhase    = ''
let _pendingInQueue  = false
let _pendingIsInGame = false
let _pendingCountdown = 0
let _dirty = false

engine.addSystem(() => {
  if (!_dirty) return
  _dirty = false
  _applyButtonState(_pendingPhase, _pendingInQueue, _pendingIsInGame, _pendingCountdown)
})

export function updateButtonState(phase: string, inQueue: boolean, isInGame: boolean, countdown = 0) {
  _pendingPhase     = phase
  _pendingInQueue   = inQueue
  _pendingIsInGame  = isInGame
  _pendingCountdown = countdown
  _dirty = true
}

function _applyButtonState(phase: string, inQueue: boolean, isInGame: boolean, countdown: number) {
  if (statusTextEntity) {
    const t = TextShape.getMutableOrNull(statusTextEntity)
    if (t) {
      if (phase === 'countdown') {
        t.text = `Starting in ${Math.ceil(countdown)}s`
      } else if (phase === 'playing') {
        t.text = 'Game in progress'
      } else if (inQueue) {
        t.text = 'Waiting for players...'
      } else {
        t.text = 'Join the game!'
      }
    }
  }

  if (phase === 'playing') {
    switchTo(isInGame || inQueue ? 'none' : 'blue')
  } else {
    switchTo(inQueue ? 'red' : 'green')
  }
}
