// ── Grid ──────────────────────────────────────────────────────────────────────
export const GRID_COLS = 16
export const GRID_ROWS = 16
export const TILE_SIZE  = 2   // metres per tile side

// ── Scene geometry ────────────────────────────────────────────────────────────
export const GAME_ZONE_Y      = 15   // Y of game-zone floor (metres above ground)
export const WALL_HEIGHT      = 3    // metres
export const WALL_THICKNESS   = 0.2  // metres

// ── Wall index layout ─────────────────────────────────────────────────────────
// H walls: between row r and r+1, at column c
//   r ∈ [0 .. GRID_ROWS-2],  c ∈ [0 .. GRID_COLS-1]
//   count = (GRID_ROWS-1) * GRID_COLS = 240
// V walls: between col c and c+1, at row r
//   r ∈ [0 .. GRID_ROWS-1],  c ∈ [0 .. GRID_COLS-2]
//   count = GRID_ROWS * (GRID_COLS-1) = 240
export const H_WALL_COUNT = (GRID_ROWS - 1) * GRID_COLS   // 240
export const V_WALL_COUNT = GRID_ROWS * (GRID_COLS - 1)   // 240
export const WALL_COUNT   = H_WALL_COUNT + V_WALL_COUNT   // 480

export function hWallIndex(r: number, c: number): number {
  return r * GRID_COLS + c
}
export function vWallIndex(r: number, c: number): number {
  return H_WALL_COUNT + r * (GRID_COLS - 1) + c
}

// ── Wall types ────────────────────────────────────────────────────────────────
// Six obstacle types as specified by the game design.
// Concrete / metal wall / iron door = indestructible (HP -1).
// Bush, wood door, wood fence = destructible — HP > 0.
export const WALL_NONE       = 0  // open passage
export const WALL_CONCRETE   = 1  // indestructible solid
export const WALL_HEDGE      = 2  // bush wall — destructible by bomb (and baton/all at HP thresholds)
export const WALL_METAL_WALL = 3  // indestructible solid
export const WALL_WOOD_FENCE = 4  // destructible by everything (hand/baton/bomb)
export const WALL_METAL_DOOR = 5  // movable, indestructible
export const WALL_WOOD_DOOR  = 6  // movable, destructible (rules in Phase 2)

// ── Wall states ───────────────────────────────────────────────────────────────
// SOLID is the universal "closed/intact" state. OPEN is the door-open state.
// DESTROYED means the wall has been broken (HP=0). BLOCKED means a movable door
// can't change state right now (e.g. a hostile player is on the destination tile).
export const STATE_SOLID     = 0  // solid / door closed / fence intact
export const STATE_OPEN      = 1  // door open
export const STATE_DESTROYED = 2  // fence / wood door destroyed
export const STATE_BLOCKED   = 3  // door cannot move (hostile on far side)

// ── Wall HP defaults (per type) ───────────────────────────────────────────────
// Stored as a uint8 in GameState.wallHP, so 0 doubles as the "no HP applies"
// sentinel for indestructible types. Destruction logic gates on type, not HP.
export const WALL_HP_DEFAULT: Record<number, number> = {
  [WALL_NONE]:       0,
  [WALL_CONCRETE]:   0,
  [WALL_HEDGE]:    100,
  [WALL_METAL_WALL]: 0,
  [WALL_WOOD_FENCE]: 50,
  [WALL_METAL_DOOR]: 0,
  [WALL_WOOD_DOOR]:  80,
}

// Wall types that cannot be destroyed under any circumstances.
// HP is stored as 0 for these — destruction logic gates on type, not HP value.
export const INDESTRUCTIBLE_WALL_TYPES = new Set<number>([
  WALL_CONCRETE, WALL_METAL_WALL, WALL_METAL_DOOR,
])

// ── Maze generation options ──────────────────────────────────────────────────
// Single config object — every match generates against MAZE_OPTIONS exactly
// once before play and the layout is frozen for the whole game (no mid-match
// regen). Tweak these constants to retune the maze; nothing else needs to
// change.
export interface MazeWeight { type: number; weight: number }
export interface MazeOptions {
  // 0..1 — chance the DFS keeps going in the previous direction. Lower =
  // more turns / more winding, higher = longer straight corridors.
  windingness:           number
  // 0..1 — fraction of background concrete walls re-opened as shortcuts
  // (loops). Higher = easier to navigate, more multi-route options.
  braidProb:             number
  // Inclusive count range (rolled per match) for total obstacles dropped
  // across every carved corridor — routes AND dead-end branches share this
  // budget instead of having separate caps.
  obstaclesMin:          number
  obstaclesMax:          number
  // Minimum number of indestructible (concrete / metal wall) walls each row
  // and each column of tiles must contain. Prevents any straight 16-tile
  // corridor along an edge or middle line of the maze.
  minBlockersPerLine:    number
  // Number of escort routes carved from VIP-room doors to the safety zone.
  routeCount:            number
  // Number of cross-corridor connections between route waypoints (0 = none).
  branchCount:           number
  // Material distribution for SOLID structural walls (between corridors).
  // Concrete / metal wall / hedge — anything indestructible-or-destructible
  // that should sit AS the labyrinth wall. Doors and wood-fence never appear
  // here — wood-fence belongs on the player's route, not the wall body.
  materialBias:          MazeWeight[]
  // Material distribution for obstacles dropped ON the carved corridors
  // (paths + dead-end entrances). Doors (metal / wood) + wood-fence — every
  // obstacle here is openable or destructible so paths stay traversable.
  corridorObstacleBias:  MazeWeight[]
}

