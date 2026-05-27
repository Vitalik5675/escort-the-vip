// ── Local (client-only) game state ────────────────────────────────────────────
// Server state lives in Colyseus room.state; this holds UI/visual-only state.

export type LocalZone = 'lobby' | 'game' | 'spectator'

export interface PlayerEntry {
  sessionId:        string
  name:             string
  team:             string
  hp:               number
  maxHp:            number
  isAlive:          boolean
  connected:        boolean   // false → reconnecting indicator + death countdown
  ping:             number    // last reported round-trip ms (0 if unknown)
  secondsUntilDead: number    // > 0 only while disconnected; 0 once dead/connected
}

export interface LocalState {
  // Connection
  connected:       boolean
  lastConnectedMs: number   // Date.now() when last connected

  // Player identity (from DCL getPlayer)
  myUserId:        string
  mySessionId:     string

  // Zone
  zone:            LocalZone
  prevZone:        LocalZone   // for reconnect restore

  // Game phase (mirror of server, cached for UI reactivity)
  phase:           string   // 'lobby'|'countdown'|'playing'|'ended'
  timeRemaining:   number
  countdown:       number
  winner:          string
  winReason:       string   // 'timeout'|'vip_safe'|'vip_killed'|'elimination'

  // My game state
  myTeam:          string   // 'none'|'bodyguard'|'hater'
  myHealth:        number
  myMaxHealth:     number
  // Two-handed inventory mirrored from PlayerState. Right hand = baton slot,
  // left hand = shield/bomb slot. UI + click handlers gate behaviour on these
  // (e.g. wood-door click attacks only when myRightHand === 'baton').
  myRightHand:     string   // 'none'|'baton'
  myLeftHand:      string   // 'none'|'shield'|'bomb'
  myShieldHP:      number
  myShieldMaxHP:   number
  // Defending stance — F toggles on, E off. Triggers slowed walk locally and
  // a damage-reduction / counter-attack window server-side.
  myDefending:     boolean

  // Maze metadata
  mazeTemplateId:    string
  vipRoomLocked:     boolean

  // Active bombs in the arena, indexed by key. Server pushes this list on
  // bomb_placed and removes on bomb_explode. Used to render countdown overlays.
  activeBombs:      Array<{ key: string; col: number; row: number; fuseEndsAt: number; armed: boolean; triggerWallIdx: number }>

  // Spectator
  spectatedIds:    string[]  // session IDs of players in game zone
  spectateIndex:   number    // index into spectatedIds

  // Visual helpers
  lastHitTimeMs:   number   // for screen flash
  disconnectedMs:  number   // 0 = connected, else timestamp when lost

  // In-game position (tile)
  myTileCol:       number
  myTileRow:       number

  // Flag: game zone entities visible
  gameZoneVisible: boolean

  // Save last game-zone tile when disconnected (for teleport-back)
  savedTileCol:    number
  savedTileRow:    number

  // Spectator mode (persists across physical zone changes)
  isSpectating:    boolean

  // All in-game players (for right-side HP list)
  playerList:      PlayerEntry[]

  // VIP follow indicator (synced from server VIPState.targetName)
  vipFollowingName: string

  // SessionId of the bodyguard currently escorting VIP ('' if none).
  // Compared against mySessionId so the escorting BG can hide VIP's hitbox.
  vipFollowerId: string

  // Timestamp until which non-escorting bodyguards cannot click VIP.
  // Set when another BG claims VIP; cleared when VIP becomes unescorted.
  vipFollowCooldownUntil: number

  // VIP HP (synced from server VIPState, displayed in HUD)
  vipHp:    number
  vipMaxHp: number

  // Currently spectated entity HP (for 2D UI bar, non-VIP targets)
  watchedName:  string
  watchedHp:    number
  watchedMaxHp: number

  // Local ping (round-trip ms to server, refreshed each pong)
  myPing: number

  // VIP appearance config (mirrored from server VIPState).
  vipAppearanceMode: string  // 'random'|'female'|'male'|'player'
  vipPlayerWallet:   string  // wallet address for 'player' mode

  // How to Play modal — toggled by the lobby cube west-face button.
  showHowToPlay: boolean

