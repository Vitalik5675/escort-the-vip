/**
 * Sound Manager — централізоване управління звуками гри.
 *
 * ── Ключові факти про DCL SDK7 AudioSource ────────────────────────────────
 *
 * ❌ CRDT bug: playing=false → playing=true в одному ECS-фреймі НЕ ПРАЦЮЄ.
 *    CRDT надсилає лише ОСТАННІЙ стан за фрейм → рендер бачить true→true,
 *    нічого не змінилось, звук не перезапускується.
 *    Рішення: AudioSource.createOrReplace() — завжди маркує компонент як
 *    "dirty" і примусово надсилає подію до рендера незалежно від попереднього стану.
 *
 * ❌ Просторовий звук: AudioSource є spatial за замовчуванням (затихає з відстанню).
 *    При entity в центрі сцени (16,10,16) гравець на краю арени чує значно тихше.
 *    Рішення: global:true — однакова гучність з будь-якої точки сцени.
 *
 * ✅ Пул entity: entity створюються ОДИН РАЗ у initSounds(). playSound() викликає
 *    createOrReplace на вже існуючому entity — не створює нових сутностей.
 *
 * ── Зональна фільтрація ───────────────────────────────────────────────────
 *
 * Кожен звук має категорію зони (SoundZone):
 *
 *   'game'  — ігрові звуки: чуються у ВСІХ зонах (лобі, глядачі, гра).
 *             Всі бойові звуки, вибухи, двері, бомби, кінець гри тощо.
 *
 *   'lobby' — лобі-звуки: чуються ТІЛЬКИ в зоні лобі (zone === 'lobby').
 *             Кнопки куба, лобі-ambient. Глядачі і гравці ці звуки не чують.
 *
 * Поточна зона задається через setAudioZone() при кожній зміні zone.
 * index.ts містить ECS-систему що слідкує за localState.zone і викликає
 * setAudioZone() + керує запуском/зупинкою lobby_ambient loop.
 */

