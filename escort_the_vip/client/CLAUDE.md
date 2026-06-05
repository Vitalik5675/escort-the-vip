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
│   ├── constants.ts      ← TILE_SIZE=2, GAME_ZONE_Y=15, WALL_HEIGHT=2.5
│   ├── maze.ts           ← buildMaze, syncWall, syncItems, бомби, junction posts
│   ├── npcRenderer.ts    ← VIP avatar + hitbox; ANIM_BASE_MS=850
│   ├── playerHitboxes.ts ← enemy hitboxes (physicsBox + clickBox)
│   ├── attachedItems.ts  ← зброя в руках аватарів (AvatarAttach)
│   ├── combatInput.ts    ← E/F клавіші (IA_PRIMARY/SECONDARY)
│   ├── healthBar.ts      ← world-space HP бари над ворогами (Billboard)
│   ├── lightEffects.ts   ← VIP beacon + stripe colours
│   └── screenEffects.ts  ← hit flash (червоне мерехтіння)
├── audio/
│   ├── soundManager.ts   ← sound pool, playSound/stopSound/loopSound
│   └── vipAudio.ts       ← 3-tier proximity ambient system
├── utils/
│   ├── entityFactory.ts  ← createEntity, removeEntity, makeClickable, setEKeyHint
│   ├── transformUtils.ts ← tweens, door slide, wall rise animations
│   └── adjacency.ts      ← isLocalNearTile, isLocalNearTileDiag, isLocalAdjacentToWall
└── zones/
    ├── lobby.ts          ← buildLobby (ground + pillars)
    ├── spectatorZone.ts  ← куб + кнопки Join/Cancel/Spectate + How to Play
    ├── gameZone.ts       ← арена + AvatarModifierArea + CameraArea (add/remove)
    └── zoneTriggers.ts   ← TriggerArea Enter/Stay/Exit для зон
```

## Підключення до сервера
- Endpoint: `const SERVER_URL` у `index.ts:32` (захардкоджений `wss://<your-domain>`)
- Auth: `POST /auth { userId, displayName }` → `{ token }` → `client.auth.token = token` (надсилається як `Authorization: Bearer …`)
- Room name: `game_room`
- Reconnect: 3 швидкі ретраї по 8с, далі повільні по 30с; health-check кожні 5с (ping + DEAD_PONG_MS=15с)
- DCL-specific fetch fixes (`_dclFetch` у `colyseus-client.ts`): Headers→plain object, .blob() стаб, credentials='omit', .headers.get() wrap

## CameraArea (gameZone.ts) — add/remove component
Host-entity створюється раз у `buildGameZone()` із одним Transform (без CameraModeArea). Сам компонент перемикається через `applySceneConfig(firstPerson, roofPhysics)`:

| firstPerson | Дія | Ефект |
|---|---|---|
| `true`  | `CameraModeArea.createOrReplace(entity, { area, mode: CT_FIRST_PERSON })` | Камера блокується в перше особі коли аватар в арені |
| `false` | `CameraModeArea.deleteFrom(entity)` | Компонент видалено — камера вільна |

