# Client — детальний контекст

Читай також `../CLAUDE.md` для загального огляду проекту.

## Структура src/
```
src/
├── index.ts              ← main(), всі Colyseus callbacks, ECS systems
├── ui.tsx                ← весь React-ECS HUD (2D overlay)
├── polyfills.ts          ← має бути першим імпортом
├── colyseus-client.ts    ← підключення, sendToRoom, getRoom
├── state/
│   └── localState.ts     ← клієнтський стан, patchLocalState
├── game/
│   ├── constants.ts      ← TILE_SIZE, GAME_ZONE_Y, tileToWorldX/Z, wallSidesTiles
│   ├── maze.ts           ← buildMaze, syncWall, syncItems, бомби, junction posts
│   ├── npcRenderer.ts    ← VIP avatar + hitboxes
│   ├── playerHitboxes.ts ← enemy hitboxes (physicsBox + clickBox)
│   ├── attachedItems.ts  ← зброя в руках аватарів (AvatarAttach)
│   ├── combatInput.ts    ← E/F клавіші (InputAction.IA_PRIMARY/SECONDARY)
│   ├── healthBar.ts      ← world-space HP бари над ворогами (Billboard)
│   └── screenEffects.ts  ← hit flash (червоне мерехтіння екрану)
├── utils/
│   ├── entityFactory.ts  ← createEntity, removeEntity, makeClickable, delay...
│   ├── transformUtils.ts ← tweens, followRoute, animateWallRise/DoorSlide
│   └── adjacency.ts      ← isLocalNearTile, isLocalNearTileDiag, isLocalAdjacentToWall
└── zones/
    ├── lobby.ts          ← buildLobby (ground + pillars)
    ├── spectatorZone.ts  ← куб + кнопки Join/Cancel/Spectate + How to Play
    ├── gameZone.ts       ← арена + стіни + AvatarModifierArea + CameraArea
    └── zoneTriggers.ts   ← TriggerArea Enter/Stay/Exit для зон
```

## Критичні правила коду

### Entity creation
```typescript
// ✅ Завжди так:
const e = createEntity({ position, mesh: 'box', material: {...}, collider: 'box' })

// ❌ Ніколи напряму (крім AvatarAttach якому не потрібен Transform):
const e = engine.addEntity()
```

### Entity removal
```typescript
// ✅ Завжди removeEntity (очищає click/hover реєстри):
removeEntity(myEntity)
removeEntityAndChildren(rootEntity)   // якщо є parented діти

// ❌ Ніколи напряму (залишає сміття в реєстрах):
engine.removeEntity(myEntity)
```

### Клік / hover
```typescript
makeClickable(entity, 'Hover text', () => { ... }, maxDistance)
makeHoverable(entity, maxDistance, (e, entering) => { ... })
// При видаленні entity — removeEntity автоматично чистить обидва реєстри
```

## Hitbox архітектура

### Ворожі гравці (playerHitboxes.ts)
Два entity на кожного гравця протилежної команди:
- `physicsBox` — box 2×3×2, **CL_PHYSICS only** (не клікабельний).
  Прив'язаний до серверного тайлу. Блокує вхід на тайл ворога по кардинальних напрямках.
- `clickBox` — **циліндр** scale (0.8, 2.0, 0.8), **CL_POINTER only**.
  Щокадрово слідкує за реальним аватаром через `PlayerIdentityData`.
  Клік → `attack` якщо `isLocalNearTileDiag` (Chebyshev ≤ 1).

Гравці **однієї команди** не мають жодного hitbox — вільно проходять крізь союзників.

### VIP (npcRenderer.ts)
- `vipEntity` — AvatarShape, без колайдера (не штовхає гравців)
- `vipHitBox` — **циліндр** scale (0.8, 2.0, 0.8), поведінка залежить від команди:
  - Хейтер: `CL_POINTER | CL_PHYSICS` + клік → `attack_vip` (діапазон: `isLocalNearTileDiag`)
  - Бодігард: `CL_POINTER` + клік → `follow_vip` (діапазон: `isLocalNearTile`)
  - Інші: `CL_POINTER`, не клікабельний

## Дальність атаки (adjacency.ts)
- `isLocalNearTile(col, row)` — dx+dy ≤ 1 (4 кардинальних сусіди).
  Використовується для: стіни/двері, бодігард → `follow_vip`.
- `isLocalNearTileDiag(col, row)` — max(dx,dy) ≤ 1 (всі 8 сусідів включно з діагоналями).
  Використовується для: атака гравців (`attack`), атака VIP хейтерами (`attack_vip`).
