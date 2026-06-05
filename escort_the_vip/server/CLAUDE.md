# Server — детальний контекст

Читай також `../CLAUDE.md` для загального огляду проекту.

## Стек
- **Node.js 20+**, TypeScript, **CommonJS** (не ESM — простіше імпортувати game-логіку без `.js` суфіксів)
- **Colyseus 0.17.x** + `@colyseus/tools` (`defineServer` / `listen`)
- **Express** для `/auth` `/health` `/monitor` `/playground`
- **Без TLS на сервері** — слухає `127.0.0.1:2567`, термінацію HTTPS і WebSocket upgrade робить **Caddy** (див. `../Caddyfile` + `../CADDY_SETUP.md`)
- Dev: `tsx watch src/index.ts` (hot-reload TS). Prod: `npm run build && node build/index.js`

## Структура src/
```
src/
├── index.ts                   ← entry point: listen(app)
├── app.config.ts              ← defineServer: GameRoom + Express middleware + /auth /health
├── auth.ts                    ← короткоживучі токени (in-memory, 60с TTL), rate-limit
├── rooms/
│   ├── GameRoom.ts            ← головний Colyseus room (вся ігрова логіка)
│   └── state/
│       └── GameState.ts       ← Schema класи для Colyseus реплікації
└── game/
    ├── config.ts              ← hot-reload з server/config.json, onConfigChange API
    ├── constants.ts           ← СТРУКТУРНІ константи (НЕ для hot-tune)
    ├── MazeGenerator.ts       ← DFS + bridges + doors
    ├── MazeTemplates.ts       ← VIP-кімната + спавн safety-зони
    ├── NpcAi.ts               ← рух VIP
    └── Pathfinder.ts          ← A* по сітці + canMoveBetween
```

## Конфігурація — server/config.json (hot-reload)

Всі **tunable** значення (HP, damage, timers, item caps, maze options, vipConfig) живуть у `server/config.json`. Редагуєш файл — `fs.watch` із debounce 200мс ловить зміну, валідує і застосовує **без рестарту**.

- На успіх: `[Config] ✓ Reloaded config.json`
- На помилку (parse / invalid range / wrong type): `[Config] ✗ Reload failed (keeping previous values): <reason>` — сервер ніколи не падає від невірного редагування.

Інші модулі читають як `cfg.GAME_DURATION_S` (НЕ `const { X } = cfg` — destructuring капчить значення в момент імпорту, обходить live-binding).

### Коли застосовується зміна
| Тип | Приклади | Коли |
|-----|---------|------|
| Миттєво | `ATTACK_DAMAGE_*`, `BOMB_*`, `ITEM_SPAWN_WEIGHTS`, `DEFENDING_DAMAGE_MULT`, `IMMORTALITY_MODE` | Читається щотіку |
| На наступний матч | `GAME_DURATION_S`, `COUNTDOWN_S`, `MAZE_OPTIONS`, `ITEM_INITIAL_COUNT`, `VIP_MAX_HP`, `EMPTY_ARENA_MODE` | Читається в `startGame()` |
| Admin-команди (edge-/change-trigger) | `FORCE_START_GAME`, `FORCE_END_GAME`, `ADD_TIME_S` | Спрацьовують лише при зміні значення; див. секцію нижче |
| На рестарт сервера | `vipConfig` | Catalyst avatar фетчиться раз у `loadVipConfig()` |

### Admin-команди (processAdminCommands)
Викликається з `onConfigChange` після кожного `[Config] ✓ Reloaded`. Стан останніх застосованих значень тримається в полях `_lastForceStart`, `_lastForceEnd`, `_lastAddTime` (per-instance).