  // Lobby image-banner modal — set to the texture path of the clicked plane,
  // empty string when no modal is open. Toggle: clicking the same plane again
  // (or the modal backdrop / close button) sets it back to ''.
  lobbyImageModalUrl: string

  // Server-side ALLOW_ALL_TILE_OVERLAP mirror. When true:
  //   • enemy player hitboxes drop their physicsBox (only clickBox stays)
  //   • VIP hitbox drops CL_PHYSICS for haters
  // Synced from scene_config. Defaults to false until the first message.
  allowAllTileOverlap: boolean

  // Ephemeral feedback toast (e.g. "Need bomb to break this hedge").
  // Cleared when toastExpiresAt < now.
  toastText:      string
  toastExpiresAt: number

  // Currently-hovered destructible wall — drives the bottom-centre info panel.
  // -1 = no wall hovered. expiresAt is a soft timeout so the panel doesn't
  // disappear instantly when the cursor leaves (avoids flicker on junctions).
  hoveredWallIdx:        number
  hoveredWallExpiresAt:  number
  wallHpVisible:         boolean   // true only when E was pressed on a wall with HP

  // Recent damage HUD. Both buckets accumulate while incoming/outgoing hits
  // arrive within DAMAGE_WINDOW_MS of each other (counter-attack window in
  // the same swing → summed). The label fades over the next ~1 s once the
  // window closes; ui.tsx reads these directly.
  dmgDealtAmount:    number   // sum, resets when window closes
  dmgDealtUntilMs:   number   // accumulation window deadline
  dmgDealtShownMs:   number   // visual hide deadline (window + fade)
  dmgRecvAmount:     number
  dmgRecvUntilMs:    number
  dmgRecvShownMs:    number
}

const state: LocalState = {
  connected:       false,
  lastConnectedMs: 0,
  myUserId:        '',
  mySessionId:     '',
  zone:            'lobby',
  prevZone:        'lobby',
  phase:           'lobby',
  timeRemaining:   0,
  countdown:       0,
  winner:          '',
  winReason:       '',
  myTeam:          'none',
  myHealth:        100,
  myMaxHealth:     100,
  myRightHand:     'none',
  myLeftHand:      'none',
  myShieldHP:      0,
  myShieldMaxHP:   0,
  myDefending:     false,
  mazeTemplateId:    '',
  vipRoomLocked:     true,
  activeBombs:       [],
  spectatedIds:    [],
  spectateIndex:   0,
  lastHitTimeMs:   0,
  disconnectedMs:  0,
  myTileCol:       8,
  myTileRow:       8,
  gameZoneVisible: true,
  savedTileCol:    8,
  savedTileRow:    8,
  isSpectating:    false,
  playerList:       [],
  vipFollowingName:       '',
  vipFollowerId:          '',
  vipFollowCooldownUntil: 0,
  vipHp:                  0,
  vipMaxHp:               0,
  watchedName:      '',
  watchedHp:        0,
  watchedMaxHp:     0,
  myPing:           0,
  vipAppearanceMode: 'random',
  vipPlayerWallet:   '',
  showHowToPlay:    false,
  lobbyImageModalUrl: '',
  allowAllTileOverlap: false,
  toastText:        '',
  toastExpiresAt:   0,
  hoveredWallIdx:        -1,
  hoveredWallExpiresAt:  0,
  wallHpVisible:         false,
  dmgDealtAmount:        0,
  dmgDealtUntilMs:       0,
  dmgDealtShownMs:       0,
  dmgRecvAmount:         0,
  dmgRecvUntilMs:        0,
  dmgRecvShownMs:        0,
}

export function getLocalState(): LocalState { return state }

export function patchLocalState(patch: Partial<LocalState>) {
  Object.assign(state, patch)
}

/** Returns true if the local player should be in the game zone right now. */
export function isInGameZone(): boolean {
  return state.zone === 'game'
}

/** Returns true if we're watching someone. */
export function isSpectating(): boolean {
  return state.zone === 'spectator'
}

// ── Spectate-switch callback (avoids DOM CustomEvent in DCL environment) ───────

let _onSpectateSwitchCb: ((idx: number) => void) | null = null
export function setSpectateSwitchCallback(cb: (idx: number) => void) { _onSpectateSwitchCb = cb }
export function fireSpectateSwitchCallback(idx: number) { _onSpectateSwitchCb?.(idx) }
