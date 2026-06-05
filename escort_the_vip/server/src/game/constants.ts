// Structural constants — values that must NEVER change at runtime because the
// schema and client code depend on them (grid layout, wall/state enums, byte
// indexes). Tunable balance values (HP, damage, timers, item caps, maze
// options, VIP appearance) live in server/config.json and are hot-reloadable
// — see ./config.ts.

// ── Grid ──────────────────────────────────────────────────────────────────────
export const GRID_COLS = 16
export const GRID_ROWS = 16
export const TILE_SIZE  = 2   // metres per tile side

// ── Scene geometry ────────────────────────────────────────────────────────────
export const GAME_ZONE_Y      = 15   // Y of game-zone floor (metres above ground)
export const WALL_HEIGHT      = 2.5  // metres
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
export const WALL_NONE       = 0  // open passage
export const WALL_CONCRETE   = 1  // indestructible solid
export const WALL_HEDGE      = 2  // bush wall — destructible by bomb (baton/hand at HP thresholds)
export const WALL_WOOD_WALL  = 3  // destructible by everything (hand/baton/bomb)
export const WALL_WOOD_DOOR  = 4  // movable, destructible

// ── Wall states ───────────────────────────────────────────────────────────────
export const STATE_SOLID     = 0  // solid / door closed / fence intact
export const STATE_OPEN      = 1  // door open
export const STATE_DESTROYED = 2  // fence / wood door destroyed
export const STATE_BLOCKED   = 3  // door cannot move (hostile on far side)

// ── Wall HP defaults (per type) — kept only for legacy paths that need a
// non-random default. The runtime uses randomWallHp() from ./config.ts.
export const WALL_HP_DEFAULT: Record<number, number> = {
  [WALL_NONE]:      0,
  [WALL_CONCRETE]:  0,
  [WALL_HEDGE]:   100,
  [WALL_WOOD_WALL]: 50,
  [WALL_WOOD_DOOR]: 80,
}

// Wall types that cannot be destroyed under any circumstances.
export const INDESTRUCTIBLE_WALL_TYPES = new Set<number>([
  WALL_CONCRETE,
])

// ── Special zones ─────────────────────────────────────────────────────────────
// Safety zone is now 2×2 (was 3×3). The exact location is template-dependent
// (always opposite the VIP spawn side), so SAFE_ZONE_COLS/_ROWS are no longer
// authoritative — the runtime safety set lives in MazeConfig.safetyTiles.
export const SAFE_ZONE_COLS = [13, 14]
export const SAFE_ZONE_ROWS = [13, 14]

// VIP_START is nominal — replaced per match by MazeConfig.vipSpawn.
export const VIP_START      = { col: 1, row: 1 }

// ── Shared utilities ──────────────────────────────────────────────────────────
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
