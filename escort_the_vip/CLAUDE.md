# Escort Game — проектний контекст

## Що це
Мультиплеєрна гра в Decentraland SDK7. Два проекти:
- `client/` — DCL сцена (SDK7, TypeScript, Colyseus клієнт)
- `server/` — Colyseus сервер (Node.js, TypeScript)

## Архітектура
- Сервер **авторитарний** — всі ігрові рішення на сервері
- Клієнт лише відображає стан і надсилає команди (`room.send(...)`)
- Синхронізація через `onStateChange` (Colyseus 0.17 CRDT)

## Команди
- **Bodyguards** — охороняють VIP, хочуть довести його до безпечної зони
- **Haters** — хочуть вбити VIP до закінчення часу

## Результати гри (winner / reason)
- `bodyguards` / `vip_safe` — VIP дійшов до безпечної зони
- `bodyguards` / `elimination` — всіх хейтерів усунуто
- `draw` / `timeout` — час вийшов, VIP живий але не дійшов (нічия)
- `haters` / `vip_killed` — VIP вбитий
- `haters` / `elimination` — всіх тілоохоронців усунуто

## Структура клієнта (client/src/)
```
src/
├── index.ts              — точка входу, підключення Colyseus, onStateChange
├── ui.tsx                — весь 2D HUD (React-ECS)
├── colyseus-client.ts    — підключення до сервера, sendToRoom, getRoom
├── polyfills.ts          — полiфіли для QuickJS
├── game/
│   ├── attachedItems.ts  — предмети прикріплені до аватара
│   ├── combatInput.ts    — клавіші E (дія/бомба) і F (захист)
│   ├── constants.ts      — GRID, TILE_SIZE, типи стін, tileToWorldX/Z
│   ├── healthBar.ts      — world-space HP бари (Billboard entities)
│   ├── maze.ts           — будова лабіринту, стіни, двері, бомби
│   ├── npcRenderer.ts    — VIP NPC (AvatarShape + vipHitBox)
│   ├── playerHitboxes.ts — hitbox-и ворожих гравців
│   └── screenEffects.ts  — hit-flash (червоне миготіння екрану)
├── state/
│   └── localState.ts     — клієнтський стан, patchLocalState
├── utils/
│   ├── adjacency.ts      — перевірки сусідства тайлів
│   ├── entityFactory.ts  — createEntity, makeClickable, removeEntity
│   └── transformUtils.ts — tweens, анімації стін/дверей
└── zones/
    ├── gameZone.ts       — ігрова арена (Y ≈ 15–18 м)
    ├── lobby.ts          — лобі (Y < 5 м)
    ├── spectatorZone.ts  — куб 4×4×4 у центрі лобі
    └── zoneTriggers.ts   — TriggerArea для зміни зон
```

## Зони
- `lobby` — Y < 5 м (стартова зона)
- `spectator` — куб 4×4×4 у центрі лобі (X=14–18, Z=14–18)
- `game` — Y ≈ 15–18 м, ігрова арена 32×32 м

## Куб у лобі (spectatorZone.ts)
- **Південь (Z=14)** — кнопки Join/Cancel/Spectate + статус гри
- **Північ (Z=18, зовні)** — дошка останніх 5 матчів
- **Захід (X=14, зовні)** — `❓ How to play` (3D TextShape) на темному фоні,
  клік відкриває/закриває UI-модалку `showHowToPlay`

## Hitbox архітектура

### Ворожі гравці (playerHitboxes.ts)
Два entity на кожного гравця протилежної команди:
- `physicsBox` — box 2×3×2, **CL_PHYSICS only** (не клікабельний).
  Прив'язаний до серверного тайлу. Блокує вхід на тайл ворога по кардинальних напрямках.
- `clickBox` — **циліндр** 0.8×2.0×0.8 (radius ≈ 0.4 м), **CL_POINTER only**.
  Щокадрово слідкує за реальним аватаром через `PlayerIdentityData`.
  Клік → `attack` якщо `isLocalNearTileDiag` (Chebyshev ≤ 1).

Гравці **однієї команди** не мають жодного hitbox — вони вільно проходять крізь союзників.

### VIP (npcRenderer.ts)
- `vipEntity` — AvatarShape, **без колайдера** (не штовхає гравців)
- `vipHitBox` — **циліндр** 0.8×2.0×0.8, поведінка залежить від команди:
  - Хейтер: `CL_POINTER | CL_PHYSICS` + клік → `attack_vip` (діапазон: `isLocalNearTileDiag`)
  - Бодігард: `CL_POINTER` + клік → `follow_vip` (діапазон: `isLocalNearTile`, кардинально)
  - Інші: `CL_POINTER`, не клікабельний

## Дальність атаки (adjacency.ts)
- `isLocalNearTile(col, row)` — кардинальне сусідство (dx+dy ≤ 1).
  Використовується для: взаємодія зі стінами/дверима, бодігард → `follow_vip`.