| Поле | Тип | Семантика | Спрацьовує |
|------|-----|---------|-----------|
| `FORCE_START_GAME` | bool | Edge-trigger `false → true`. У `lobby` авто-черга всіх `zone='lobby'` connected players + `startGame()`. У `countdown` пропускає countdown і одразу `startGame()`. У `playing`/`ended` ігнорується. | Один раз на flip → перший раз треба прибрати до `false` щоб запустити знов. |
| `FORCE_END_GAME` | bool | Edge-trigger. У `playing` викликає `endGame('draw', 'admin_end')`. Інакше ігнорується. | Той же edge-trigger pattern. |
| `ADD_TIME_S` | number | При зміні (не 0): `state.timeRemaining = max(0, time + ADD_TIME_S)`. Тільки в `playing`. Від'ємні значення скорочують час. `0` — reset (без дії). | Кожного разу коли значення змінюється на ненульове. Щоб додати +60с двічі поспіль, зміни 0 → 60 (apply) → 0 → 60 (apply). |
| `IMMORTALITY_MODE` | bool | Live (не edge). Коли `true`, кожен раз як HP гравця/VIP ≤ 0 — `tryImmortalSave(...)` телепортує на випадковий tile зі `mazeConfig.spawnPool`, поновлює HP до `maxHealth`, лишає `isAlive=true`. Shield НЕ відновлюється. | Перевіряється у `applyDamageToPlayer`-каскаді та `applyBombHitToVip` перед death-branch. |

**Інтеграція immortality:**
- `tryImmortalSave(sessionId, p)` — гравець: 3 точки виклику (атака рукою/дубинкою + бомба). Шле `teleport` на нову плитку.
- `tryImmortalSaveVip()` — VIP: 2 точки виклику. Не шле повідомлення (клієнти ловлять переміщення через state replication + npcRenderer).
- Обидва — no-op якщо `IMMORTALITY_MODE=false` або `mazeConfig.spawnPool` порожній (наприклад до старту матчу).

### onConfigChange API
`config.ts` експортує:
```ts
export function onConfigChange(listener: (cfg) => void): () => void
```

`GameRoom.onCreate()` підписується і **broadcast-ить `scene_config` у будь-якій фазі** (lobby / countdown / playing / ended). Це доставляє нові значення `ENABLE_GAME_ZONE_FIRST_PERSON` / `ENABLE_ROOF_PHYSICS_COLLIDER` до **усіх вже підключених гравців** без реконекту, навіть під час активного матчу. `onDispose()` викликає unsubscribe.

Безпечно перемикати mid-match: клієнт використовує стандартний DCL SDK7 add/remove патерн — `CameraModeArea.createOrReplace(entity, ...)` при `firstPerson=true` і `CameraModeArea.deleteFrom(entity)` при `false` (див. `client/src/zones/gameZone.ts`). Roof collider теж безпечно перепризначається через `MeshCollider.setBox`.

### Валідація (config.ts → validate())
- Все що `MIN/MAX` має `MIN <= MAX`
- HP-діапазони стін: `0 <= min <= max <= 255` (uint8 schema)
- `ITEM_SPAWN_WEIGHTS`: усі ваги ≥ 0
- `MAZE_OPTIONS.materialBias` і `corridorObstacleBias`: не-порожні масиви
- `vipConfig.mode` ∈ {`random`, `female`, `male`, `player`}
- Wall-type рядки (`CONCRETE`, `HEDGE`, `WOOD_WALL`, `WOOD_DOOR`) → числові ID через `WALL_TYPE_BY_NAME`

## Структурні константи — game/constants.ts (НЕ tune-able)

Тільки те, що ламає schema/client при зміні: `GRID_COLS/ROWS=16`, `TILE_SIZE=2`, `GAME_ZONE_Y=15`, `WALL_HEIGHT=2.5`, `WALL_THICKNESS=0.2`, wall types (`WALL_NONE..WALL_WOOD_DOOR`), wall states (`STATE_SOLID..STATE_BLOCKED`), `WALL_COUNT=480`, `hWallIndex`/`vWallIndex`, `INDESTRUCTIBLE_WALL_TYPES`, `SAFE_ZONE_COLS/ROWS` (legacy), `randInt`.

`randomWallHp(type)` живе в `config.ts` (читає `cfg.WALL_HP_RANGES`), реекспорту з constants немає.

