# Escort Game — проектний контекст

## Що це
Мультиплеєрна гра в Decentraland SDK7. Два проекти:
- `client/` — DCL сцена (SDK7, TypeScript, Colyseus клієнт) — див. `client/CLAUDE.md`
- `server/` — Colyseus сервер (Node.js, TypeScript, CommonJS) — див. `server/CLAUDE.md`

Сторонній:
- `Caddyfile` + `caddy_windows_amd64.exe` — reverse proxy з Let's Encrypt SSL → `127.0.0.1:2567`
- `CADDY_SETUP.md` — інструкція налаштування (DuckDNS, проброс портів, варіанти Caddyfile)

## Архітектура
- Сервер **авторитарний** — всі ігрові рішення на сервері.
- Клієнт лише відображає стан і надсилає команди (`room.send(...)`).
- Синхронізація через `onStateChange` (Colyseus 0.17 CRDT).
- TLS термінується **Caddy**, не Node — сервер слухає plain HTTP.

## Деплой / запуск
```powershell
# Термінал 1 — Colyseus
cd server
npm start                                    # tsx watch → 127.0.0.1:2567

# Термінал 2 — Caddy (з кореня проєкту)
.\caddy_windows_amd64.exe run --config Caddyfile
# wss://YOUR-DOMAIN → 127.0.0.1:2567
```

Клієнтський endpoint hardcoded у `client/src/index.ts:32` як `const SERVER_URL`. Якщо змінюєш домен — синхронно оновлюй `Caddyfile`.

## Команди
- **Bodyguards** — охороняють VIP, ведуть її до безпечної зони
- **Haters** — хочуть убити VIP до закінчення часу

## Результати гри (winner / reason)
- `bodyguards` / `vip_safe` — VIP дійшла до безпечної зони
- `bodyguards` / `elimination` — усіх хейтерів усунуто
- `draw` / `timeout` — час вийшов, VIP жива але не дійшла
- `haters` / `vip_killed` — VIP убита
- `haters` / `elimination` — усіх тілоохоронців усунуто

## Структура клієнта (client/src/)
```
src/
├── index.ts              — точка входу, підключення Colyseus, onStateChange
├── ui.tsx                — увесь 2D HUD (React-ECS)
├── colyseus-client.ts    — підключення до сервера, sendToRoom, getRoom
├── polyfills.ts          — поліфіли для QuickJS
├── game/
│   ├── attachedItems.ts  — предмети, прикріплені до аватара
│   ├── combatInput.ts    — клавіші E (дія/бомба) і F (захист)
│   ├── constants.ts      — GRID, TILE_SIZE=2, WALL_HEIGHT=2.5, tileToWorldX/Z
│   ├── healthBar.ts      — world-space HP бари (Billboard entities)
│   ├── lightEffects.ts   — VIP beacon + stripe кольори
│   ├── maze.ts           — будова лабіринту, стіни, двері, бомби
│   ├── npcRenderer.ts    — VIP NPC (AvatarShape + vipHitBox)
│   ├── playerHitboxes.ts — hitbox-и ворожих гравців
│   └── screenEffects.ts  — hit-flash (червоне миготіння екрану)
├── audio/
│   ├── soundManager.ts   — пул звуків, play/stop/loop
│   └── vipAudio.ts       — 3-тирна система звуків за близькістю
├── state/
│   └── localState.ts     — клієнтський стан, patchLocalState
├── utils/
│   ├── adjacency.ts      — перевірки сусідства тайлів
│   ├── entityFactory.ts  — createEntity, makeClickable, setEKeyHint, removeEntity
│   └── transformUtils.ts — tweens, анімації стін/дверей
└── zones/
    ├── gameZone.ts       — ігрова арена (Y ≈ 15 м), CameraArea park-pattern
    ├── lobby.ts          — лобі (Y < 5 м)
    ├── spectatorZone.ts  — куб 16×4×4 (X=8–24, Z=26–30)
    └── zoneTriggers.ts   — TriggerArea для зміни зон
```