// Default maze tuning. Edit here to retune every match.
export const MAZE_OPTIONS: MazeOptions = {
  // 0.86 = звивистий DFS: повертає часто, але залишає деякі прямі відрізки
  // більша щільність стін → менше порожніх просторів, більше справжніх тупиків.
  windingness:           0.86,
  // Майже без коротких шляхів: тупики не відкриваються і залишаються тупиками.
  braidProb:             0.01,
  // Partition doors — двері ставляться ТІЛЬКИ на стіни-мости (bridge detection).
  // Кожна двері закриває реальну секцію лабіринту. Підбираємо з різних "рівнів"
  // дерева лабіринту (стратифікована вибірка), тому вони рівномірно по всьому.
  obstaclesMin:          20,
  obstaclesMax:          35,
  // Мінімум 2 непробивних стіни (бетон/металічна стіна) на ряд/стовпець.
  minBlockersPerLine:    2,
  routeCount:            1,
  branchCount:           0,
  // Структурні стіни лабіринту (між коридорами):
  //   CONCRETE     — непробивний суцільний блок
  //   METAL_WALL   — непробивна металічна стіна
  //   HEDGE        — кущі (пробиваються бомбами/мечем), тактичний варіант
  //   WOOD_FENCE   — дерев'яний паркан (пробивається усим), альтернативний хід
  materialBias: [
    { type: WALL_CONCRETE,   weight: 40 },
    { type: WALL_METAL_WALL, weight: 30 },
    { type: WALL_HEDGE,      weight: 20 },
    { type: WALL_WOOD_FENCE, weight: 10 },
  ],
  // Перешкоди на відкритих коридорах — ТІЛЬКИ двері.
  // Вхід у тупик окремо обробляється placeDeadEndDoors перед цим кроком.
  corridorObstacleBias: [
    { type: WALL_WOOD_DOOR,  weight: 75 },
    { type: WALL_METAL_DOOR, weight: 25 },
  ],
}

// ── Game timing ───────────────────────────────────────────────────────────────
export const GAME_DURATION_S     = 300  // 5 minutes
export const COUNTDOWN_S         = 30
export const END_LINGER_S        = 10   // seconds to show results before resetting
export const MIN_PLAYERS_START   = 1
export const MAX_PLAYERS         = 10

// VIP room is locked for the first VIP_ROOM_LOCK_S seconds of a match.
// Bodyguards literally can't reach the VIP through the locked door — gives
// haters a chance to position themselves before the escort begins.
export const VIP_ROOM_LOCK_S     = 20

// ── Characters ────────────────────────────────────────────────────────────────
export const PLAYER_MAX_HP       = 100
export const VIP_MAX_HP          = 200
export const ATTACK_DAMAGE_MIN   = 15
export const ATTACK_DAMAGE_MAX   = 25
export const ATTACK_COOLDOWN_MS  = 1_000
export const BATON_BONUS_MIN     = 8   // extra damage range when holding baton
export const BATON_BONUS_MAX     = 15
export const BOMB_DAMAGE_MIN     = 30  // area damage range, 1-tile radius
export const BOMB_DAMAGE_MAX     = 55
export const BOMB_SELF_DAMAGE    = 10

// ── Wall damage values (per damage source) ───────────────────────────────────
// Phase 2 destructible-wall rules. Damage source is either:
//   • 'hand'  — hand-to-wall hit (no weapon)
//   • 'baton' — wall hit while holding a baton
//   • 'bomb'  — bomb explosion within 1 tile
//
// HP thresholds for which sources can damage which walls:
//   WOOD_FENCE → all sources, always
//   WOOD_DOOR  → baton/bomb; below 50% maxHP also hand
//   HEDGE      → bomb only; below 50% also baton; below 25% also hand
// Wall damage is rolled randomly in [MIN, MAX] inclusive — adds variance to
// how many swings/bombs it takes to break a wall, and bumps the average a bit
// over the old fixed values (10/25/80) so destructibles fall slightly faster.
export const WALL_DMG_HAND_MIN  = 10
export const WALL_DMG_HAND_MAX  = 18
export const WALL_DMG_BATON_MIN = 22
export const WALL_DMG_BATON_MAX = 38
export const WALL_DMG_BOMB_MIN  = 80
export const WALL_DMG_BOMB_MAX  = 110

