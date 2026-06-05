import {
  engine, Entity,
  Transform, MeshRenderer, MeshCollider, Material,
  TextShape, Billboard, BillboardMode, GltfContainer,
  AudioSource, PointerEvents, PointerEventType, InputAction,
  VisibilityComponent, ColliderLayer, TextAlignMode,
  MaterialTransparencyMode, TextureWrapMode, AvatarModifierArea, AvatarModifierType,
  CameraModeArea, CameraType, TriggerArea, triggerAreaEventsSystem,
  inputSystem
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4, Color3 } from '@dcl/sdk/math'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MeshType = 'box' | 'sphere' | 'cylinder' | 'plane'

// ── Material ──────────────────────────────────────────────────────────────────

export interface MaterialOpts {
  /** Base albedo colour (default: white) */
  color?:             Color4
  /** Local path or URL to an albedo texture (applied via Material.Texture.Common) */
  texture?:           string
  /**
   * UV offset — зсуває початок текстури.
   * Формула рендера: final_uv = offset + (input_uv * tiling)
   * Приклад: прибрати 10% прозорих країв → offset={x:0.1, y:0.1}, tiling={x:0.8, y:0.8}
   */
  textureOffset?:     { x: number; y: number }
  /**
   * UV tiling (масштаб текстури). default = {x:1, y:1}.
   * < 1 → zoom-in (зображення розтягується на меш, краї обрізаються).
   * > 1 → tile (повторення).
   */
  textureTiling?:     { x: number; y: number }
  /**
   * Wrap mode. Default = TWM_CLAMP (no repeat).
   * TWM_REPEAT — тайлинг за межами UV.
   * TWM_MIRROR — дзеркальний тайлинг.
   */
  textureWrapMode?:   TextureWrapMode
  /** Emissive (glow) colour */
  emissiveColor?:     Color3
  /** Emissive multiplier — 0 = no glow, >1 = overbright */
  emissiveIntensity?: number
  /** 0 = smooth, 1 = fully rough */
  roughness?:         number
  /** 0 = non-metallic, 1 = full metal */
  metallic?:          number
  /** Alpha cutoff for masked transparency */
  alphaTest?:         number
  transparencyMode?:  MaterialTransparencyMode
  /** Whether this mesh casts shadows (default: true) */
  castShadows?:       boolean
}

// ── Text ──────────────────────────────────────────────────────────────────────

export interface TextOpts {
  value:         string
  fontSize?:     number
  color?:        Color4
  outlineColor?: Color4
  outlineWidth?: number
  textAlign?:    TextAlignMode
  lineCount?:    number
  lineSpacing?:  number
}

// ── Audio ─────────────────────────────────────────────────────────────────────

export interface AudioOpts {
  audioClipUrl: string
  loop?:        boolean
  volume?:      number
  /** Start playing immediately on creation */
  autoPlay?:    boolean
}

// ── Trigger zone ──────────────────────────────────────────────────────────────

export interface TriggerOpts {
  /** Trigger box size in world-space metres */
  size:      Vector3
  /** Called when engine.PlayerEntity enters the area */
  onEnter?:  () => void
  /** Called every frame engine.PlayerEntity stays inside */
  onStay?:   () => void
  /** Called when engine.PlayerEntity leaves the area */
  onExit?:   () => void
}

// ── Main EntityOpts ───────────────────────────────────────────────────────────
//
// All fields are optional. Only the components whose corresponding option is
// provided are created — this avoids polluting entities with default components
// they don't need.
//
// Mutual exclusions:
//   • `mesh` and `gltf` should not both be set on the same entity; if they are
//     GltfContainer takes visual precedence in the renderer.
//   • `collider: false` means "no collider", regardless of `mesh` value.
//     Omitting `collider` entirely auto-creates a collider matching `mesh` when
//     `mesh` is set — pass `false` to opt out of that default.