## Структура сервера (server/src/)
```
src/
├── index.ts              — listen(app)
├── app.config.ts         — defineServer + Express middleware + /auth /health /monitor /playground
├── auth.ts               — короткоживучі токени (60с TTL), rate-limit /auth
├── rooms/
│   ├── GameRoom.ts       — головний Colyseus room (вся ігрова логіка)
│   └── state/
│       └── GameState.ts  — Schema класи для реплікації (PlayerState, VIPState, GameState)
└── game/
    ├── config.ts         — hot-reload з server/config.json + onConfigChange API
    ├── constants.ts      — структурні константи (НЕ tunable)
    ├── MazeGenerator.ts  — DFS + bridges + doors
    ├── MazeTemplates.ts  — VIP-кімната + safety-зона
    ├── NpcAi.ts          — рух VIP
    └── Pathfinder.ts     — A* + canMoveBetween
```

## Конфігурація сервера — server/config.json (hot-reload)
Усі **tunable** значення (HP, damage, timers, item caps, maze options, vipConfig) — у `config.json`. `fs.watch` із debounce 200мс підхоплює зміни без рестарту. Валідація відхиляє некоректні значення (`MIN > MAX`, неправильні типи) і зберігає попередній стан із помилкою у логах.

### Admin controls (у config.json)
- `FORCE_START_GAME` — edge-trigger `false→true`: примусово починає матч (з `lobby` auto-queue всіх, з `countdown` пропускає countdown).
- `FORCE_END_GAME` — edge-trigger `false→true`: примусово завершує активний матч (`draw / admin_end`).
- `ADD_TIME_S` — на кожну зміну до ненульового додає/віднімає секунди від `state.timeRemaining` (тільки в `playing`).
- `IMMORTALITY_MODE` — live: гравці/VIP при HP≤0 телепортуються на випадковий tile + повне HP замість смерті.
- `ALLOW_ALL_TILE_OVERLAP` — live: дозволяє будь-якому гравцеві стояти на будь-якій плитці (вкл. плитку VIP). Server пропускає `isTileOccupiedByOther`, client скидає `physicsBox` з усіх ворожих hitbox-ів і `CL_PHYSICS` з VIP hitbox-а. Передається у `scene_config`.

Деталі — `server/CLAUDE.md` (секції "Конфігурація" + "Admin-команди").

## Зони
- `lobby` — Y < 5 м (стартова зона)
- `spectator` — бокс центр (16, 2, 28), розмір 16×4×4 м, Z=26..30
- `game` — Y ≈ 15–18 м, ігрова арена 32×32 м

## Куб у лобі (spectatorZone.ts)
- **Центр** (Z=26, зовні) — кнопки Join/Cancel/Spectate + статус гри
- **Схід** (Z=26, справа) — дошка останніх 5 матчів `🏆 Last matches`
- **Захід** (Z=26, ліворуч) — `How to play ❓`, клік → `showHowToPlay`

Глядачі телепортуються на `(16, 1.1, 27)`, камера → `(16, 1.5, 26)`.

## Hitbox архітектура

### Ворожі гравці (playerHitboxes.ts)
- `physicsBox` — box 2×3×2, **CL_PHYSICS only**. Блокує рух у кардинальних напрямках. Створюється тільки для **ворогів** (інша команда).
- `clickBox` — циліндр 0.8×2.0×0.8, **CL_POINTER only**. Слідкує за реальним аватаром.
  Клік → `attack` якщо `isLocalNearTileDiag` (Chebyshev ≤ 1).
- **Same-team:** жодного hitbox-а. Союзники проходять одне крізь одне і можуть стояти на одній плитці.

### Server-side overlap (GameRoom.isTileOccupiedByOther)
Викликається на `player_tile` для блокування переміщення на зайняту плитку. Параметр `sameTeamAs` — гравці тієї ж команди ігноруються як перешкоди (allies share tiles). Передається `p.team` від caller-а. **Повністю пропускається коли `cfg.ALLOW_ALL_TILE_OVERLAP=true`** — тоді будь-хто може стояти будь-де, включно з плиткою VIP.