- `isLocalOnTile(col, row)` — точне співпадіння тайлу.
- `isLocalAdjacentToWall(wallIdx)` — перевірка для взаємодії зі стінами.

## Серверні повідомлення (room.send)
| Команда | Параметри | Опис |
|---------|-----------|------|
| `player_tile` | `{col, row}` | позиція гравця кожні 0.5с |
| `attack` | `{targetId}` | атака ворожого гравця (Chebyshev ≤ 1) |
| `attack_vip` | `{}` | атака VIP (хейтери, Chebyshev ≤ 1) |
| `attack_wall` | `{wallIdx}` | атака стіни |
| `interact_door` | `{wallIdx}` | відчинити/зачинити двері |
| `pickup_item` | `{key}` | підібрати предмет |
| `place_bomb` | `{wallIdx?}` | поставити бомбу |
| `pickup_bomb` | `{key}` | підібрати пастку-бомбу |
| `toggle_defend` | `{defending}` | захисна стійка (F) |
| `join_game` | `{}` | вступити в чергу |
| `cancel_join` | `{}` | вийти з черги |
| `spectate` | `{}` | режим спостерігача |
| `stop_spectate` | `{}` | вийти зі спостереження |
| `follow_vip` | `{}` | наказ VIP слідувати (бодігард, кардинальна дальність) |

## Фази гри
`lobby` → `countdown` → `playing` → `ended` → `lobby`

## Результати гри (winner / reason)
| winner | reason | Відображення |
|--------|--------|--------------|
| `bodyguards` | `vip_safe` | 🏆 Bodyguards Win! — VIP safely reached the safe zone |
| `bodyguards` | `elimination` | 🏆 Bodyguards Win! — All haters were eliminated |
| `draw` | `timeout` | Draw! — Time ran out — VIP survived but never reached the safe zone |
| `haters` | `vip_killed` | ⭐ Haters Win! — VIP was eliminated |
| `haters` | `elimination` | ⭐ Haters Win! — All bodyguards were eliminated |

## UI (ui.tsx)

### Компоненти
- **Топ-центр** — таймер, назва команди, інвентар (R/L), щит HP, попередження про бомби
- **Топ-правий** — онлайн / пінг chip
- **Правий бік** — список гравців з HP-барами (Bodyguards / ⭐ VIP / Haters)
- **Нижній центр** — HP-бар стіни при наведенні (`hoveredWallIdx`)
- **Нижній центр (вище)** — ephemeral toast ("Need bomb to break this hedge" тощо)
- **Центр екрану** — оверлей кінця гри (з emoji, кольором і причиною)
- **Модалка** — "How to Play" (`showHowToPlay`), відкривається кнопкою на кубі лобі
- **Нижній правий** — керування спектатором (◀ / Next ▶ / ✕ Stop)
- **Повний екран** — червоний flash при ударі (`screenEffects.ts` → `getFlashAlpha()`)

### Emoji в DCL
Тільки певні emoji рендеряться в DCL-шрифті:
- **Підтверджено** в TextShape (3D) і Label (2D): `⭐` `🏆` `●` `○` `⚠` `✕` `❓`
- **Підтверджено** тільки в `Button` (не в `Label`): `◀` `▶`
- У `Label` замість `◀▶` використовується текст — у секціях модалки: `▶  BODYGUARDS` тощо
- `❓` видно в 3D TextShape; у `Label` — замінено на звичайний `?`

## Куб у лобі (spectatorZone.ts)
- **Південь** (Z≈14, зовні) — кнопки Join / Cancel / Spectate + статус гри
- **Північ** (Z≈18, зовні) — дошка останніх 5 матчів (`🏆 Last matches`)
- **Захід** (X≈14, зовні) — темний фон + TextShape `How to play ❓`; клік → `showHowToPlay = !showHowToPlay`

Ротація тексту на стінах куба (DCL ліворучна Y-ось):
- Північ (text faces +Z): `Quaternion.fromEulerDegrees(0, 180, 0)`
- Захід (text faces −X): `Quaternion.fromEulerDegrees(0, 90, 0)`

## Координати
- Одна плитка = 2×2 м (`TILE_SIZE = 2`)
- Ігрова зона = Y ≈ 15 м (`GAME_ZONE_Y`)
- `tileToWorldX(col)` = `(col + 0.5) * TILE_SIZE`
- `tileToWorldZ(row)` = `(row + 0.5) * TILE_SIZE`
- Стіни: 480 = 240 горизонтальних (H) + 240 вертикальних (V)
  - `H_WALL_COUNT = (GRID_ROWS-1) * GRID_COLS` = 15×16 = 240
  - `V_WALL_COUNT = GRID_ROWS * (GRID_COLS-1)` = 16×15 = 240