## Encoder buffer

`app.config.ts` піднімає `Encoder.BUFFER_SIZE = 32 * 1024` ДО першого імпорту GameRoom — інакше maze (6 × uint8[480] + players + items + bombs + history) переповнює дефолтні 8 KB і Colyseus тихо губить дифи стану.

## Аутентифікація — auth.ts + /auth

1. Клієнт: `POST /auth { userId, displayName }` → `{ token }` (24-байт random base64url, TTL 60с, in-memory).
2. Клієнт: `client.auth.token = token` → `joinOrCreate` → Colyseus SDK шле `Authorization: Bearer <token>` на `/matchmake/joinOrCreate/game_room`.
3. Сервер: `GameRoom.onAuth(token)` → `verifyToken(token)` → `{ userId, displayName }` або `ServerError(525)`.
4. Токен не single-use (Colyseus SDK ретраїть до 2 разів) — діє весь TTL.

Rate-limit: 10 токенів на IP за хвилину (`/auth` middleware).

## Структура стану (GameState.ts)

### PlayerState (реплікується всім)
```
userId, displayName
team       'none'|'bodyguard'|'hater'
zone       'lobby'|'game'|'spectator'
health, maxHealth, tileCol, tileRow
lastDamage, lastDamageTime, lastDealt, lastDealtTime
isAlive, inQueue, defending
rightHand  'none'|'baton'
leftHand   'none'|'shield'|'bomb'
shieldHP, shieldMaxHP
spectateTarget, connected, disconnectedAt, ping, killerId
```

### VIPState
```
health, maxHealth, tileCol, tileRow
active, reachedSafe, facingYaw, lastMoveAt
targetName, followerId
female, outfitIndex, skinIndex, hairIndex, eyeIndex
appearanceMode, playerWallet, playerAvatarJson
```

### GameState (root)
```
phase: 'lobby'|'countdown'|'playing'|'ended'
players: MapSchema<PlayerState>
items:   MapSchema<ItemState>
bombs:   MapSchema<BombState>
vip:     VIPState
history: ArraySchema<GameResult>
wallTypes[480], wallStates[480], wallHP[480], wallMaxHP[480]
wallClaimTeams[480], wallClaimAck[480]
timeRemaining, countdown, winner
playerCount, queueCount
vipRoomLocked, mazeTemplateId
```

## VIP AI — порядок кроків (tickNpcMovement)

1. **Idle-push** — VIP у тупику (`exits ≤ 1`) і хейтер поруч без атаки >2.5с → штовхнути
2. **vipDeadEndEscape** — перший крок після удару в тупику; активує `vipFleeing = true`
3. **Тілоохоронець поруч** → вийти з flee, супроводжувати
4. **Хейтер поруч** (без стіни між ними):
   - Є шлях в обхід → рухатися в обхід
   - Заблоковано + `vipWasHitByHater` → bypass або flee
5. **Flee mode** → `pickVipFleeDest` (тільки плитки з ≥2 виходами)
6. **Dead-end self-escape** → у тупику без загрози, шлях ≤8 — вийти
7. **Escort** → слідувати за тілоохоронцем

`vipWasHitByHater` скидається коли: тілоохоронець підходить, flee природньо завершується.

## Відштовхування (knockback)
- `tryKnockback` — стандартний направлений knockback.
- `forceKnockbackToFreeNeighbour` — fallback коли VIP у тупику (`exits ≤ 1`) і стандартний не спрацював; гарантує вільну сусідню плитку якнайдалі від VIP.

## Система дверей (claim)
- `wallClaimTeams[idx]` = `0` (нема) / `1` (bodyguard) / `2` (hater)
- `wallClaimAck[idx]` = бітфілд (bit 1 = bodyguard пробував, bit 2 = hater пробував)
- VIP-room двері стартують `STATE_BLOCKED` + claim=1; розблоковуються поступово таймером після `VIP_ROOM_LOCK_S`.

## Повідомлення сервер → клієнт