### VIP (npcRenderer.ts)
- `vipEntity` — AvatarShape, без колайдера
- `vipHitBox` — циліндр 0.8×2.0×0.8:
  - Хейтер: `CL_POINTER|CL_PHYSICS` + клік → `attack_vip` (Chebyshev ≤ 1)
  - Бодігард: `CL_POINTER` + клік → `follow_vip` (кардинально ≤ 1)

## Safety-zone beacon (lightEffects.ts → configureSafetyBeacon + updateSafetyBeacon)
Зелений світний бокс (~2.8 × 20 × 2.8 м) над центром зони безпеки. Висота дорівнює `VIP_BEACON_HEIGHT_M`. Створюється раз на `maze_rebuild` (через `setSafetyTiles` → `configureSafetyBeacon`), позиція оновлюється при кожному match-rebuild.

Видимість обчислюється **per-frame на клієнті** і об'єднує 3 правила (досить одного):
1. **Всім гравцям** — коли `timeRemaining ≤ 120 с` (2 хвилини).
2. **Команді гравця** — коли хоча б один союзник стоїть на safety-tile (визначається через `anyAllyInSafetyZone(myTeam, players)` у `maze.ts`).
3. **Тілоохоронцю-ескорту** — коли `mySessionId === vip.followerId` AND `timeRemaining ≤ 180 с` (3 хвилини).

Поза `phase='playing'` завжди прихований.

## CameraArea (gameZone.ts) — add/remove component

Host-entity створюється раз у `buildGameZone()` (з одним Transform). Сам `CameraModeArea` компонент додається/видаляється на льоту через `applySceneConfig`:
- `firstPerson=true`  → `CameraModeArea.createOrReplace(entity, { area, mode: CT_FIRST_PERSON })`
- `firstPerson=false` → `CameraModeArea.deleteFrom(entity)` (no-op якщо компоненту немає)