import { engine, Entity, AudioSource, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

// ─────────────────────────────────────────────────────────────────────────────
// Sound catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 'game'  — грає у всіх зонах (лобі, глядачі, гра).
 * 'lobby' — грає ТІЛЬКИ у зоні лобі.
 */
export type SoundZone = 'game' | 'lobby'

export type SoundName =
  // ── Бойові ──────────────────────────────────────────────────────────────
  | 'hit'            // удар кулаком/зброєю по гравцю
  | 'bush_hit'       // удар по кущу / hedge стіні
  | 'explosion'      // вибух бомби

  // ── Бомби ───────────────────────────────────────────────────────────────
  | 'bomb_place'     // бомба закладена
  | 'bomb_countdown' // тікання таймера (loop)

  // ── Двері ───────────────────────────────────────────────────────────────
  | 'door_open'      // двері відкриваються
  | 'door_close'     // двері закриваються
  | 'door_lock'      // двері замикаються (VIP-кімната)

  // ── UI / кнопки ──────────────────────────────────────────────────────────
  | 'button_click'   // кнопки куба у лобі (Join / Cancel / Spectate)

  // ── Ігрові події ────────────────────────────────────────────────────────
  | 'game_start'
  | 'game_end_win'
  | 'game_end_lose'
  | 'vip_safe'

  // ── VIP голосові лінії ───────────────────────────────────────────────────
  | 'vip_help'       // "Heeeelp! Is security on a coffee break?"
  | 'vip_spotted'    // "Hey hey! I heard you! Who are you?"
  | 'vip_complain'   // "I don't know why I pay for security"

  // ── Команди ─────────────────────────────────────────────────────────────
  | 'radio_check'
  | 'suspicious'
  | 'security'       // security response voice line (alternates with vip_help)

  // ── Лобі ambient (loop) ──────────────────────────────────────────────────
  | 'lobby_ambient'  // фоновий звук лобі; запускається/зупиняється системою в index.ts

interface SoundConfig {
  src:    string    // шлях відносно кореня client/
  volume: number    // 0–1
  pool:   number    // кількість entity (pool>1 → звуки можуть накладатись)
  zone:   SoundZone // 'game' = всі зони; 'lobby' = тільки лобі
}

const SOUNDS: Record<SoundName, SoundConfig> = {
  // ── Бойові ('game' → всі зони чують) ─────────────────────────────────────
  // pool=3: кілька гравців б'ються одночасно
  hit:           { src: 'sounds/fist.mp3',             volume: 1.0, pool: 3, zone: 'game' },
  bush_hit:      { src: 'sounds/bush.mp3',             volume: 1.0, pool: 2, zone: 'game' },
  explosion:     { src: 'sounds/bomb_explosion_2.mp3', volume: 1.0, pool: 2, zone: 'game' },

  bomb_place:    { src: 'sounds/button_click_new.mp3', volume: 1.0, pool: 1, zone: 'game' },
  bomb_countdown:{ src: 'sounds/bomb_countdown.mp3',   volume: 1.0, pool: 1, zone: 'game' },

  door_open:     { src: 'sounds/opening_door.mp3',     volume: 1.0, pool: 2, zone: 'game' },
  door_close:    { src: 'sounds/closing_door.mp3',     volume: 1.0, pool: 2, zone: 'game' },
  door_lock:     { src: 'sounds/locking_door.mp3',     volume: 1.0, pool: 1, zone: 'game' },

  game_start:    { src: 'sounds/radio_check.mp3',      volume: 1.0, pool: 1, zone: 'game' },
  game_end_win:  { src: 'sounds/game_end_win.mp3',     volume: 1.0, pool: 1, zone: 'game' },
  game_end_lose: { src: 'sounds/game_end_lose.mp3',    volume: 1.0, pool: 1, zone: 'game' },
  vip_safe:      { src: 'sounds/game_end_win.mp3',     volume: 1.0, pool: 1, zone: 'game' },

  vip_help:      { src: 'sounds/vip_help.mp3',         volume: 1.0, pool: 1, zone: 'game' },
  vip_spotted:   { src: 'sounds/vip_spotted.mp3',      volume: 1.0, pool: 1, zone: 'game' },
  vip_complain:  { src: 'sounds/vip_complain.mp3',     volume: 1.0, pool: 1, zone: 'game' },

  radio_check:   { src: 'sounds/radio_check.mp3',      volume: 1.0, pool: 1, zone: 'game' },
  suspicious:    { src: 'sounds/suspicious.mp3',        volume: 1.0, pool: 1, zone: 'game' },
  security:      { src: 'sounds/security.mp3',          volume: 1.0, pool: 1, zone: 'game' },

  // ── Лобі-звуки ('lobby' → тільки зона лобі) ──────────────────────────────
  // button_click: кнопки Join/Cancel/Spectate на кубі у лобі.
  // Глядачі (zone='spectator') фізично стоять у лобі, але їх zone≠'lobby',
  // тому вони ці кнопки не чують — поведінка відповідає вимозі "spectator = тільки game".
  button_click:  { src: 'sounds/button_click_new.mp3', volume: 1.0, pool: 1, zone: 'lobby' },

  // lobby_ambient: фоновий ambient лобі. Запуск/зупинка — через loopSound/stopSound
  // у zone-tracking системі в index.ts. Сам звук global=true (рівна гучність),
  // але грає лише коли zone==='lobby'.
  // 📝 Замінити src на власний ambient файл за потреби.
  lobby_ambient: { src: 'sounds/security.mp3',         volume: 0.18, pool: 1, zone: 'lobby' },
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state
// ─────────────────────────────────────────────────────────────────────────────

const _pools = new Map<SoundName, { entities: Entity[]; cursor: number }>()
let _initialized = false

/**
 * Поточна зона гравця. Оновлюється через setAudioZone() з index.ts.
 * Початкове значення 'lobby' — гравці стартують у лобі.
 */
let _currentZone: string = 'lobby'

// ─────────────────────────────────────────────────────────────────────────────
// Zone control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Оновлює поточну зону звукового менеджера.
 * Викликається з ECS-системи в index.ts при кожній зміні localState.zone.
 *
 * Після виклику:
 *  - playSound/loopSound з zone='lobby' будуть заблоковані якщо zone ≠ 'lobby'
 *  - playSound/loopSound з zone='game' проходять завжди
 */
export function setAudioZone(zone: string): void {
  _currentZone = zone
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Створює entity для кожного звуку. Викликати ОДИН РАЗ у main().
 * Entity без AudioSource — компонент додається при першому playSound().
 */
export function initSounds(): void {
  if (_initialized) return
  _initialized = true

  for (const [name, cfg] of Object.entries(SOUNDS) as [SoundName, SoundConfig][]) {
    const entities: Entity[] = []
    for (let i = 0; i < cfg.pool; i++) {
      const e = engine.addEntity()
      // Transform потрібен щоб entity була валідною; global=true → позиція не впливає
      Transform.create(e, { position: Vector3.create(16, 1, 16) })
      entities.push(e)
    }
    _pools.set(name, { entities, cursor: 0 })
  }

  const total = [...Object.values(SOUNDS)].reduce((s, c) => s + c.pool, 0)
  console.log(`[SoundManager] Ready — ${Object.keys(SOUNDS).length} sounds, ${total} entities`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal zone check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Повертає true якщо звук дозволено відтворювати в поточній зоні.
 *
 * Правила:
 *   zone='game'  → дозволено завжди (лобі, глядачі, гра — всі чують)
 *   zone='lobby' → дозволено тільки коли _currentZone === 'lobby'
 */
function _zoneAllowed(cfg: SoundConfig): boolean {
  if (cfg.zone === 'game') return true
  return _currentZone === 'lobby'
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Відтворює звук один раз.
 *
 * Використовує AudioSource.createOrReplace() — єдиний надійний спосіб
 * перезапустити звук у DCL SDK7. Мутація playing=false→true в одному фреймі
 * не працює (CRDT надсилає лише останній стан, рендер не бачить зміни).
 *
 * Повертає false і мовчки ігнорує виклик якщо звук заблокований поточною зоною.
 */
export function playSound(name: SoundName, volume?: number): boolean {
  const pool = _pools.get(name)
  if (!pool) { console.error(`[SoundManager] Unknown: ${name}`); return false }

  const cfg = SOUNDS[name]

  // ── Зональна фільтрація ───────────────────────────────────────────────────
  if (!_zoneAllowed(cfg)) return false

  const entity = pool.entities[pool.cursor]
  pool.cursor = (pool.cursor + 1) % pool.entities.length

  AudioSource.createOrReplace(entity, {
    audioClipUrl: cfg.src,
    loop:         false,
    volume:       volume ?? cfg.volume,
    playing:      true,
    global:       true,   // чутно однаково з будь-якої точки сцени
  })
  return true
}

/**
 * Зупиняє всі entity вказаного звуку.
 * Для зупинки loop (bomb_countdown, lobby_ambient) достатньо однієї мутації
 * playing=false — це ЗМІНА стану (true→false), рендер її бачить.
 * stopSound НЕ перевіряє зону — зупинка завжди дозволена.
 */
export function stopSound(name: SoundName): void {
  const pool = _pools.get(name)
  if (!pool) return
  for (const e of pool.entities) {
    const a = AudioSource.getMutableOrNull(e)
    if (a) a.playing = false
  }
}

/**
 * Грає звук у loop. Зупинити через stopSound(name).
 * Так само як playSound — перевіряє зональну фільтрацію.
 */
export function loopSound(name: SoundName, volume?: number, pitch?: number): boolean {
  const pool = _pools.get(name)
  if (!pool) return false

  const cfg = SOUNDS[name]

  // ── Зональна фільтрація ───────────────────────────────────────────────────
  if (!_zoneAllowed(cfg)) return false

  const entity = pool.entities[0]

  AudioSource.createOrReplace(entity, {
    audioClipUrl: cfg.src,
    loop:         true,
    volume:       volume ?? cfg.volume,
    pitch:        pitch ?? 1.0,
    playing:      true,
    global:       true,
  })
  return true
}

/**
 * Відтворює випадкову VIP репліку.
 * VIP-репліки мають zone='game' → чуються у всіх зонах.
 */
export function playRandomVipLine(): void {
  const lines: SoundName[] = ['vip_help', 'vip_spotted', 'vip_complain']
  playSound(lines[Math.floor(Math.random() * lines.length)])
}
