// ── Grid ──────────────────────────────────────────────────────────────────────
export const GRID_COLS = 16
export const GRID_ROWS = 16
export const TILE_SIZE = 2   // metres

// ── Game-zone world geometry ──────────────────────────────────────────────────
export const GAME_ZONE_Y      = 15    // floor Y
export const WALL_HEIGHT      = 2.5
export const WALL_THICKNESS   = 0.2

// Arena footprint derived from grid — change GRID_COLS / GRID_ROWS / TILE_SIZE
// and every perimeter wall, floor, trigger and camera area resizes with it.
export const ARENA_WIDTH      = GRID_COLS * TILE_SIZE   // X-extent in metres
export const ARENA_DEPTH      = GRID_ROWS * TILE_SIZE   // Z-extent in metres
export const ARENA_CX         = ARENA_WIDTH / 2
export const ARENA_CZ         = ARENA_DEPTH / 2
export const GAME_ZONE_CENTER = { x: ARENA_CX, y: GAME_ZONE_Y + WALL_HEIGHT / 2, z: ARENA_CZ }

// ── Wall-index helpers (must match server) ────────────────────────────────────
export const H_WALL_COUNT = (GRID_ROWS - 1) * GRID_COLS   // 240
export const V_WALL_COUNT = GRID_ROWS * (GRID_COLS - 1)   // 240
export const WALL_COUNT   = H_WALL_COUNT + V_WALL_COUNT   // 480

export function hWallIndex(r: number, c: number): number { return r * GRID_COLS + c }
export function vWallIndex(r: number, c: number): number { return H_WALL_COUNT + r * (GRID_COLS - 1) + c }

// Two tiles flanking a wall. Mirrors GameRoom#wallSidesTiles.
export function wallSidesTiles(idx: number): { a: { col: number; row: number }; b: { col: number; row: number } } {
  const isH = idx < H_WALL_COUNT
  if (isH) {
    const r = (idx / GRID_COLS) | 0
    const c = idx % GRID_COLS
    return { a: { col: c, row: r }, b: { col: c, row: r + 1 } }
  }
  const r = ((idx - H_WALL_COUNT) / (GRID_COLS - 1)) | 0
  const c = (idx - H_WALL_COUNT) % (GRID_COLS - 1)
  return { a: { col: c, row: r }, b: { col: c + 1, row: r } }
}

// ── Wall type constants (mirrors server) ──────────────────────────────────────
export const WALL_NONE      = 0
export const WALL_CONCRETE  = 1
export const WALL_HEDGE     = 2
export const WALL_WOOD_WALL = 3
export const WALL_WOOD_DOOR = 4

export const STATE_SOLID     = 0
export const STATE_OPEN      = 1
export const STATE_DESTROYED = 2
export const STATE_BLOCKED   = 3

// ── Difficulty (mirrors server) ───────────────────────────────────────────────
export const DIFFICULTY_EASY   = 0
export const DIFFICULTY_MEDIUM = 1
export const DIFFICULTY_HARD   = 2

// ── Scene zones (world coords) ────────────────────────────────────────────────
export const LOBBY_Y_MIN       = 0
export const LOBBY_Y_MAX       = 5
export const SPECTATOR_CENTER  = { x: 16, y: 2, z: 16 }
export const SPECTATOR_SIZE    = 4

// ── Safe zone (nominal — actual tiles arrive per-match in MazeConfig) ────────
// Kept for any code that still imports them as a default. The authoritative
// per-match safety zone is broadcast with the maze layout.
export const SAFE_ZONE_COLS = [13, 14]
export const SAFE_ZONE_ROWS = [13, 14]

// ── World position helpers ────────────────────────────────────────────────────

/** Centre world X of tile column c */
export function tileToWorldX(c: number): number { return c * TILE_SIZE + TILE_SIZE / 2 }

/** Centre world Z of tile row r */
export function tileToWorldZ(r: number): number { return r * TILE_SIZE + TILE_SIZE / 2 }

/** Floor Y in game zone for standing entities */
export const GAME_FLOOR_Y = GAME_ZONE_Y

/** Derive tile col from world X */
export function worldToTileCol(x: number): number { return Math.floor(x / TILE_SIZE) }

/** Derive tile row from world Z */
export function worldToTileRow(z: number): number { return Math.floor(z / TILE_SIZE) }

// World position of a horizontal wall (between row r and r+1, at col c)
export function hWallWorldPos(r: number, c: number) {
  return { x: tileToWorldX(c), y: GAME_ZONE_Y + WALL_HEIGHT / 2, z: (r + 1) * TILE_SIZE }
}
// World position of a vertical wall (between col c and c+1, at row r)
export function vWallWorldPos(r: number, c: number) {
  return { x: (c + 1) * TILE_SIZE, y: GAME_ZONE_Y + WALL_HEIGHT / 2, z: tileToWorldZ(r) }
}
// Scale of H-wall entity — shortened by WALL_THICKNESS so adjacent walls don't share faces
export const H_WALL_SCALE = { x: TILE_SIZE - WALL_THICKNESS, y: WALL_HEIGHT, z: WALL_THICKNESS }
// Scale of V-wall entity
export const V_WALL_SCALE = { x: WALL_THICKNESS, y: WALL_HEIGHT, z: TILE_SIZE - WALL_THICKNESS }