Це **стандартний DCL SDK7 ECS патерн** (див. [sdk-skills/camera-control](https://github.com/decentraland/sdk-skills/tree/main/camera-control)). `deleteFrom` ідемпотентна (no-op якщо компоненту немає), тому виклики безпечні в будь-якому порядку. До першого `scene_config` повідомлення CameraModeArea на entity немає → камера НЕ примусова.

Roof collider (`_roofEntity`): `MeshCollider.setBox(...)` перевизначається на тому самому entity без потреби в add/remove.

## Критичні правила коду

### Entity creation / removal
```typescript
// ✅ Завжди так:
const e = createEntity({ position, mesh: 'box', material: {...}, collider: 'box' })
removeEntity(myEntity)            // очищає click/hover реєстри
removeEntityAndChildren(root)     // якщо є parented діти

// ❌ Ніколи напряму:
engine.addEntity()
engine.removeEntity(myEntity)
```

### Клік / hover / E-key
```typescript
makeClickable(entity, 'Hover text', () => { ... }, maxDistance)
makeHoverable(entity, maxDistance, (e, entering) => { ... })
setEKeyHint(entity, 'Label', dist, callbackFn?)  // E-key label + optional callback
```

## Hitbox архітектура

### Ворожі гравці (playerHitboxes.ts)
- `physicsBox` — box 2×3×2, **CL_PHYSICS only**. Прив'язаний до серверного тайлу. Створюється **тільки для ворогів**.
- `clickBox` — циліндр 0.8×2.0×0.8, **CL_POINTER only**. Слідкує за реальним аватаром.
  Клік → `attack` якщо `isLocalNearTileDiag` (Chebyshev ≤ 1).
- **Same-team:** жодного hitbox-а (`upsertEnemyHitbox` робить `removeEnemyHitbox` для allies). Союзники проходять одне крізь одне.

### VIP (npcRenderer.ts)
- `vipEntity` — AvatarShape, без колайдера
- `vipHitBox` — циліндр 0.8×2.0×0.8:
  - Хейтер: `CL_POINTER|CL_PHYSICS` + клік → `attack_vip` (Chebyshev ≤ 1)
  - Бодігард: `CL_POINTER` + клік → `follow_vip` (кардинальна дальність ≤ 1)

### Предмети на плитці (maze.ts)
- **Дубинка**: box 0.45×0.6×0.45, `CL_POINTER` only
- **Щит**: plane 0.75×1.0, `CL_POINTER` only
- **Бомба**: box 0.6×0.6×0.6, `CL_POINTER` only, зміщена до центру візуалу (Z = -S/2)

## Дальність взаємодії (adjacency.ts)
- `isLocalNearTile` — dx+dy ≤ 1 (4 кардинальні сусіди): стіни, `follow_vip`
- `isLocalNearTileDiag` — max(dx,dy) ≤ 1 (8 сусідів + діагоналі): атаки, `attack_vip`
- `isLocalOnTile` — точне співпадіння тайлу: підбір пастки-бомби
- `isLocalAdjacentToWall` — перевірка для взаємодії зі стінами

## Команди клієнт → сервер (room.send)
| Команда | Параметри | Опис |
|---------|-----------|------|
| `player_tile` | `{col, row}` | позиція гравця кожні 0.5с |
| `attack` | `{targetId}` | атака ворожого гравця |
| `attack_vip` | `{}` | атака VIP (хейтери) |
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
| `follow_vip` | `{}` | наказ VIP слідувати (бодігард) |
| `ping` / `report_ping` | `{timestamp}` / `{ms}` | keepalive (надсилається з `colyseus-client.ts`) |

## Повідомлення сервер → клієнт (room.onMessage у index.ts)
| Повідомлення | Дані | Що клієнт робить |
|-------------|------|----------|
| `welcome` | `{sessionId, phase}` | (handler присутній — наразі no-op, sessionId з room.sessionId) |
| `scene_config` | `{firstPerson, roofPhysics}` | `applySceneConfig` → переміщує CameraArea entity + перевизначає roof collider. Може приходити mid-session при кожному hot-reload `config.json` (у будь-якій фазі, включно з `playing`). |
| `maze_rebuild` | `{wallTypes, wallStates, wallHP, wallMaxHP, templateId, vipRoomTiles, vipRoomDoors, safetyTiles, vipRoomLocked}` | повна перебудова лабіринту (onJoin + перед кожним матчем) |
| `teleport` | `{x,y,z, cx?,cy?,cz?, spectating?}` | `movePlayerTo` + опційно поворот камери; також керує переходом lobby↔game↔spectator |
| `pong` | `{timestamp}` | оновлює last-pong для health-check, шле `report_ping` назад |
| `hit` | `{damage, attackerId?, shield?, blocked?}` | screen flash, звук удару |
| `hit_sound` | `{col, row}` | broadcast звуку (без HP-зміни локального гравця) |
| `bomb_placed` | `{col, row}` | візуал бомби з fuse-таймером |
| `bomb_explode` | `{col, row}` | вибух-ефект, звук |
| `attack_blocked` | `{reason}` | toast із поясненням (наприклад `Need bomb to break this hedge`) |
| `vip_door_unlocked` | `{wallIdx}` | (handler присутній, no-op — двері оновлюються через `wallStates` дифи) |
| `vip_door_crossed` | `{wallIdx}` | `flashVipDoorCross` — короткий візуальний ефект |
| `game_ended` | `{winner, reason}` | оверлей кінця гри |
| `you_died` | `{killerId}` | перехід у spectate-mode з прив'язкою до killer-а |

## Візуальні індикатори VIP

### Циліндр-маяк (lightEffects.ts)
Колір = стан здоров'я VIP:
- **Жовтий** — HP > 66%
- **Оранжевий** — HP 33–66%
- **Червоний** — HP < 33%

### Стрічки на бетонних стінах і колонах (syncStripeColor)
Колір = небезпека для VIP:
- **Білий** — немає хейтерів поруч
- **Жовтий** — хейтер у радіусі ≤6 плиток
- **Оранжевий** — хейтер у радіусі ≤3 плиток
- **Червоний (3 сек)** — хейтер щойно вдарив VIP
- **Золото** — VIP неактивна (лобі/закінчення)

## Safety-zone beacon (lightEffects.ts)
Зелений світний бокс над центром safety-зони (висота = `VIP_BEACON_HEIGHT_M`, ~20 м). Створюється у `configureSafetyBeacon(tiles)` з `maze.ts:setSafetyTiles` (тобто на кожен `maze_rebuild`). Видимість обчислюється у `updateSafetyBeacon(inp)` що викликається з `engine.addSystem` у `index.ts` кожен tick.

**Правила видимості** (OR, досить одного):
| Правило | Умова | Хто бачить |
|---|---|---|
| 1 | `phase==='playing'` AND `timeRemaining ≤ 120с` (2 хв) | усі |
| 2 | `phase==='playing'` AND союзник стоїть на safety-tile | гравці тієї команди |
| 3 | `phase==='playing'` AND `mySessionId === vipFollowerId` AND `timeRemaining ≤ 180с` (3 хв) | поточний ескорт VIP |

`anyAllyInSafetyZone(team, players)` у `maze.ts` обчислює правило 2 — використовує `_safetyTileKeys` Set збережений з `setSafetyTiles`.

Поза `phase='playing'` бокс прихований.

## Звукова система VIP (vipAudio.ts)
3-тирна система на основі близькості хейтерів:

| Тир | Звуки | Радіус | Інтервал |
|-----|-------|--------|---------|
| 0 — спокій | `vip_complain`, `radio_check` | — | 20 сек (старт через 5 сек) |
| 1 — попередження | `vip_spotted`, `suspicious` | ≤6 плиток | 20 сек |
| 2 — небезпека | `vip_help`, `security` | ≤3 плитки | 10 сек |

Глобальний `_anyPlaying = 5 сек` після кожного програвання запобігає перекриттю.
Нові звуки не починаються в останні 15 секунд матчу.

## Система E-key (entityFactory.ts + maze.ts)
E-key реєстрація через `setEKeyHint(entity, text, dist, cb?)`.
Виклики перевіряються через `getInputCommand(IA_PRIMARY, PET_DOWN, entity)` в ECS-системі.
Пріоритет у `combatInput.ts`:
1. Вихід з захисної стійки (якщо `s.myDefending`)
2. Порожній простір + бомба → `place_bomb`
3. Callback стіни (через `makeWallEKeyCallback`) → захоплює E через `consumeWallEKey()`

HP-умовні підказки (`maze.ts`):
- Hedge бейсбольна: лише коли HP < 50%
- Рука на hedge: лише коли HP < 25%
- Рука на door: лише коли HP < 50%

## Куб у лобі (spectatorZone.ts)
- **Центр** (Z=26, зовні) — кнопки Join / Cancel / Spectate + статус гри
- **Схід** (Z=26, справа) — `🏆 Last matches` дошка
- **Захід** (Z=26, зліва) — `How to play ❓` (клік → `showHowToPlay`)

Глядачі телепортуються всередину боксу: `(16, 1.1, 27)`.
Бокс: центр (16, 2, 28), розмір 16×4×4, діапазон Z=26..30.

## Площини в лобі (lobby.ts)
- **Права стіна** (X=27.79, Z=16): `lobbyImagePlane` — великий банер 24×11 м.
- **Ліва стіна** (X=4): 4 площини `lobbyLeftPlane1..4`, центри по Z = 7, 13, 19, 25 м (кожна 6×3.5 м, перекривають весь діапазон Z=4..28 між кутовими колонами).

**Клік-логіка ліворучних площин:**
- `colliderLayer = CL_PHYSICS | CL_POINTER` — щоб raycast міг ловити клік.
- `makeClickable(plane, 'Click to view', () => toggleLobbyImage(texture), 12)` — при кліку викликає `toggleLobbyImage(texturePath)` у lobby.ts.
- `toggleLobbyImage(t)`: якщо `localState.lobbyImageModalUrl === t` → закриває (`''`), інакше відкриває з цією текстурою.
- `LobbyImageModal` у ui.tsx рендериться поверх усього коли `s.lobbyImageModalUrl !== ''`; backdrop + сам бокс + кнопка ✕ — будь-який клік закриває модалку (через `patchLocalState({ lobbyImageModalUrl: '' })`).
- Зображення рендериться через `uiBackground={{ texture: { src: url }, textureMode: 'stretch' }}` у боксі 980×660 px.

## Координати
- 1 плитка = 2×2 м (`TILE_SIZE = 2`)
- Ігрова зона: Y=15 м (`GAME_ZONE_Y`), висота стін 2.5 м (`WALL_HEIGHT`)
- `tileToWorldX(col)` = `(col + 0.5) * 2`
- `tileToWorldZ(row)` = `(row + 0.5) * 2`
- Стіни: 480 = 240 горизонтальних + 240 вертикальних