- `isLocalNearTileDiag(col, row)` — Chebyshev ≤ 1 (max(dx,dy) ≤ 1), всі 8 сусідів.
  Використовується для: атака гравців (`attack`), атака VIP хейтерами (`attack_vip`).
- `isLocalOnTile` — точний збіг тайлу.
- `isLocalAdjacentToWall` — перевірка для взаємодії зі стінами.

## VIP персона
- `npcRenderer.ts` — AvatarShape entity + vipHitBox (циліндр)
- VIP рухається анімовано між тайлами через чергу `_vipTileQueue` (easeOutQuad)
- При відставанні > 3 кроки — snap до актуальної позиції
- Зовнішній вигляд (outfit) — детермінований з індексів що приходять від сервера

## Лабіринт (maze.ts)
- 16×16 сітка тайлів (TILE_SIZE = 2 м)
- Типи стін: CONCRETE, HEDGE, METAL_WALL, WOOD_FENCE, METAL_DOOR, WOOD_DOOR
- Junction posts — бетонні стовпи на перетинах стін
- Двері анімовані (slide down/up)
- Бомби: armed = countdown overlay (сфера + таймер), unarmed = door-trap

## State management
- `localState.ts` — клієнтський стан (зона, команда, інвентар, фаза, HP, тощо)
- Завжди `patchLocalState({...})`, ніколи не мутувати напряму
- Сервер = джерело правди; `onStateChange` синхронізує localState

### Ключові поля localState
- `zone` — `'lobby'|'game'|'spectator'`
- `phase` — `'lobby'|'countdown'|'playing'|'ended'`
- `myTeam` — `'none'|'bodyguard'|'hater'`
- `myTileCol / myTileRow` — поточна позиція гравця (тайл)
- `myRightHand / myLeftHand` — `'none'|'sword'` / `'none'|'shield'|'bomb'`
- `myDefending` — режим захисту (F)
- `showHowToPlay` — чи відкрита модалка "How to Play"
- `activeBombs` — список активних бомб в арені
- `playerList` — список усіх гравців з HP для правої панелі

## UI (ui.tsx — React-ECS)
- **Топ-центр** — таймер, назва команди, інвентар, шкала щита, попередження про бомби
- **Топ-правий** — онлайн/пінг chip
- **Правий бік** — список гравців з HP-барами (bodyguards / VIP / haters)
- **Нижній центр** — HP-бар стіни при наведенні (`hoveredWallIdx`)
- **Нижній центр (вище)** — ephemeral toast (наприклад "Need bomb to break this hedge")
- **Центр екрану** — оверлей кінця гри (🏆 Bodyguards Win / ⭐ Haters Win / Draw!)
- **Модалка** — "How to Play" (відкривається кнопкою на кубі лобі, `showHowToPlay`)
- **Нижній правий** — керування спектатором (◀ / Next ▶ / ✕ Stop)
- **Повний екран** — червоний flash при отриманні удару (`screenEffects.ts`)

### Emoji в DCL
Тільки певні emoji рендеряться в DCL-шрифті. Підтверджено робочі:
`⭐` `🏆` `●` `○` `◀` `▶` `⚠` `✕` `❓`  
`▶` і `◀` рендеряться в `Button`, але **не** в `Label` — у `Label` вони з'являються як `▶  SECTION`.
`❓` видно в 3D TextShape на кубі, але **не** в 2D Label → використовуємо `?` у Label.

### Шкали HP гравців (game/healthBar.ts)
- World-space Billboard entities (завжди повернуті до камери)
- Структура: root → bg + fillRoot → fill + label + dmgLabel
- `upsertHealthBar(id, wx, wz, hp, maxHp, lastDmg, lastDmgTime, teamColor, name)`
- `removeHealthBar(id)`, `showHealthBar(id, visible)`

## Утиліти (utils/)

### entityFactory.ts — головний файл
Всі entity створюються через `createEntity(opts)`. Параметри:
- `position, rotation, scale, parent` — Transform
- `mesh` — `'box'|'sphere'|'cylinder'|'plane'`
- `material` — PBR параметри
- `collider` — форма або `false`; `colliderLayer` — шар колайдера
- `gltf` — шлях до GLB моделі
- `text` — TextShape параметри
- `trigger` — TriggerArea (onEnter/onStay/onExit)
- `billboard`, `audio`, `visible`

**Завжди** використовувати `removeEntity()` (не `engine.removeEntity()`) — очищає click/hover реєстри.

### adjacency.ts
- `isLocalNearTile` — кардинальне (dx+dy ≤ 1)
- `isLocalNearTileDiag` — Chebyshev (max(dx,dy) ≤ 1), для атак по діагоналі
- `isLocalOnTile` — точне співпадіння
- `isLocalAdjacentToWall(wallIdx)` — перевірка фланкуючих тайлів стіни

## Відомі особливості Colyseus 0.17
- `ArraySchema.onChange` не працює → diff вручну в `onStateChange`
- `MapSchema.onAdd/onRemove` ненадійні → теж diff вручну
- Nested string fields в `p.onChange` не завжди спрацьовують → дублюємо в `onStateChange`
