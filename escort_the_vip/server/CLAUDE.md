# Server — детальний контекст

Читай також `../CLAUDE.md` для загального огляду проекту.

## Структура src/
```
src/
├── main.ts                    ← HTTP/WS сервер, маршрути /auth та /health
├── auth.ts                    ← JWT автентифікація через DCL підпис
├── rooms/
│   ├── GameRoom.ts            ← головний Colyseus room (вся ігрова логіка)
│   └── state/
│       └── GameState.ts       ← Schema класи для Colyseus реплікації
└── game/
    ├── constants.ts           ← всі числові константи гри
    ├── MazeGenerator.ts       ← DFS генерація лабіринту
    ├── MazeTemplates.ts       ← фіксовані шаблони (VIP-кімната, маршрути)
    ├── NpcAi.ts               ← рух VIP (follow bodyguard / pathfind to safe)
    └── Pathfinder.ts          ← A* пошук шляху по сітці
```

## Числові константи (constants.ts)

### Гравці
| Константа | Значення |
|-----------|----------|
| `PLAYER_MAX_HP` | 100 |
| `VIP_MAX_HP` | 200 |
| `ATTACK_DAMAGE_MIN/MAX` | 15–25 (рука) |
| `SWORD_BONUS_MIN/MAX` | +8–15 до рукопашної |
| `BOMB_DAMAGE_MIN/MAX` | 30–55 (радіус 1 плитка) |
| `BOMB_SELF_DAMAGE` | 10 |
| `ATTACK_COOLDOWN_MS` | 1000 мс |
| `ATTACK_RESOLVE_DELAY_MS` | 700 мс (вікно контратаки) |
| `DEFENDING_DAMAGE_MULT` | 0.5 (F-стійка) |

### Щит
| Константа | Значення |
|-----------|----------|
| `SHIELD_MAX_HP_MIN/MAX` | 50–150 HP (рандом при спавні) |
| `SHIELD_HIT_BY_HAND` | 5 |
| `SHIELD_HIT_BY_SWORD` | 25 |
| `SHIELD_HIT_BY_BOMB` | 80 |

### Пошкодження стін
| Джерело | Пошкодження |
|---------|-------------|
| Рука | 10–18 |
| Меч | 22–38 |
| Бомба | 80–110 |

HP стін: HEDGE=100, WOOD_FENCE=50, WOOD_DOOR=80

### Правила атаки стін (gate by HP%)
- `WOOD_FENCE` → будь-яким
- `WOOD_DOOR` → меч/бомба; < 50% HP → теж рукою
- `HEDGE` → тільки бомба; < 50% → теж мечем; < 25% → теж рукою

### Таймінги гри
| Константа | Значення |
|-----------|----------|
| `GAME_DURATION_S` | 300 с (5 хв) |
| `COUNTDOWN_S` | 30 с |
| `END_LINGER_S` | 10 с |
| `VIP_ROOM_LOCK_S` | 20 с (на початку матчу) |
| `BOMB_FUSE_MS` | 15 000 мс |
| `NPC_MOVE_INTERVAL_MS` | 1 500 мс |
| `NPC_FOLLOW_RADIUS` | 4 плитки |

### Предмети
| Константа | Значення |
|-----------|----------|
| `ITEM_SPAWN_INTERVAL_MS` | 12 000 мс |
| `ITEM_MAX` | 12 (на підлозі) |
| `SWORD_MAX_TOTAL` | 5 (підлога + руки) |
| `SHIELD_MAX_TOTAL` | 5 (тільки активні) |
| Ваги спавну | bomb×3, sword×1, shield×1 |

### Дисконект
| Константа | Значення |
|-----------|----------|
| `DISCONNECT_DEATH_MS` | 60 000 мс → вмирає |
| `DISCONNECT_PURGE_MS` | 120 000 мс → видаляється зі стану |

## Стан гри (GameState.ts)