Це **стандартний DCL SDK7 ECS патерн** (див. [sdk-skills/camera-control](https://github.com/decentraland/sdk-skills/tree/main/camera-control)). Працює **в будь-якій фазі** (включно з `playing`) — сервер шле `scene_config` як при `onJoin`, так і при кожному hot-reload `config.json`.

## Предмети (maze.ts)
| Предмет | Рука | Ефект |
|---------|------|-------|
| Дубинка (baton) | права | +8–15 шкоди в ближньому бою |
| Щит (shield) | ліва | поглинає шкоду при захисті |
| Бомба (bomb) | ліва | 5с відлік, E → покласти |

Колайдери: всі `CL_POINTER` only (без фізичного блоку).

## Система захисту (applyDamageToPlayer)
| Стан | Джерело | До HP | До щита |
|------|---------|-------|---------|
| Не захищається, без щита | будь-яке | 100% | — |
| Не захищається, є щит | будь-яке | 50% | 50% |
| Захищається, без щита | рука/дубинка | 75% | — |
| Захищається, без щита | бомба | 50% | — |
| Захищається, є щит | будь-яке | 0% | 100% |

Атака під захистом = -25% штраф до шкоди.

## VIP AI — порядок кроків (tickNpcMovement)
1. **Idle-push** — тупик + хейтер поруч без атаки >2.5с → штовхнути
2. **vipDeadEndEscape** — перший крок після удару; активує `vipFleeing = true`
3. **Тілоохоронець поруч** → вийти з flee, супроводжувати
4. **Хейтер поруч** (без стіни):
   - є шлях в обхід → рухатися в обхід
   - заблоковано + `vipWasHitByHater` → bypass або flee
5. **Flee mode** → `pickVipFleeDest` (тільки плитки з ≥2 виходами)
6. **Dead-end self-escape** — у тупику, шлях ≤8 → вийти
7. **Escort** → слідувати за тілоохоронцем

`vipWasHitByHater` скидається коли: тілоохоронець підходить, flee природньо завершується.

## Дальність атаки (adjacency.ts)
- `isLocalNearTile` — кардинально (dx+dy ≤ 1): стіни, `follow_vip`
- `isLocalNearTileDiag` — Chebyshev ≤ 1 (8 сусідів): атаки гравців і VIP
- `isLocalOnTile` — точний тайл: підбір пастки-бомби
- `isLocalAdjacentToWall` — взаємодія зі стінами

## Звукова система VIP (vipAudio.ts)
| Тир | Звуки | Умова | Інтервал |
|-----|-------|-------|---------|
| 0 — спокій | `vip_complain`, `radio_check` | немає хейтерів у r=6 | 20с (старт +5с) |
| 1 — попередження | `vip_spotted`, `suspicious` | хейтер ≤6 плиток | 20с |
| 2 — небезпека | `vip_help`, `security` | хейтер ≤3 плитки | 10с |

Глобальний `_anyPlaying = 5с` запобігає перекриттю.
Нові звуки не починаються в останні 15 секунд матчу.

## Візуальні індикатори VIP

### Циліндр-маяк (lightEffects.ts) — колір HP
- **Жовтий** — HP > 66%
- **Оранжевий** — HP 33–66%
- **Червоний** — HP < 33%

### Стрічки на бетоні/колонах (syncStripeColor) — небезпека
- **Білий** — спокій
- **Жовтий** — хейтер ≤6 плиток
- **Оранжевий** — хейтер ≤3 плитки
- **Червоний** — VIP щойно вдарена (3 сек)
- **Золото** — VIP неактивна

## UI (ui.tsx — React-ECS)
- **Топ-центр** — таймер, назва команди, інвентар, щит HP, попередження бомби
- **Топ-правий** — онлайн/пінг chip
- **Правий бік** — список гравців з HP-барами (bodyguards / VIP / haters)
- **Нижній центр** — HP-бар стіни при наведенні
- **Нижній центр (вище)** — toast ("Need bomb to break this hedge" тощо)
- **Центр** — оверлей кінця гри
- **Модалка** — "How to Play" (`showHowToPlay`)
- **Нижній правий** — керування спектатором (◀ / Next ▶ / ✕ Stop)
- **Повний екран** — червоний flash при ударі

### Emoji в DCL
Тільки певні emoji рендеряться. Підтверджено:
- `⭐` `🏆` `●` `○` `⚠` `✕` у TextShape і Label
- `◀` `▶` — тільки в `Button`, не в `Label`

## State management
- `localState.ts` — клієнтський стан, `patchLocalState({...})`
- Сервер = джерело правди; `onStateChange` синхронізує localState

### Ключові поля localState
- `zone` — `'lobby'|'game'|'spectator'`
- `phase` — `'lobby'|'countdown'|'playing'|'ended'`
- `myTeam` — `'none'|'bodyguard'|'hater'`
- `myTileCol / myTileRow` — поточна позиція гравця
- `myRightHand / myLeftHand` — `'none'|'baton'` / `'none'|'shield'|'bomb'`
- `myDefending` — режим захисту (F)
- `showHowToPlay` — чи відкрита How-to-play модалка
- `lobbyImageModalUrl` — `''` коли закрита, інакше шлях до зображення (клік по площині в лобі)
- `activeBombs` — список активних бомб в арені
- `playerList` — список гравців з HP

## Відомі особливості Colyseus 0.17
- `ArraySchema.onChange` не працює → diff вручну в `onStateChange`
- `MapSchema.onAdd/onRemove` ненадійні → теж diff вручну
- Nested string fields у `p.onChange` не завжди спрацьовують → дублюємо в `onStateChange`
- `client.auth.token` шле `Authorization: Bearer …`, **не** в body — для curl-тестів передавай токен у `-H "Authorization: Bearer …"`, не в `-d`
