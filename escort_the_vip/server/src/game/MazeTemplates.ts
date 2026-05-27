// Random VIP-room and safety-zone placement helpers. Templates and static
// region definitions are gone — every match generates a fresh procedural maze
// in MazeGenerator, with these helpers controlling only where the VIP starts
// and where the bodyguards must escort her.

import { GRID_COLS, GRID_ROWS, randInt } from './constants'

export type RegionSide = 'N' | 'S' | 'E' | 'W'

export interface PlacementResult {
  vipRoom:     { colMin: number; colMax: number; rowMin: number; rowMax: number }
  vipRoomDoor: { side: RegionSide }    // which side of the room has the door
  vipSpawn:    { col: number; row: number }   // VIP starting tile (centre of room)
  safetyZone:  { colMin: number; colMax: number; rowMin: number; rowMax: number }
  vipSide:     RegionSide               // arena edge the VIP room hugs
}

const ALL_SIDES: RegionSide[] = ['N', 'S', 'E', 'W']

function oppositeSide(s: RegionSide): RegionSide {
  return s === 'N' ? 'S' : s === 'S' ? 'N' : s === 'E' ? 'W' : 'E'
}

// Build a 3×3 VIP room hugged against `vipSide` and a 2×2 safety zone hugged
// against the opposite arena edge. Both placements are randomised along their
// respective sides so every match feels fresh.
export function placeVipAndSafetyRandom(): PlacementResult {
  const vipSide = ALL_SIDES[(Math.random() * ALL_SIDES.length) | 0]
  return placeAlongSides(vipSide)
}

function placeAlongSides(vipSide: RegionSide): PlacementResult {

  let vRoom: PlacementResult['vipRoom']
  let vDoorSide: RegionSide
  let safety: PlacementResult['safetyZone']

  // VIP room is always 3×3, safety zone always 2×2. The "long-axis" offset is
  // randomised; the cross-axis is fixed to the arena edge.
  switch (vipSide) {
    case 'W': {
      const r = randInt(0, GRID_ROWS - 3)
      vRoom = { colMin: 0, colMax: 2, rowMin: r, rowMax: r + 2 }
      vDoorSide = 'E'
      const sr = randInt(0, GRID_ROWS - 2)
      safety = { colMin: GRID_COLS - 2, colMax: GRID_COLS - 1, rowMin: sr, rowMax: sr + 1 }
      break
    }
    case 'E': {
      const r = randInt(0, GRID_ROWS - 3)
      vRoom = { colMin: GRID_COLS - 3, colMax: GRID_COLS - 1, rowMin: r, rowMax: r + 2 }
      vDoorSide = 'W'
      const sr = randInt(0, GRID_ROWS - 2)
      safety = { colMin: 0, colMax: 1, rowMin: sr, rowMax: sr + 1 }
      break
    }
    case 'N': {
      const c = randInt(0, GRID_COLS - 3)
      vRoom = { colMin: c, colMax: c + 2, rowMin: 0, rowMax: 2 }
      vDoorSide = 'S'
      const sc = randInt(0, GRID_COLS - 2)
      safety = { colMin: sc, colMax: sc + 1, rowMin: GRID_ROWS - 2, rowMax: GRID_ROWS - 1 }
      break
    }
    case 'S':
    default: {
      const c = randInt(0, GRID_COLS - 3)
      vRoom = { colMin: c, colMax: c + 2, rowMin: GRID_ROWS - 3, rowMax: GRID_ROWS - 1 }
      vDoorSide = 'N'
      const sc = randInt(0, GRID_COLS - 2)
      safety = { colMin: sc, colMax: sc + 1, rowMin: 0, rowMax: 1 }
      break
    }
  }

  const vipSpawn = {
    col: ((vRoom.colMin + vRoom.colMax) / 2) | 0,
    row: ((vRoom.rowMin + vRoom.rowMax) / 2) | 0,
  }
  return { vipRoom: vRoom, vipRoomDoor: { side: vDoorSide }, vipSpawn, safetyZone: safety, vipSide }
}