### PlayerState (реплікується всім)
```
userId, displayName, team ('none'|'bodyguard'|'hater')
zone ('lobby'|'game'|'spectator')
health, maxHealth, tileCol, tileRow
lastDamage, lastDamageTime
isAlive, inQueue, defending
rightHand ('none'|'sword'), leftHand ('none'|'shield'|'bomb')
shieldHP, shieldMaxHP
connected, disconnectedAt, ping, killerId
```

### VIPState
```
health, maxHealth, tileCol, tileRow
active, reachedSafe
targetName, followerId   ← хто веде VIP
female, outfitIndex, skinIndex, hairIndex, eyeIndex
```

### GameState (кімната)
```
phase: 'lobby'|'countdown'|'playing'|'ended'
players: MapSchema<PlayerState>
wallTypes[480], wallStates[480], wallHP[480], wallMaxHP[480]
items: MapSchema<ItemState>
bombs: MapSchema<BombState>
history: ArraySchema<GameResult>
vip: VIPState
timeRemaining, countdown, winner
wallClaimTeams[480], wallClaimAck[480]  ← система дверей
vipRoomLocked, mazeTemplateId
```

## Повідомлення від сервера до клієнта
| Повідомлення | Дані | Коли |
|-------------|------|------|
| `teleport` | `{x,y,z, cx?,cy?,cz?, spectating?}` | старт матчу, смерть, reconnect |
| `maze_rebuild` | `{wallTypes, wallStates, wallHP, wallMaxHP, templateId, safetyTiles, ...}` | перед кожним матчем |
| `hit` | `{damage}` | гравець отримав удар |
| `hit_sound` | `{col, row}` | звук удару в сцені |
| `bomb_explode` | `{col, row}` | бомба вибухнула |
| `attack_blocked` | `{reason}` | атака не пройшла (toast) |
| `game_ended` | `{winner, reason}` | кінець матчу |
| `you_died` | `{killerId}` | смерть гравця → режим спостерігача |
| `vip_room_unlocked` | `{}` | після VIP_ROOM_LOCK_S |
| `welcome` | `{phase}` | перша відповідь після з'єднання |

## Система дверей (claim)
- `wallClaimTeams[idx]` = 0/1/2 (0=нема, 1=bodyguard, 2=hater)
- `wallClaimAck[idx]` = бітфілд (bit1=bodyguard пробував, bit2=hater пробував)
- Клієнт фарбує двері: amber=нейтрально, blue=моя команда блокує, red=заблоковано для мене

## Режим тестування

`EMPTY_ARENA_MODE` у `server/src/game/constants.ts`:
```typescript
export const EMPTY_ARENA_MODE = false  // ← змінити на true для тестів
```
- `false` (default) → звичайна гра з процедурним лабіринтом
- `true` → порожня арена: тільки VIP-кімната (бетон + металеві двері) + зона безпеки, решта 16×16 відкрита

Функція `generateEmptyArena()` у `MazeGenerator.ts` — ті самі `placeVipRoomWalls` / `placeSafetyZoneOpenings` що і в звичайній генерації, без DFS/braiding/obstacles.

**Демо-стіни** (рядок V-walls): row=7, cols 4-9 — по одній стіні кожного типу (Concrete → Hedge → IronFence → WoodFence → MetalDoor → WoodDoor).

**Демо-предмети** (рядок items): row=9, cols 6-8 — (sword, shield, bomb). При підборі одразу респавняться на тій самій плитці. Ключ `{col}_{row}` у `state.items` → `spawnItem()` не перекриває ці плитки. `GameRoom.demoTiles: Map<string,string>` зберігає які плитки є демо-слотами.

## Умови перемоги
| winner | reason | Умова |
|--------|--------|-------|
| `bodyguards` | `vip_safe` | VIP дістався до safe zone |
| `bodyguards` | `elimination` | всі haters мертві |
| `draw` | `timeout` | час вийшов, VIP живий але не дійшов (нічия) |
| `haters` | `vip_killed` | VIP вбитий |
| `haters` | `elimination` | всі bodyguards мертві |

`endGame('draw', 'timeout')` викликається коли `timeRemaining <= 0` (VIP завжди живий — якби він помер раніше, спрацював би `vip_killed`).