export interface EntityOpts {
  // ── Transform ───────────────────────────────────────────────────────────────
  parent?:    Entity
  position?:  Vector3
  rotation?:  Quaternion
  scale?:     Vector3

  // ── Primitive mesh (MeshRenderer) ───────────────────────────────────────────
  mesh?:      MeshType

  // ── PBR material ────────────────────────────────────────────────────────────
  // Pass `false` to explicitly skip material setup even when `mesh` is set.
  material?:  MaterialOpts | false

  // ── Collider (MeshCollider) ──────────────────────────────────────────────────
  // • Omit or undefined  → auto-infer from `mesh` (CL_PHYSICS | CL_POINTER)
  // • MeshType string    → use that shape
  // • false              → no collider at all
  collider?:      MeshType | false
  colliderLayer?: ColliderLayer

  // ── 3D model (GltfContainer) ─────────────────────────────────────────────────
  gltf?:      string

  // ── Billboard (always-face-camera) ──────────────────────────────────────────
  billboard?: BillboardMode

  // ── World-space text label ───────────────────────────────────────────────────
  text?:      TextOpts

  // ── Audio source ─────────────────────────────────────────────────────────────
  audio?:     AudioOpts

  // ── Trigger area (player zone detection) ────────────────────────────────────
  // When set, attaches TriggerArea.setBox and wires enter/stay/exit callbacks
  // for engine.PlayerEntity. The entity's Transform.scale is set from opts.scale
  // (or trigger.size if scale is not provided), not from trigger.size, so the
  // visual and trigger bounds stay independent.
  trigger?:   TriggerOpts