// ── Shield ────────────────────────────────────────────────────────────────────
// Each shield rolls its starting HP between half and 1.5× a player's full
// HP — so a fresh shield can absorb anything from a couple of solid hits to
// most of a player's lifetime worth of damage.
export const SHIELD_MAX_HP_MIN    = Math.floor(PLAYER_MAX_HP * 0.5)   // 50
export const SHIELD_MAX_HP_MAX    = Math.floor(PLAYER_MAX_HP * 1.5)   // 150
// Damage absorbed by shield per attack source — affects shield HP, not player.
export const SHIELD_HIT_BY_HAND   = 5
export const SHIELD_HIT_BY_BATON  = 25
export const SHIELD_HIT_BY_BOMB   = 80

// ── Combat (Phase 5) ─────────────────────────────────────────────────────────
// All attacks (PvP and PvVIP) are processed with this delay so the defender
// has a window to counter-attack and cancel both knockbacks. Sized just
// under ATTACK_COOLDOWN_MS — long enough that a defender who reacts to the
// first swing can land their own click before the original lands; short
// enough that the swinger isn't standing idle for a full second.
export const ATTACK_RESOLVE_DELAY_MS = 700
// While defending (F pressed), incoming damage is reduced and movement slows.
export const DEFENDING_DAMAGE_MULT = 0.5
// Bomb fuse — placed bombs explode after this delay.
export const BOMB_FUSE_MS         = 10_000

// ── NPC ───────────────────────────────────────────────────────────────────────
export const NPC_MOVE_INTERVAL_MS   = 1_500
// How long the VIP tries to bypass a blocking hater before giving up and
// switching to full flee mode. 3 ticks at 1.5 s each = 4.5 s.
export const VIP_BYPASS_MS          = 4_500
// How many Manhattan tiles VIP must travel from the last hater encounter
// before she may stop. Measured from vipFleeOrigin (recorded each time a
// hater becomes adjacent). If a hater catches up during flee the counter
// resets from the new position.
export const VIP_FLEE_TILES         = 8
export const NPC_FOLLOW_RADIUS      = 4      // tiles (cardinal only)

// ── Disconnect grace ──────────────────────────────────────────────────────────
// While connected=false the player stays in state.players so the UI keeps showing
// them with a "reconnecting" indicator and a death countdown.
export const DISCONNECT_DEATH_MS   = 60_000  // mark as dead after 60 s offline
export const DISCONNECT_PURGE_MS   = 120_000  // remove from state after 120 s offline

// ── Maze events ───────────────────────────────────────────────────────────────
// (Dynamic mid-match maze regeneration was removed — every match generates
// the layout once before play and keeps it for the whole game.)
export const ITEM_SPAWN_INTERVAL_MS    = 12_000
// Cap on items lying on the floor at any one time (does NOT count items
// already in players' hands). Bumped from 6 so the maze stays well-stocked.
export const ITEM_MAX                  = 12
// How many items to scatter across the maze the moment the game starts.
// Uses the same weighted RNG as the periodic timer; player spawn tiles are
// already reserved by the time these are placed, so items never overlap them.
export const ITEM_INITIAL_COUNT        = 6
// Hard cap on total batons in play — sum of batons on the floor + batons
// equipped. New baton spawns are rejected once this is reached, so the
// match never spirals into "everyone holds a baton + spares everywhere".
export const BATON_MAX_TOTAL           = 5
// Same idea for shields. Counts ACTIVE shields only — once a shield breaks
// (HP → 0, server clears it from the player) the slot frees up so a new one
// can spawn in the maze.
export const SHIELD_MAX_TOTAL          = 5
// Weighted spawn distribution per tick. Bombs roll twice as often as either
// other item so the maze biases toward explosive plays. (Baton spawns are
// additionally gated by BATON_MAX_TOTAL above.)
export const ITEM_SPAWN_WEIGHTS: Record<string, number> = {
  bomb:   3,
  baton:  1,
  shield: 1,
}

// ── Special zones ─────────────────────────────────────────────────────────────
// Safety zone is now 2×2 (was 3×3). The exact location is template-dependent
// (always opposite the VIP spawn side), so SAFE_ZONE_COLS/_ROWS are no longer
// authoritative — the runtime safety set lives in MazeConfig.safetyTiles.
// These constants are kept only for backwards compat with code that imports
// them as a default; the actual match data overrides them.
export const SAFE_ZONE_COLS = [13, 14]
export const SAFE_ZONE_ROWS = [13, 14]

// VIP_START is similarly nominal — replaced per match by MazeConfig.vipSpawn.
export const VIP_START      = { col: 1, row: 1 }

// ── Shared utilities ──────────────────────────────────────────────────────────
// Exported here so every module can import from one place instead of each
// file defining its own identical copy.
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// ── Testing / debug ────────────────────────────────────────────────────────────
// Set EMPTY_ARENA_MODE = true to disable maze generation entirely.
// Every match will run in an open 16×16 field with only the VIP spawn room
// (concrete perimeter + locked metal doors) and the safety zone present.
// All other tiles are completely open — no walls, no obstacles.
// Revert to false for normal play.
export const EMPTY_ARENA_MODE = false