| Повідомлення | Дані | Коли |
|-------------|------|------|
| `welcome` | `{sessionId, phase}` | onJoin (один раз) |
| `scene_config` | `{firstPerson, roofPhysics}` | onJoin **+** при кожному hot-reload `config.json` (у будь-якій фазі, включно з `playing`) |
| `maze_rebuild` | `{wallTypes, wallStates, wallHP, wallMaxHP, templateId, vipRoomTiles, vipRoomDoors, safetyTiles, vipRoomLocked}` | onJoin + перед кожним матчем |
| `teleport` | `{x,y,z, cx?,cy?,cz?, spectating?}` | старт матчу, смерть, reconnect, spectate toggle |
| `pong` | `{timestamp}` | у відповідь на `ping` |
| `hit` | `{damage, attackerId?, shield?, blocked?}` | гравець отримав удар |
| `hit_dealt` | `{damage, targetId}` | гравець завдав удар |
| `hit_sound` | `{col, row}` | broadcast звуку удару |
| `bomb_placed` | `{col, row}` | bomb заплейсилась |
| `bomb_explode` | `{col, row}` | бомба вибухнула |
| `attack_blocked` | `{reason}` | атака не пройшла (вне дистанції, hedge без бомби тощо) |
| `vip_door_unlocked` | `{wallIdx}` | таймер розблокував двері VIP-кімнати |
| `vip_door_crossed` | `{wallIdx}` | VIP пройшла через двері (для візуального ефекту на клієнті) |
| `game_ended` | `{winner, reason}` | кінець матчу |
| `you_died` | `{killerId}` | смерть → handover у spectate-mode на killer-а |

## Повідомлення клієнт → сервер (handler у GameRoom.setupMessages)

`ping, report_ping, identify, join_game, cancel_join, spectate, stop_spectate, player_tile, attack, attack_vip, attack_wall, destroy_wall, place_bomb, pickup_bomb, use_item, toggle_defend, pickup_item, interact_door, follow_vip`.

## Координати глядацького боксу (teleport на spectate)
Глядачі: `x=16, y=1.1, z=27` (камера → `cx=16, cy=1.5, cz=26`). Бокс центр `(16, 2, 28)`, розмір `16×4×4`, Z=26..30.

## Умови перемоги
| winner | reason | Умова |
|--------|--------|-------|
| `bodyguards` | `vip_safe` | VIP дістався до safe zone |
| `bodyguards` | `elimination` | всі haters мертві |
| `draw` | `timeout` | час вийшов, VIP живий |
| `haters` | `vip_killed` | VIP вбитий |
| `haters` | `elimination` | всі bodyguards мертві |

## Disconnect grace
- `connected=false` → гравець залишається в state з "reconnecting" індикатором
- `cfg.DISCONNECT_DEATH_MS` (60с за замовч.) → позначається мертвим
- `cfg.DISCONNECT_PURGE_MS` (120с) → видаляється зі стану повністю
- Reconnect до DEATH-таймера: повне відновлення позиції/інвентаря (через `playerBackup` map)

## Запуск з Caddy
```powershell
# Термінал 1
cd server
npm start          # → tsx watch на 127.0.0.1:2567

# Термінал 2 (з кореня)
.\caddy_windows_amd64.exe run --config Caddyfile
# → отримує Let's Encrypt cert
# → проксує wss://<your-domain> → 127.0.0.1:2567
```

## Тестування
- E2E через `node test/<...>.js`: auth + WS + state sync — див. приклади у попередніх повідомленнях.
- Reload-тест: змінити `config.json` → перевірити що `[Config] ✓ Reloaded` у логах і нові значення застосовуються.
- Invalid-edit тест: поставити `ATTACK_DAMAGE_MIN > MAX` → `[Config] ✗ Reload failed (keeping previous values)`.

## Відомі обмеження
- `vipConfig.mode='player'` потребує доступу до `peer.decentraland.org`. На Windows у corporate proxy — `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Workaround: `node --use-system-ca build/index.js` для prod, або `mode='random'` для dev.