  // ── Visibility ───────────────────────────────────────────────────────────────
  // Only attach VisibilityComponent when explicitly set (true or false).
  // Absence of the component means "visible" in DCL — don't add it unnecessarily.
  visible?:   boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Click / hover registry
// ─────────────────────────────────────────────────────────────────────────────
//
// Both registries share a single syncPointerEvents() call so click and hover
// can coexist on the same entity without overwriting each other.

type ClickCb = (entity: Entity) => void
type HoverCb = (entity: Entity, entering: boolean) => void

interface ClickEntry { cb: ClickCb; text: string; dist: number }
interface HoverEntry { cb: HoverCb; dist: number }

const clickRegistry   = new Map<Entity, ClickEntry>()
const hoverRegistry   = new Map<Entity, HoverEntry>()
// E-key (IA_PRIMARY) secondary hint — shown alongside the left-click label.
// cb fires when the player presses E while their cursor is on this entity.
interface EKeyEntry { text: string; dist: number; cb: (entity: Entity) => void }
const eKeyRegistry = new Map<Entity, EKeyEntry>()

function syncPointerEvents(entity: Entity): void {
  const click  = clickRegistry.get(entity)
  const hover  = hoverRegistry.get(entity)
  const eKey   = eKeyRegistry.get(entity)
  if (!click && !hover && !eKey) { PointerEvents.deleteFrom(entity); return }

  // Guard: don't attach PointerEvents to entities that currently have no
  // MeshCollider — the DCL renderer logs "Missing MeshCollider" warnings for
  // them. This happens for open doors (collider removed on slide-open) or any
  // entity whose collider was temporarily removed. Registry entries are kept
  // intact so syncEntityPointerEvents() correctly restores PointerEvents once
  // the collider is re-attached (e.g. when the door closes again).
  if (MeshCollider.getOrNull(entity) === null) {
    PointerEvents.deleteFrom(entity)
    return
  }

  const events: any[] = []
  if (click) {
    events.push({
      eventType: PointerEventType.PET_DOWN,
      eventInfo: {
        button:        InputAction.IA_POINTER,
        hoverText:     click.text,
        maxDistance:   click.dist,
        showHighlight: false
      }
    })
  } else if (eKey) {
    // DCL only fires hover/interaction events on entities that have at least
    // one IA_POINTER PET_DOWN registered. Without it, the entity is not
    // considered "interactive" — hover callbacks won't fire and IA_PRIMARY
    // hints won't appear. Add a silent (empty hoverText) left-click event
    // so DCL registers the entity as interactive.
    events.push({
      eventType: PointerEventType.PET_DOWN,
      eventInfo: {
        button:        InputAction.IA_POINTER,
        hoverText:     '',
        maxDistance:   eKey.dist,
        showHighlight: false
      }
    })
  }
  if (eKey) {
    events.push({
      eventType: PointerEventType.PET_DOWN,
      eventInfo: {
        button:        InputAction.IA_PRIMARY,
        hoverText:     eKey.text,
        maxDistance:   eKey.dist,
        showHighlight: false
      }
    })
  }
  if (hover) {
    events.push(
      {
        eventType: PointerEventType.PET_HOVER_ENTER,
        eventInfo: { button: InputAction.IA_POINTER, hoverText: '', maxDistance: hover.dist, showFeedback: false }
      },
      {
        eventType: PointerEventType.PET_HOVER_LEAVE,
        eventInfo: { button: InputAction.IA_POINTER, hoverText: '', maxDistance: hover.dist, showFeedback: false }
      }
    )
  }
  PointerEvents.createOrReplace(entity, { pointerEvents: events })
}

// Single shared polling system for all click/hover callbacks.
// Snapshots registries before iterating so callbacks can safely mutate them.
// Dead-entity guard: after engine.removeEntity(e), both Transform and
// PointerEvents return null — at that point we evict the stale entry.
engine.addSystem(() => {
  for (const [entity, entry] of [...clickRegistry]) {
    if (Transform.getOrNull(entity) === null && PointerEvents.getOrNull(entity) === null) {
      clickRegistry.delete(entity)
      continue
    }
    if (inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_DOWN, entity)) {
      entry.cb(entity)
    }
  }
  for (const [entity, entry] of [...hoverRegistry]) {
    if (Transform.getOrNull(entity) === null && PointerEvents.getOrNull(entity) === null) {
      hoverRegistry.delete(entity)
      continue
    }
    if (inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_HOVER_ENTER, entity)) {
      entry.cb(entity, true)
    }
    if (inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_HOVER_LEAVE, entity)) {
      entry.cb(entity, false)
    }
  }
  // E-key (IA_PRIMARY) — entity-specific polling so callbacks fire only when
  // the player's cursor is on THIS entity (not a global key check).
  for (const [entity, entry] of [...eKeyRegistry]) {
    if (Transform.getOrNull(entity) === null && PointerEvents.getOrNull(entity) === null) {
      eKeyRegistry.delete(entity)
      continue
    }
    if (inputSystem.getInputCommand(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN, entity)) {
      entry.cb(entity)
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Internal component builders
// ─────────────────────────────────────────────────────────────────────────────

function _applyTransform(e: Entity, opts: EntityOpts): void {
  if (
    opts.parent   !== undefined ||
    opts.position !== undefined ||
    opts.rotation !== undefined ||
    opts.scale    !== undefined
  ) {
    Transform.createOrReplace(e, {
      parent:   opts.parent,
      position: opts.position ?? Vector3.Zero(),
      rotation: opts.rotation ?? Quaternion.Identity(),
      scale:    opts.scale    ?? Vector3.One()
    })
  }
}

function _applyMesh(e: Entity, type: MeshType): void {
  switch (type) {
    case 'box':      MeshRenderer.setBox(e);      break
    case 'sphere':   MeshRenderer.setSphere(e);   break
    case 'cylinder': MeshRenderer.setCylinder(e); break
    case 'plane':    MeshRenderer.setPlane(e);    break
  }
}

function _applyMaterial(e: Entity, m: MaterialOpts): void {
  const textureComponent = m.texture
    ? Material.Texture.Common({
        src:      m.texture,
        offset:   m.textureOffset,
        tiling:   m.textureTiling,
        wrapMode: m.textureWrapMode,
      })
    : undefined

  Material.setPbrMaterial(e, {
    albedoColor:       m.color            ?? Color4.White(),
    texture:           textureComponent,
    emissiveColor:     m.emissiveColor    ?? Color3.Black(),
    emissiveIntensity: m.emissiveIntensity ?? 0,
    roughness:         m.roughness        ?? 0.5,
    metallic:          m.metallic         ?? 0,
    alphaTest:         m.alphaTest,
    transparencyMode:  m.transparencyMode,
    castShadows:       m.castShadows      ?? true
  })
}

function _applyCollider(e: Entity, type: MeshType, layer: ColliderLayer): void {
  switch (type) {
    case 'box':      MeshCollider.setBox(e, layer);      break
    case 'sphere':   MeshCollider.setSphere(e, layer);   break
    case 'cylinder': MeshCollider.setCylinder(e, layer); break
    case 'plane':    MeshCollider.setPlane(e, layer);    break
  }
}

function _applyText(e: Entity, t: TextOpts): void {
  TextShape.createOrReplace(e, {
    text:         t.value,
    fontSize:     t.fontSize    ?? 2,
    textColor:    t.color       ?? Color4.White(),
    outlineColor: t.outlineColor ?? Color4.Black(),
    outlineWidth: t.outlineWidth ?? 0.1,
    textAlign:    t.textAlign   ?? TextAlignMode.TAM_MIDDLE_CENTER,
    lineCount:    t.lineCount   ?? 1,
    lineSpacing:  t.lineSpacing ?? 0
  })
}

function _applyAudio(e: Entity, a: AudioOpts): void {
  AudioSource.createOrReplace(e, {
    audioClipUrl: a.audioClipUrl,
    loop:         a.loop    ?? false,
    volume:       a.volume  ?? 1,
    playing:      a.autoPlay ?? false
  })
}

function _applyTrigger(e: Entity, t: TriggerOpts): void {
  // TriggerArea.setBox uses the entity's Transform.scale as the box bounds.
  // If the entity has no Transform yet, set one now using trigger.size.
  if (Transform.getOrNull(e) === null) {
    Transform.createOrReplace(e, {
      position: Vector3.Zero(),
      scale:    t.size
    })
  }
  TriggerArea.setBox(e)

  if (t.onEnter) {
    triggerAreaEventsSystem.onTriggerEnter(e, (ev) => {
      if (ev.trigger?.entity === engine.PlayerEntity) t.onEnter!()
    })
  }
  if (t.onStay) {
    triggerAreaEventsSystem.onTriggerStay(e, (ev) => {
      if (ev.trigger?.entity === engine.PlayerEntity) t.onStay!()
    })
  }
  if (t.onExit) {
    triggerAreaEventsSystem.onTriggerExit(e, (ev) => {
      if (ev.trigger?.entity === engine.PlayerEntity) t.onExit!()
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new entity and apply the given components in one call.
 *
 * Component creation rules:
 *   • Transform    — created when any of parent/position/rotation/scale is set
 *   • MeshRenderer — created when `mesh` is set
 *   • Material     — created when `material` is set (and not `false`)
 *   • MeshCollider — auto-inferred from `mesh` unless `collider: false` is passed
 *   • GltfContainer — created when `gltf` is set
 *   • TextShape    — created when `text` is set
 *   • AudioSource  — created when `audio` is set
 *   • TriggerArea  — created when `trigger` is set
 *   • Billboard    — created when `billboard` is set
 *   • VisibilityComponent — only created when `visible` is explicitly true/false
 */
export function createEntity(opts: EntityOpts = {}): Entity {
  const e = engine.addEntity()
  applyOpts(e, opts)
  return e
}

/**
 * Apply (or update) components on an existing entity.
 * Safe to call on an already-configured entity — uses createOrReplace semantics.
 */
export function applyOpts(e: Entity, opts: EntityOpts): void {

  // ── Transform ────────────────────────────────────────────────────────────
  _applyTransform(e, opts)

  // ── Primitive mesh ───────────────────────────────────────────────────────
  if (opts.mesh) _applyMesh(e, opts.mesh)

  // ── Material ─────────────────────────────────────────────────────────────
  if (opts.material !== false && opts.material !== undefined) {
    _applyMaterial(e, opts.material)
  }

  // ── Collider ──────────────────────────────────────────────────────────────
  // Auto-infer from mesh when collider is omitted; disable when `false`.
  if (opts.collider !== false) {
    const meshType = opts.collider ?? opts.mesh
    if (meshType) {
      const layer = opts.colliderLayer ?? (ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER)
      _applyCollider(e, meshType, layer)
    }
  }

  // ── 3D model ─────────────────────────────────────────────────────────────
  if (opts.gltf) GltfContainer.createOrReplace(e, { src: opts.gltf })

  // ── Billboard ────────────────────────────────────────────────────────────
  if (opts.billboard !== undefined) {
    Billboard.createOrReplace(e, { billboardMode: opts.billboard })
  }

  // ── Text ─────────────────────────────────────────────────────────────────
  if (opts.text !== undefined) _applyText(e, opts.text)

  // ── Audio ─────────────────────────────────────────────────────────────────
  if (opts.audio !== undefined) _applyAudio(e, opts.audio)

  // ── Trigger area ──────────────────────────────────────────────────────────
  if (opts.trigger !== undefined) _applyTrigger(e, opts.trigger)

  // ── Visibility ────────────────────────────────────────────────────────────
  // Only create VisibilityComponent when explicitly requested.
  // Absence of the component = visible by default in DCL.
  if (opts.visible === true || opts.visible === false) {
    VisibilityComponent.createOrReplace(e, { visible: opts.visible })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-creation component helpers
// ─────────────────────────────────────────────────────────────────────────────
//
// Use these to update a single component on an already-created entity without
// touching everything else. Equivalent to calling the raw SDK but with the
// same interface as EntityOpts.

/** Replace or add a MeshRenderer (primitive shape). */
export function setMesh(entity: Entity, type: MeshType): void {
  _applyMesh(entity, type)
}

/** Replace or add a GltfContainer (3D model). */
export function setModel(entity: Entity, src: string): void {
  GltfContainer.createOrReplace(entity, { src })
}

/** Replace or add a PBR material. */
export function updateMaterial(entity: Entity, opts: MaterialOpts): void {
  _applyMaterial(entity, opts)
}

/** Replace or add a MeshCollider. */
export function setCollider(
  entity: Entity,
  type: MeshType,
  layer: ColliderLayer = ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
): void {
  _applyCollider(entity, type, layer)
}

/** Remove the MeshCollider from an entity. */
export function removeCollider(entity: Entity): void {
  MeshCollider.deleteFrom(entity)
}

/** Update a TextShape value (and optionally style). */
export function updateText(entity: Entity, opts: TextOpts): void {
  _applyText(entity, opts)
}

/** Clear and hide a TextShape (sets text to empty string). */
export function clearText(entity: Entity): void {
  const ts = TextShape.getMutableOrNull(entity)
  if (ts) ts.text = ''
}

/** Move entity to a new world position (mutates existing Transform). */
export function setPosition(entity: Entity, pos: Vector3): void {
  const t = Transform.getMutableOrNull(entity)
  if (t) t.position = pos
  else Transform.createOrReplace(entity, { position: pos })
}

/** Set entity scale (mutates existing Transform). */
export function setScale(entity: Entity, s: Vector3): void {
  const t = Transform.getMutableOrNull(entity)
  if (t) t.scale = s
}

/** Set entity rotation (mutates existing Transform). */
export function setRotation(entity: Entity, rotation: Quaternion): void {
  const t = Transform.getMutableOrNull(entity)
  if (t) t.rotation = rotation
  else Transform.createOrReplace(entity, { rotation })
}

/** Reparent entity (mutates existing Transform). */
export function setParent(entity: Entity, parent: Entity | undefined): void {
  const t = Transform.getMutableOrNull(entity)
  if (t) t.parent = parent
  else Transform.createOrReplace(entity, { parent })
}

// ─────────────────────────────────────────────────────────────────────────────
// Visibility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show or hide an entity.
 *
 * If VisibilityComponent is already present, only the boolean is flipped.
 * If absent:
 *   • visible = true  → no-op (entity is already visible without the component)
 *   • visible = false → creates VisibilityComponent to hide the entity
 */
export function setVisible(entity: Entity, visible: boolean): void {
  const existing = VisibilityComponent.getOrNull(entity)
  if (existing !== null) {
    if (existing.visible !== visible) {
      VisibilityComponent.createOrReplace(entity, { visible })
    }
  } else if (!visible) {
    VisibilityComponent.createOrReplace(entity, { visible: false })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Click / hover API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make an entity clickable. The callback fires every frame a pointer-down
 * event is detected on this entity.
 *
 * Calling this again on the same entity replaces the previous callback.
 */
export function makeClickable(
  entity: Entity,
  hoverText: string,
  cb: ClickCb,
  maxDistance = 10
): void {
  clickRegistry.set(entity, { cb, text: hoverText, dist: maxDistance })
  syncPointerEvents(entity)
}

/** Remove the click handler from an entity. */
export function removeClickable(entity: Entity): void {
  clickRegistry.delete(entity)
  syncPointerEvents(entity)
}

/**
 * Register hover-enter / hover-leave callbacks for an entity.
 * `cb(entity, true)` = entered, `cb(entity, false)` = left.
 */
export function makeHoverable(
  entity: Entity,
  maxDistance: number,
  cb: HoverCb
): void {
  hoverRegistry.set(entity, { cb, dist: maxDistance })
  syncPointerEvents(entity)
}

/** Remove the hover handler from an entity. */
export function removeHoverable(entity: Entity): void {
  hoverRegistry.delete(entity)
  syncPointerEvents(entity)
}

/** Set (or update) an E-key (IA_PRIMARY) hint label on an entity. */
export function setEKeyHint(entity: Entity, text: string, dist: number, cb?: (entity: Entity) => void): void {
  eKeyRegistry.set(entity, { text, dist, cb: cb ?? (() => {}) })
  syncPointerEvents(entity)
}

/** Remove the E-key hint from an entity. */
export function clearEKeyHint(entity: Entity): void {
  eKeyRegistry.delete(entity)
  syncPointerEvents(entity)
}


/**
 * Re-apply PointerEvents from the registry to an entity.
 * Use this after re-adding a MeshCollider so that click/hover callbacks
 * (registered via makeClickable / makeHoverable) become active again.
 * Safe to call even if the entity has no registered handlers — in that case
 * PointerEvents is deleted from the entity.
 */
export function syncEntityPointerEvents(entity: Entity): void {
  syncPointerEvents(entity)
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity removal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove a single entity and clean up its click/hover registrations.
 * Does NOT remove children — use removeEntityAndChildren for parent nodes.
 */
export function removeEntity(entity: Entity): void {
  clickRegistry.delete(entity)
  hoverRegistry.delete(entity)
  eKeyRegistry.delete(entity)
  engine.removeEntity(entity)
}

/**
 * Walk up the parent chain and return true if `entity` is a descendant
 * of `ancestor`. Used by removeEntityAndChildren to clean registries for
 * clickable / hoverable children before the engine removes them all.
 */
function isDescendantOf(entity: Entity, ancestor: Entity): boolean {
  let cur: Entity = entity
  for (let depth = 0; depth < 16; depth++) {
    const t = Transform.getOrNull(cur)
    if (!t) break
    const parent = (t as any).parent as Entity | undefined
    if (!parent || parent === 0) break
    if (parent === ancestor) return true
    cur = parent
  }
  return false
}

/**
 * Remove entity AND all of its children recursively.
 * Also cleans click/hover registries for any registered descendants
 * (iterates only the small registry maps, not all scene entities).
 * Use this for any parent/root node (health bar root, grouped entities, etc.).
 * Without this, children remain as orphan entities until the scene reloads.
 */
export function removeEntityAndChildren(entity: Entity): void {
  clickRegistry.delete(entity)
  hoverRegistry.delete(entity)
  eKeyRegistry.delete(entity)
  // Also clean any descendant entities that have registered handlers.
  // Iterating only the (small) registry maps is faster than walking the full
  // entity tree — most scenes have far fewer interactive entities than total.
  for (const [e] of [...clickRegistry]) {
    if (isDescendantOf(e, entity)) clickRegistry.delete(e)
  }
  for (const [e] of [...hoverRegistry]) {
    if (isDescendantOf(e, entity)) hoverRegistry.delete(e)
  }
  for (const [e] of [...eKeyRegistry]) {
    if (isDescendantOf(e, entity)) eKeyRegistry.delete(e)
  }
  engine.removeEntityWithChildren(entity)
}


// ─────────────────────────────────────────────────────────────────────────────
// Audio helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Play a one-shot sound on an entity.
 * Replaces any existing AudioSource (including looping ones).
 */
export function playAudio(entity: Entity, src: string, volume = 1): void {
  AudioSource.createOrReplace(entity, {
    audioClipUrl: src,
    loop:         false,
    volume,
    playing:      true
  })
}

/** Stop audio playback on an entity (keeps the AudioSource component). */
export function stopAudio(entity: Entity): void {
  const a = AudioSource.getMutableOrNull(entity)
  if (a) a.playing = false
}

// ─────────────────────────────────────────────────────────────────────────────
// Specialised factory helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a trigger zone that fires callbacks when engine.PlayerEntity
 * enters, stays in, or exits the box.
 *
 * The entity's Transform.scale is set from `size` so the TriggerArea bounds
 * match. If you need a visual wrapper, parent this entity under a visible one.
 */
export function createTriggerZone(
  position: Vector3,
  size:     Vector3,
  opts: {
    parent?:   Entity
    onEnter?:  () => void
    onStay?:   () => void
    onExit?:   () => void
  } = {}
): Entity {
  return createEntity({
    parent:   opts.parent,
    position,
    scale:    size,
    collider: false,
    trigger: {
      size,
      onEnter: opts.onEnter,
      onStay:  opts.onStay,
      onExit:  opts.onExit
    }
  })
}

/**
 * Create an AvatarModifierArea (hides avatars, disables passports, etc.).
 *
 * NOTE: do NOT use Transform.scale for bounds — set bounds only via
 * AvatarModifierArea.area. Scaling the transform would affect parented children
 * and is ignored by the area in some SDK versions.
 */
export function createModifierArea(
  parent:    Entity | undefined,
  position:  Vector3,
  size:      Vector3,
  modifiers: AvatarModifierType[]
): Entity {
  const e = createEntity({ parent, position, collider: false })
  AvatarModifierArea.create(e, { area: size, modifiers, excludeIds: [] })
  return e
}

/**
 * Create a CameraModeArea that forces a specific camera mode inside a box.
 *
 * Same scale reasoning as createModifierArea — bounds via CameraModeArea.area.
 */
export function createCameraArea(
  parent:   Entity | undefined,
  position: Vector3,
  size:     Vector3,
  mode:     CameraType
): Entity {
  const e = createEntity({ parent, position, collider: false })
  CameraModeArea.create(e, { area: size, mode })
  return e
}

// ─────────────────────────────────────────────────────────────────────────────
// Timing helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fire `cb` once after `ms` milliseconds using an ECS system countdown.
 * Does not rely on native setTimeout — safe in DCL's QuickJS runtime.
 */
export function delay(ms: number, cb: () => void): void {
  let elapsed = 0
  function tick(dt: number) {
    elapsed += dt * 1000
    if (elapsed >= ms) {
      engine.removeSystem(tick)
      cb()
    }
  }
  engine.addSystem(tick)
}
