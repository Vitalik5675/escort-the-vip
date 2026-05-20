import { Schema, MapSchema, ArraySchema, type } from '@colyseus/schema'
import { WALL_COUNT } from '../../game/constants'

// ── Per-player state ──────────────────────────────────────────────────────────

export class PlayerState extends Schema {
  @type('string')  userId:          string  = ''
  @type('string')  displayName:     string  = ''
  @type('string')  team:            string  = 'none'    // 'none'|'bodyguard'|'hater'
  @type('string')  zone:            string  = 'lobby'   // 'lobby'|'game'|'spectator'
  @type('number')  health:          number  = 100
  @type('number')  maxHealth:       number  = 100
  @type('number')  tileCol:         number  = 8
  @type('number')  tileRow:         number  = 8
  @type('number')  lastDamage:      number  = 0
  @type('number')  lastDamageTime:  number  = 0
  @type('boolean') isAlive:         boolean = true
  @type('boolean') inQueue:         boolean = false

  // Inventory: two hands held independently. Right hand is the weapon slot
  // (baton only); left hand carries either a shield or a bomb. Damage and
  // pickup logic gates on these directly — no aggregate "hasWeapon" flag.
  @type('string')  rightHand:       string  = 'none'    // 'none'|'baton'
  @type('string')  leftHand:        string  = 'none'    // 'none'|'shield'|'bomb'
  @type('number')  shieldHP:        number  = 0
  @type('number')  shieldMaxHP:     number  = 0

  // Defending stance — toggled by F (enter) and E (exit). While true:
  //   • incoming damage × DEFENDING_DAMAGE_MULT
  //   • full block when also holding a shield against a hand-only attacker
  //   • can't enqueue attacks
  //   • walk speed slows on the client (DEFEND_WALK_SPEED)
  @type('boolean') defending:       boolean = false

  @type('number')  spectateTarget:  number  = -1

  // Connection / lag indicators replicated to all clients for HUD
  @type('boolean') connected:       boolean = true
  @type('number')  disconnectedAt:  number  = 0
  @type('number')  ping:            number  = 0

  // Last attacker (for "spectate your killer" handover after death)
  @type('string')  killerId:        string  = ''
}

// ── VIP NPC state ─────────────────────────────────────────────────────────────

export class VIPState extends Schema {
  @type('number')  health:         number  = 200
  @type('number')  maxHealth:      number  = 200
  @type('number')  tileCol:        number  = 1
  @type('number')  tileRow:        number  = 1
  @type('number')  lastDamage:     number  = 0
  @type('number')  lastDamageTime: number  = 0
  @type('boolean') active:         boolean = false
  @type('boolean') reachedSafe:    boolean = false
  // Display name of the bodyguard the VIP currently follows — set when a
  // bodyguard becomes the follower, cleared when she's idle. The client
  // mirrors it into localState.vipFollowingName for the HUD "VIP -> X"
  // indicator.
  @type('string')  targetName:     string  = ''
  @type('string')  followerId:     string  = ''   // sessionId of currently followed bodyguard

  // Server-authoritative move timestamp — clients use this to lag-compensate.
  // The server stamps it whenever the VIP advances one tile; clients can
  // measure their own lag against it and speed up local interpolation.
  @type('number')  lastMoveAt:     number  = 0    // ms (Date.now())

  // Appearance — chosen by the server at startGame so every client sees the
  // same VIP. Indices reference fixed arrays defined on both sides.
  @type('boolean') female:         boolean = false
  @type('number')  outfitIndex:    number  = 0
  @type('number')  skinIndex:      number  = 0
  @type('number')  hairIndex:      number  = 0
  @type('number')  eyeIndex:       number  = 0
}

// ── Past-game result entry (for spectator-zone history board) ─────────────────

export class GameResult extends Schema {
  @type('string') winner:    string = ''
  @type('string') reason:    string = ''
  @type('number') endedAt:   number = 0
  @type('number') durationS: number = 0
}

// ── Item state ────────────────────────────────────────────────────────────────

export class ItemState extends Schema {
  @type('number')  tileCol: number  = 0
  @type('number')  tileRow: number  = 0
  @type('string')  type:    string  = 'baton'    // 'baton'|'shield'|'bomb'
  @type('boolean') active:  boolean = true
}

// ── Bomb state (Phase 5) ─────────────────────────────────────────────────────
// Placed bombs that haven't yet detonated. Replicated so every client can show
// the countdown overlay on the tile.

export class BombState extends Schema {
  @type('number')  tileCol:        number  = 0
  @type('number')  tileRow:        number  = 0
  @type('string')  ownerId:        string  = ''      // sessionId of placer
  @type('number')  fuseEndsAt:     number  = 0       // ms timestamp when it explodes (0 = unarmed)
  // Door-trap mode: when set to a door wall index, the bomb sits unarmed
  // until that door opens from the OPPOSITE side, then detonates. Picking it
  // back up requires the player to stand on the bomb's tile (same side).
  @type('number')  triggerWallIdx: number  = -1
  @type('boolean') armed:          boolean = true    // false = waiting for trigger
}

// ── Root game state ───────────────────────────────────────────────────────────

export class GameState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>()
  @type({ map: ItemState })   items   = new MapSchema<ItemState>()
  @type({ map: BombState })   bombs   = new MapSchema<BombState>()

  @type(VIPState) vip = new VIPState()

  // Maze — flat arrays (480 elements each)
  @type(['uint8']) wallTypes  = new ArraySchema<number>(...new Array(WALL_COUNT).fill(0))
  @type(['uint8']) wallStates = new ArraySchema<number>(...new Array(WALL_COUNT).fill(0))
  @type(['uint8']) wallHP     = new ArraySchema<number>(...new Array(WALL_COUNT).fill(0))
  @type(['uint8']) wallMaxHP  = new ArraySchema<number>(...new Array(WALL_COUNT).fill(0))

  // Door-claim mirror: which team currently blocks the door, and which teams
  // have already poked it (failed open attempt). Drives per-team door colour
  // on the client.
  //   wallClaimTeams[i]: 0 = no claim, 1 = bodyguard, 2 = hater
  //   wallClaimAck[i]:   bitfield — bit 1 = bodyguard tried it, bit 2 = hater
  @type(['uint8']) wallClaimTeams = new ArraySchema<number>(...new Array(WALL_COUNT).fill(0))
  @type(['uint8']) wallClaimAck   = new ArraySchema<number>(...new Array(WALL_COUNT).fill(0))

  // Maze metadata for HUD + client-side decisions
  @type('string')  mazeTemplateId:    string  = ''

  // VIP room lock — see VIP_ROOM_LOCK_S in constants.
  @type('boolean') vipRoomLocked:    boolean = true

  // Game flow
  @type('string') phase:         string = 'lobby'
  @type('number') countdown:     number = 0
  @type('number') timeRemaining: number = 0
  @type('string') winner:        string = ''

  @type('number') playerCount: number = 0
  @type('number') queueCount:  number = 0

  @type([GameResult]) history = new ArraySchema<GameResult>()
}
