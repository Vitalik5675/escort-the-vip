import ReactEcs, { ReactEcsRenderer, UiEntity, Label, Button } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getLocalState, fireSpectateSwitchCallback, patchLocalState, PlayerEntry, LocalState } from './state/localState'
import { getFlashAlpha } from './game/screenEffects'
import { sendToRoom, getRoom } from './colyseus-client'
import { wallSidesTiles, hWallIndex, vWallIndex,
         STATE_OPEN, STATE_DESTROYED,
         WALL_HEDGE, WALL_WOOD_WALL, WALL_WOOD_DOOR } from './game/constants'





// ── Wall helpers ──────────────────────────────────────────────────────────────

function wallTypeName(t: number): string {
  if (t === WALL_HEDGE)     return 'Hedge'
  if (t === WALL_WOOD_WALL) return 'Wood wall'
  if (t === WALL_WOOD_DOOR) return 'Wood door'
  return ''
}

function wallDamageSources(t: number, hp: number, maxHp: number): string {
  const frac = maxHp > 0 ? hp / maxHp : 0
  if (t === WALL_HEDGE) {
    if (frac < 0.25) return 'Hand, Baton, Bomb'
    if (frac < 0.5)  return 'Baton, Bomb'
    return 'Bomb only'
  }
  if (t === WALL_WOOD_DOOR) {
    if (frac < 0.5) return 'Hand, Baton, Bomb'
    return 'Baton, Bomb'
  }
  if (t === WALL_WOOD_WALL) return 'Hand, Baton, Bomb'
  return ''
}

// ── Inventory glyphs ──────────────────────────────────────────────────────────

function handIcon(item: string): string {
  switch (item) {
    case 'baton':  return 'Baton'
    case 'shield': return 'Shield'
    case 'bomb':   return 'Bomb'
    default:       return '-'
  }
}

// Returns true when the wall at wallIdx physically blocks an explosion
// (i.e. it exists, is not destroyed, and is not an open door).
function wallBlocksBlast(wallTypes: any, wallStates: any, wallIdx: number): boolean {
  const t = (wallTypes?.[wallIdx]  | 0) as number
  const s = (wallStates?.[wallIdx] | 0) as number
  if (t === 0) return false                                        // WALL_NONE
  if (s === STATE_DESTROYED) return false                          // destroyed
  if (t === WALL_WOOD_DOOR && s === STATE_OPEN) return false
  return true
}

// Bombs whose 1-tile radius covers the local player's tile. Used to render a
// countdown warning in the HUD.
// Skips bombs that are separated from the player by a solid wall (the wall
// absorbs the blast, so the player is safe and shouldn't be warned).
// Door-trap bombs (armed=false, triggerWallIdx>=0) are hidden from players on
// the OPPOSITE side of the door — the whole point of a trap is invisible.
function bombsInRadius(s: LocalState) {
  const myCol = s.myTileCol, myRow = s.myTileRow
  const room = getRoom()
  const wt = room?.state?.wallTypes  as any
  const ws = room?.state?.wallStates as any

  return s.activeBombs.filter(b => {
    // Unarmed door-traps (armed=false) have no countdown and never self-detonate.
    // The world overlay already shows 'TRAP' on the tile — no HUD warning needed.
    // Including them would show misleading "BOMB! 0s" (since fuseEndsAt=0).
    if (!b.armed) return false

    const dCol = myCol - b.col
    const dRow = myRow - b.row
    const manhattan = Math.abs(dCol) + Math.abs(dRow)
    if (manhattan > 1) return false   // out of blast radius

    // Check the wall on the boundary between bomb tile and player tile.
    // If it blocks blast, the player is safe — no warning needed.
    if (manhattan === 1) {
      let wallIdx: number
      if      (dRow ===  1) wallIdx = hWallIndex(b.row,     b.col    )  // player south
      else if (dRow === -1) wallIdx = hWallIndex(b.row - 1, b.col    )  // player north
      else if (dCol ===  1) wallIdx = vWallIndex(b.row,     b.col    )  // player east
      else                  wallIdx = vWallIndex(b.row,     b.col - 1)  // player west
      if (wallBlocksBlast(wt, ws, wallIdx)) return false
    }

    // Door-trap: hide the notification if the local player is on the opposite
    // side of the door from the bomb (they're the intended target).
    if (!b.armed && b.triggerWallIdx >= 0) {
      const sides  = wallSidesTiles(b.triggerWallIdx)
      const bombOnA = sides.a.col === b.col && sides.a.row === b.row
      const opp     = bombOnA ? sides.b : sides.a
      if (myCol === opp.col && myRow === opp.row) return false
    }

    return true
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(s: number): string {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function winReasonText(winner: string, reason: string): string {
  if (reason === 'admin_end') return 'Match ended by admin'
  if (winner === 'bodyguards') {
    if (reason === 'vip_safe')    return 'VIP safely reached the safe zone'
    if (reason === 'elimination') return 'All haters were eliminated'
  }
  if (winner === 'draw') {
    if (reason === 'vip_killed')  return 'VIP was eliminated by friendly fire'
    return 'Time ran out — VIP survived but never reached the safe zone'
  }
  if (winner === 'haters') {
    if (reason === 'vip_killed')  return 'VIP was eliminated'
    if (reason === 'elimination') return 'All bodyguards were eliminated'
  }
  return ''
}

// Single HP-bar colour function used for players, VIP, and wall bars alike.
// Takes a fraction 0..1 (0 = empty, 1 = full).
function hpBarColor(frac: number): Color4 {
  if (frac > 0.6) return Color4.create(0.3, 0.85, 0.3, 1)
  if (frac > 0.3) return Color4.create(1,   0.80, 0.25, 1)
  return Color4.create(1, 0.35, 0.2, 1)
}

// Per-player suffix: only shown for offline players (countdown / disconnected
// indicator). Plain ASCII so DCL's font renders it consistently.
function connSuffix(p: PlayerEntry): string {
  if (p.connected) return ''
  if (p.isAlive && p.secondsUntilDead > 0) return `  (${p.secondsUntilDead}s)`
  return '  (off)'
}

// Connection dot prepended to the name.
// ● = online, ○ = offline/reconnecting. The actual colour is driven by the
// Label's `color` prop (orange for offline, team-colour for alive, grey for dead).
function connDot(p: PlayerEntry): string {
  return p.connected ? '● ' : '○ '
}

function pingColor(ms: number): Color4 {
  if (ms <= 0)   return Color4.create(0.6, 0.6, 0.6, 1)
  if (ms < 100)  return Color4.create(0.4, 0.9, 0.4, 1)
  if (ms < 250)  return Color4.create(1, 0.85, 0.3, 1)
  return Color4.create(1, 0.4, 0.4, 1)
}

// ── Spectator callbacks ───────────────────────────────────────────────────────

function prevPlayer() {
  const s = getLocalState()
  if (s.spectatedIds.length === 0) return
  const idx = (s.spectateIndex - 1 + s.spectatedIds.length) % s.spectatedIds.length
  patchLocalState({ spectateIndex: idx })
  fireSpectateSwitchCallback(idx)
}

function nextPlayer() {
  const s = getLocalState()
  if (s.spectatedIds.length === 0) return
  const idx = (s.spectateIndex + 1) % s.spectatedIds.length
  patchLocalState({ spectateIndex: idx })
  fireSpectateSwitchCallback(idx)
}

function stopSpectate() {
  sendToRoom('stop_spectate', {})
}

// ── How to Play modal ─────────────────────────────────────────────────────────

function closeHowToPlay() {
  patchLocalState({ showHowToPlay: false })
}

const HowToPlayModal = () => {
  const fuseSec = Math.round(getLocalState().bombFuseMs / 1000)
  return (
  <UiEntity
    uiTransform={{
      width: '100%', height: '100%',
      positionType: 'absolute', position: { top: 0, left: 0 },
      alignItems: 'center', justifyContent: 'center'
    }}
    uiBackground={{ color: Color4.create(0, 0, 0, 0.7) }}
  >
    <UiEntity
      uiTransform={{
        width: 620, flexDirection: 'column',
        alignItems: 'center', justifyContent: 'flex-start',
        padding: { top: 0, bottom: 16, left: 0, right: 0 }
      }}
      uiBackground={{ color: Color4.create(0.06, 0.07, 0.11, 1) }}
    >
      {/* Header */}
      <UiEntity
        uiTransform={{ width: 620, height: 52, alignItems: 'center', justifyContent: 'center' }}
        uiBackground={{ color: Color4.create(0.1, 0.12, 0.18, 1) }}
      >
        <Label value="How to Play  ?" fontSize={24} color={Color4.create(1, 0.85, 0.3, 1)}
          uiTransform={{ width: 580, height: 44 }} />
      </UiEntity>

      {/* SPAWN NOTE */}
      <UiEntity
        uiTransform={{ width: 590, flexDirection: 'column', margin: { top: 12 } }}
        uiBackground={{ color: Color4.create(0.18, 0.14, 0.04, 1) }}
      >
        <Label value="⚠  Everyone spawns randomly in the maze."
          fontSize={13} color={Color4.create(1, 0.85, 0.3, 1)} uiTransform={{ width: 580, height: 22, margin: { top: 6, left: 8 } }} />
        <Label value="   Find the VIP (glowing column) and your teammates!"
          fontSize={13} color={Color4.create(1, 0.85, 0.3, 1)} uiTransform={{ width: 580, height: 22, margin: { bottom: 6, left: 8 } }} />
      </UiEntity>

      {/* Divider */}
      <UiEntity uiTransform={{ width: 590, height: 1, margin: { top: 10, bottom: 2 } }}
        uiBackground={{ color: Color4.create(0.25, 0.25, 0.3, 1) }} />

      {/* GOAL */}
      <UiEntity uiTransform={{ width: 590, flexDirection: 'column', margin: { top: 8 } }}>
        <Label value="▶  GOAL" fontSize={15} color={Color4.create(0.9, 0.9, 0.5, 1)}
          uiTransform={{ width: 590, height: 22 }} />
        <Label value="Bodyguards — escort VIP to the green safe zone"
          fontSize={13} color={Color4.create(0.5, 0.8, 1, 1)} uiTransform={{ width: 590, height: 20 }} />
        <Label value="Haters — kill the VIP before time runs out"
          fontSize={13} color={Color4.create(1, 0.45, 0.45, 1)} uiTransform={{ width: 590, height: 20 }} />
      </UiEntity>

      {/* Divider */}
      <UiEntity uiTransform={{ width: 590, height: 1, margin: { top: 10, bottom: 2 } }}
        uiBackground={{ color: Color4.create(0.25, 0.25, 0.3, 1) }} />

      {/* BODYGUARDS */}
      <UiEntity uiTransform={{ width: 590, flexDirection: 'column', margin: { top: 8 } }}>
        <Label value="▶  BODYGUARDS" fontSize={15} color={Color4.create(0.4, 0.75, 1, 1)}
          uiTransform={{ width: 590, height: 22 }} />
        <Label value="• Click VIP to escort her — she follows you automatically"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• Lead VIP to the green safe zone to win"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• Click enemies to attack when standing next to them"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• F — defend (no shield: -25% dmg; with shield: 0 dmg received)"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• Attacking while defending deals 25% less damage"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
      </UiEntity>

      {/* Divider */}
      <UiEntity uiTransform={{ width: 590, height: 1, margin: { top: 10, bottom: 2 } }}
        uiBackground={{ color: Color4.create(0.25, 0.25, 0.3, 1) }} />

      {/* HATERS */}
      <UiEntity uiTransform={{ width: 590, flexDirection: 'column', margin: { top: 8 } }}>
        <Label value="▶  HATERS" fontSize={15} color={Color4.create(1, 0.4, 0.4, 1)}
          uiTransform={{ width: 590, height: 22 }} />
        <Label value="• Click VIP to attack — she flees when hit"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• Click bodyguards to eliminate them"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value={`• E — place a bomb (${fuseSec} s fuse) or aim at a door to set a trap`}
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• F — defend to reduce incoming damage"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
      </UiEntity>

      {/* Divider */}
      <UiEntity uiTransform={{ width: 590, height: 1, margin: { top: 10, bottom: 2 } }}
        uiBackground={{ color: Color4.create(0.25, 0.25, 0.3, 1) }} />

      {/* ITEMS & WALLS */}
      <UiEntity uiTransform={{ width: 590, flexDirection: 'column', margin: { top: 8 } }}>
        <Label value="▶  ITEMS" fontSize={15} color={Color4.create(0.9, 0.9, 0.5, 1)}
          uiTransform={{ width: 590, height: 22 }} />
        <Label value="• Baton — bonus melee damage   Shield — absorbs damage when defending"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value={`• Bomb — press E to place; ${fuseSec} s countdown then explodes`}
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• Walk close and click an item on the ground to pick it up"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
      </UiEntity>

      {/* Divider */}
      <UiEntity uiTransform={{ width: 590, height: 1, margin: { top: 10, bottom: 2 } }}
        uiBackground={{ color: Color4.create(0.25, 0.25, 0.3, 1) }} />

      {/* WALLS */}
      <UiEntity uiTransform={{ width: 590, flexDirection: 'column', margin: { top: 8 } }}>
        <Label value="▶  WALLS" fontSize={15} color={Color4.create(0.9, 0.9, 0.5, 1)}
          uiTransform={{ width: 590, height: 22 }} />
        <Label value="• Hedge — bomb or baton (hover to see HP)"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• Wood wall — any attack breaks it"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• Concrete — indestructible; stripe colour shows VIP danger level"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="• Doors — bomb them or set a trap; VIP room unlocks mid-game"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
      </UiEntity>

      {/* Divider */}
      <UiEntity uiTransform={{ width: 590, height: 1, margin: { top: 10, bottom: 2 } }}
        uiBackground={{ color: Color4.create(0.25, 0.25, 0.3, 1) }} />

      {/* CONTROLS */}
      <UiEntity uiTransform={{ width: 590, flexDirection: 'column', margin: { top: 8 } }}>
        <Label value="▶  CONTROLS" fontSize={15} color={Color4.create(0.9, 0.9, 0.5, 1)}
          uiTransform={{ width: 590, height: 22 }} />
        <Label value="WASD — move     Click — attack / interact"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
        <Label value="F — defend     E — cancel defend / place bomb / attack wall"
          fontSize={12} color={Color4.White()} uiTransform={{ width: 590, height: 18 }} />
      </UiEntity>

      {/* Close button */}
      <Button
        value="✕  Close"
        variant="secondary"
        fontSize={15}
        uiTransform={{ width: 160, height: 40, margin: { top: 16 } }}
        onMouseDown={closeHowToPlay}
      />
    </UiEntity>
  </UiEntity>
  )
}

// ── Lobby image-banner modal ──────────────────────────────────────────────────
// Opened by clicking a left-wall plane (lobby.ts toggleLobbyImage). Backdrop is
// also clickable — touching anywhere closes it. Image scales to fit most of
// the screen (1440 × 900); the "✕ Close" button sits below in the same style
// as HowToPlayModal.

function closeLobbyImage() {
  patchLocalState({ lobbyImageModalUrl: '' })
}

const LobbyImageModal = ({ url }: { url: string }) => (
  <UiEntity
    uiTransform={{
      width: '100%', height: '100%',
      positionType: 'absolute', position: { top: 0, left: 0 },
      alignItems: 'center', justifyContent: 'center'
    }}
    uiBackground={{ color: Color4.create(0, 0, 0, 0.78) }}
    onMouseDown={closeLobbyImage}
  >
    <UiEntity
      uiTransform={{
        width: 1100, flexDirection: 'column',
        alignItems: 'center', justifyContent: 'flex-start',
      }}
    >
      {/* The image itself — sized to leave breathing room around the DCL HUD
          (top profile bar, side widgets, bottom chat). 1100×690 leaves ~10%
          margin on a 1280-wide reference viewport. */}
      <UiEntity
        uiTransform={{ width: 1100, height: 690 }}
        uiBackground={{
          texture: { src: url },
          textureMode: 'stretch',
        }}
      />

      {/* Close button — same style as HowToPlayModal close. */}
      <Button
        value="✕  Close"
        variant="secondary"
        fontSize={15}
        uiTransform={{ width: 160, height: 40, margin: { top: 16 } }}
        onMouseDown={closeLobbyImage}
      />
    </UiEntity>
  </UiEntity>
)

// ── Main UI renderer ──────────────────────────────────────────────────────────

const uiRenderer = () => {
  const s = getLocalState()
  const flash = getFlashAlpha()

  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
    >
      {/* ── Hit flash overlay ────────────────────────────────────────────── */}
      {flash > 0 && (
        <UiEntity
          uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
          uiBackground={{ color: Color4.create(1, 0, 0, flash) }}
        />
      )}

      {/* ── Damage HUD (bottom-centre) ───────────────────────────────────────
         Two side-by-side panels fed by index.ts's per-session damage tracker.
         Source is server state diff (lastDamage(Time) / lastDealt(Time)), so
         spectators see the watched player's numbers too. Each panel stays at
         full opacity while inside the DAMAGE_WINDOW (more hits sum into the
         same number) then fades out over the remaining DAMAGE_VISIBLE_MS. */}
      {(s.zone === 'game' || s.zone === 'spectator') && s.phase === 'playing' && (() => {
        const now      = Date.now()
        const showDealt = s.dmgDealtShownMs > now && s.dmgDealtAmount > 0
        const showRecv  = s.dmgRecvShownMs  > now && s.dmgRecvAmount  > 0
        if (!showDealt && !showRecv) return null
        const dealtAlpha = showDealt ? Math.min(1, (s.dmgDealtShownMs - now) / 800) : 0
        const recvAlpha  = showRecv  ? Math.min(1, (s.dmgRecvShownMs  - now) / 800) : 0
        return (
          <UiEntity
            uiTransform={{
              width: 320, height: 44,
              positionType: 'absolute', position: { bottom: 80, left: '50%' },
              margin:       { left: -160 },
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center'
            }}
          >
            {showDealt && (
              <UiEntity
                uiTransform={{ width: 150, height: 38, margin: { right: showRecv ? 8 : 0 }, alignItems: 'center', justifyContent: 'center' }}
                uiBackground={{ color: Color4.create(0, 0, 0, 0.5 * dealtAlpha) }}
              >
                <Label
                  value={`+${Math.round(s.dmgDealtAmount)} dealt`}
                  fontSize={18}
                  color={Color4.create(0.45, 0.95, 0.55, dealtAlpha)}
                  uiTransform={{ width: 146, height: 34 }}
                />
              </UiEntity>
            )}
            {showRecv && (
              <UiEntity
                uiTransform={{ width: 150, height: 38, alignItems: 'center', justifyContent: 'center' }}
                uiBackground={{ color: Color4.create(0, 0, 0, 0.5 * recvAlpha) }}
              >
                <Label
                  value={`-${Math.round(s.dmgRecvAmount)} HP`}
                  fontSize={18}
                  color={Color4.create(1.0, 0.4, 0.4, recvAlpha)}
                  uiTransform={{ width: 146, height: 34 }}
                />
              </UiEntity>
            )}
          </UiEntity>
        )
      })()}

      {/* ── Countdown timer (top-centre panel) ─────────────────────────────── */}
      {s.phase === 'countdown' && (
        <UiEntity
          uiTransform={{
            width: '100%', height: '100%',
            positionType: 'absolute', position: { top: 0, left: 0 },
            flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start'
          }}
        >
          <UiEntity
            uiTransform={{ width: 360, height: 52, margin: { top: 16 }, alignItems: 'center', justifyContent: 'center' }}
            uiBackground={{ color: Color4.create(0, 0, 0, 0.72) }}
          >
            <Label
              value={`Starting in ${Math.ceil(s.countdown)}s`}
              fontSize={26}
              color={Color4.Yellow()}
              uiTransform={{ width: 340, height: 46 }}
            />
          </UiEntity>
        </UiEntity>
      )}

      {/* ── In-game: timer + team label + weapon (top-centre column) ───────── */}
      {/* Timer visible across all zones while game is running */}
      {s.phase === 'playing' && (
        <UiEntity
          uiTransform={{
            width: '100%', height: '100%',
            positionType: 'absolute', position: { top: 0, left: 0 },
            flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start'
          }}
        >
          {/* Timer */}
          <UiEntity
            uiTransform={{ width: 200, height: 52, margin: { top: 16 }, alignItems: 'center', justifyContent: 'center' }}
            uiBackground={{ color: Color4.create(0, 0, 0, 0.62) }}
          >
            <Label
              value={`Time  ${fmtTime(s.timeRemaining)}`}
              fontSize={28}
              color={s.timeRemaining < 30 ? Color4.Red() : Color4.White()}
              uiTransform={{ width: 180, height: 46 }}
            />
          </UiEntity>

          {/* Team label — below timer, only in game zone */}
          {s.zone === 'game' && s.myTeam !== 'none' && (
            <UiEntity
              uiTransform={{ width: 200, height: 34, margin: { top: 6 }, alignItems: 'center', justifyContent: 'center' }}
              uiBackground={{ color: Color4.create(0, 0, 0, 0.55) }}
            >
              <Label
                value={s.myTeam === 'bodyguard' ? 'Bodyguard' : 'Hater'}
                fontSize={16}
                color={s.myTeam === 'bodyguard' ? Color4.create(0.3, 0.7, 1, 1) : Color4.create(1, 0.3, 0.3, 1)}
                uiTransform={{ width: 190, height: 30 }}
              />
            </UiEntity>
          )}

          {/* Inventory — both hands, only in game zone */}
          {s.zone === 'game' && (s.myRightHand !== 'none' || s.myLeftHand !== 'none') && (
            <UiEntity
              uiTransform={{ width: 240, height: 28, margin: { top: 4 }, alignItems: 'center', justifyContent: 'center' }}
              uiBackground={{ color: Color4.create(0, 0, 0, 0.45) }}
            >
              <Label
                value={`L: ${handIcon(s.myLeftHand)}   R: ${handIcon(s.myRightHand)}`}
                fontSize={13}
                color={Color4.Yellow()}
                uiTransform={{ width: 220, height: 24 }}
              />
            </UiEntity>
          )}

          {/* Shield HP bar — only when shield equipped */}
          {s.zone === 'game' && s.myLeftHand === 'shield' && s.myShieldMaxHP > 0 && (
            <UiEntity
              uiTransform={{ width: 200, flexDirection: 'column', alignItems: 'flex-start', margin: { top: 4 } }}
              uiBackground={{ color: Color4.create(0, 0, 0, 0.45) }}
            >
              <Label
                value={`Shield  ${Math.round(s.myShieldHP)}/${Math.round(s.myShieldMaxHP)}`}
                fontSize={11}
                color={Color4.create(0.4, 0.7, 1, 1)}
                uiTransform={{ width: 200, height: 16, margin: { left: 8 } }}
              />
              <UiEntity
                uiTransform={{ width: 184, height: 6, margin: { left: 8, top: 2, bottom: 4 }, justifyContent: 'flex-start' }}
                uiBackground={{ color: Color4.create(0.2, 0.2, 0.2, 1) }}
              >
                <UiEntity
                  uiTransform={{ width: `${Math.round(Math.max(0, s.myShieldHP / s.myShieldMaxHP) * 100)}%`, height: '100%' }}
                  uiBackground={{ color: Color4.create(0.4, 0.7, 1, 1) }}
                />
              </UiEntity>
            </UiEntity>
          )}

          {/* Defending stance indicator (F mode) */}
          {s.zone === 'game' && s.myDefending && (
            <UiEntity
              uiTransform={{ width: 200, height: 26, margin: { top: 4 }, alignItems: 'center', justifyContent: 'center' }}
              uiBackground={{ color: Color4.create(0.05, 0.25, 0.45, 0.85) }}
            >
              <Label
                value="DEFENDING (E to release)"
                fontSize={11}
                color={Color4.create(0.7, 0.9, 1, 1)}
                uiTransform={{ width: 200, height: 22 }}
              />
            </UiEntity>
          )}

          {/* Bomb warnings — show countdown if local player is in radius of any active bomb */}
          {(() => {
            if (s.zone !== 'game') return null
            const nearby = bombsInRadius(s)
            if (nearby.length === 0) return null
            const worstSec = Math.max(...nearby.map(b => Math.max(0, Math.ceil((b.fuseEndsAt - Date.now()) / 1000))))
            return (
              <UiEntity
                uiTransform={{ width: 240, height: 28, margin: { top: 4 }, alignItems: 'center', justifyContent: 'center' }}
                uiBackground={{ color: Color4.create(0.45, 0, 0, 0.85) }}
              >
                <Label
                  value={`BOMB! ${worstSec}s`}
                  fontSize={13}
                  color={Color4.create(1, 0.85, 0.3, 1)}
                  uiTransform={{ width: 230, height: 24 }}
                />
              </UiEntity>
            )
          })()}

          {/* VIP follow indicator — which bodyguard VIP is trailing */}
          {s.vipFollowingName && (
            <UiEntity
              uiTransform={{ width: 240, height: 28, margin: { top: 4 }, alignItems: 'center', justifyContent: 'center' }}
              uiBackground={{ color: Color4.create(0, 0, 0, 0.45) }}
            >
              <Label
                value={`VIP -> ${s.vipFollowingName}`}
                fontSize={13}
                color={Color4.create(0.95, 0.75, 0.1, 1)}
                uiTransform={{ width: 228, height: 24 }}
              />
            </UiEntity>
          )}
        </UiEntity>
      )}



      {/* ── Player HP list (right side, below the connection chip) ─────────── */}
      {s.phase === 'playing' && (s.zone === 'game' || s.zone === 'spectator') && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute', position: { top: 92, right: 20 },
            width: 230, flexDirection: 'column', alignItems: 'flex-start'
          }}
          uiBackground={{ color: Color4.create(0, 0, 0, 0.72) }}
        >
          {/* Bodyguards */}
          <Label
            value="Bodyguards"
            fontSize={13}
            color={Color4.create(0.3, 0.7, 1, 1)}
            uiTransform={{ width: 220, height: 22, margin: { top: 6, left: 8, bottom: 2 } }}
          />
          {s.playerList.filter((p: PlayerEntry) => p.team === 'bodyguard').map((p: PlayerEntry) =>
            <UiEntity uiTransform={{ width: 220, flexDirection: 'column', alignItems: 'flex-start', margin: { bottom: 3 } }}>
              <Label
                value={`${connDot(p)}${p.isAlive ? '' : '(dead) '}${p.name}  ${Math.round(p.hp)}/${p.maxHp}${connSuffix(p)}`}
                fontSize={11}
                color={!p.connected ? Color4.create(1, 0.6, 0.2, 1) : p.isAlive ? Color4.create(0.3, 0.7, 1, 1) : Color4.create(0.5, 0.5, 0.5, 1)}
                uiTransform={{ width: 210, height: 16, margin: { left: 8 } }}
              />
              <UiEntity
                uiTransform={{ width: 200, height: 8, margin: { left: 8, top: 2 }, justifyContent: 'flex-start' }}
                uiBackground={{ color: Color4.create(0.2, 0.2, 0.2, 1) }}
              >
                <UiEntity
                  uiTransform={{ width: `${Math.round(Math.max(0, p.maxHp > 0 ? p.hp / p.maxHp : 0) * 100)}%`, height: '100%' }}
                  uiBackground={{ color: p.isAlive ? hpBarColor(p.maxHp > 0 ? p.hp / p.maxHp : 0) : Color4.create(0.4, 0.4, 0.4, 1) }}
                />
              </UiEntity>
            </UiEntity>
          )}

          {/* VIP */}
          <Label
            value="⭐ VIP"
            fontSize={13}
            color={Color4.create(0.95, 0.75, 0.1, 1)}
            uiTransform={{ width: 220, height: 22, margin: { top: 6, left: 8, bottom: 2 } }}
          />
          {s.vipMaxHp > 0 && (
            <UiEntity uiTransform={{ width: 220, flexDirection: 'column', alignItems: 'flex-start', margin: { bottom: 3 } }}>
              <Label
                value={`VIP  ${Math.round(s.vipHp)} / ${Math.round(s.vipMaxHp)}`}
                fontSize={11}
                color={Color4.create(0.95, 0.75, 0.1, 1)}
                uiTransform={{ width: 210, height: 16, margin: { left: 8 } }}
              />
              <UiEntity
                uiTransform={{ width: 200, height: 8, margin: { left: 8, top: 2 }, justifyContent: 'flex-start' }}
                uiBackground={{ color: Color4.create(0.2, 0.2, 0.2, 1) }}
              >
                <UiEntity
                  uiTransform={{ width: `${Math.round(Math.max(0, s.vipHp / s.vipMaxHp) * 100)}%`, height: '100%' }}
                  uiBackground={{ color: hpBarColor(s.vipMaxHp > 0 ? s.vipHp / s.vipMaxHp : 0) }}
                />
              </UiEntity>
            </UiEntity>
          )}

          {/* Haters */}
          <Label
            value="Haters"
            fontSize={13}
            color={Color4.create(1, 0.3, 0.3, 1)}
            uiTransform={{ width: 220, height: 22, margin: { top: 6, left: 8, bottom: 2 } }}
          />
          {s.playerList.filter((p: PlayerEntry) => p.team === 'hater').map((p: PlayerEntry) =>
            <UiEntity uiTransform={{ width: 220, flexDirection: 'column', alignItems: 'flex-start', margin: { bottom: 3 } }}>
              <Label
                value={`${connDot(p)}${p.isAlive ? '' : '(dead) '}${p.name}  ${Math.round(p.hp)}/${p.maxHp}${connSuffix(p)}`}
                fontSize={11}
                color={!p.connected ? Color4.create(1, 0.6, 0.2, 1) : p.isAlive ? Color4.create(1, 0.3, 0.3, 1) : Color4.create(0.5, 0.5, 0.5, 1)}
                uiTransform={{ width: 210, height: 16, margin: { left: 8 } }}
              />
              <UiEntity
                uiTransform={{ width: 200, height: 8, margin: { left: 8, top: 2 }, justifyContent: 'flex-start' }}
                uiBackground={{ color: Color4.create(0.2, 0.2, 0.2, 1) }}
              >
                <UiEntity
                  uiTransform={{ width: `${Math.round(Math.max(0, p.maxHp > 0 ? p.hp / p.maxHp : 0) * 100)}%`, height: '100%' }}
                  uiBackground={{ color: p.isAlive ? hpBarColor(p.maxHp > 0 ? p.hp / p.maxHp : 0) : Color4.create(0.4, 0.4, 0.4, 1) }}
                />
              </UiEntity>
            </UiEntity>
          )}

          <UiEntity uiTransform={{ width: 220, height: 6 }} />
        </UiEntity>
      )}

      {/* ── Game ended overlay ─────────────────────────────────────────────── */}
      {s.phase === 'ended' && (
        <UiEntity
          uiTransform={{
            width: '100%', height: '100%', positionType: 'absolute',
            position: { top: 0, left: 0 }, alignItems: 'center', justifyContent: 'center'
          }}
        >
          <UiEntity
            uiTransform={{ width: 500, height: 160, alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}
            uiBackground={{ color: Color4.create(0, 0, 0, 0.82) }}
          >
            {/* Title — emoji confirmed working: 🏆 (history board), ⭐ (VIP name) */}
            <Label
              value={
                s.winner === 'bodyguards' ? '🏆  Bodyguards Win!' :
                s.winner === 'draw'       ? 'Draw!' :
                s.winner === 'haters'     ? '⭐  Haters Win!' :
                'Game Over'
              }
              fontSize={30}
              color={
                s.winner === 'bodyguards' ? Color4.create(0.3, 0.8,  1,   1) :
                s.winner === 'draw'       ? Color4.create(1,   0.85, 0.3, 1) :
                s.winner === 'haters'     ? Color4.create(1,   0.32, 0.32, 1) :
                Color4.White()
              }
              uiTransform={{ width: 480, height: 56 }}
            />
            {/* Reason — explains exactly what happened */}
            <Label
              value={winReasonText(s.winner, s.winReason)}
              fontSize={15}
              color={Color4.create(0.92, 0.88, 0.65, 1)}
              uiTransform={{ width: 480, height: 38 }}
            />
            <Label
              value="Returning to lobby…"
              fontSize={13}
              color={Color4.create(0.55, 0.55, 0.55, 1)}
              uiTransform={{ width: 300, height: 30 }}
            />
          </UiEntity>
        </UiEntity>
      )}

      {/* ── Local connection state + ping (top-right chip, sits above player list) ─ */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute', position: { top: 56, right: 20 },
          width: 230, height: 28, alignItems: 'center', justifyContent: 'center'
        }}
        uiBackground={{ color: Color4.create(0, 0, 0, 0.62) }}
      >
        <Label
          value={s.connected ? `Online  ${s.myPing > 0 ? s.myPing + 'ms' : '-'}` : 'Offline'}
          fontSize={12}
          color={s.connected ? pingColor(s.myPing) : Color4.create(1, 0.4, 0.4, 1)}
          uiTransform={{ width: 220, height: 24 }}
        />
      </UiEntity>



      {/* ── Wall HP panel (bottom-centre) — shown only on E press ─────────── */}
      {(() => {
        const room = getRoom()
        if (!room || s.phase !== 'playing' || s.zone !== 'game') return null
        if (!s.wallHpVisible) return null
        const idx = s.hoveredWallIdx
        if (idx < 0 || Date.now() > s.hoveredWallExpiresAt) return null
        const t  = (room.state.wallTypes  as any)?.[idx] ?? 0
        const hp = (room.state.wallHP     as any)?.[idx] ?? 0
        const mx = (room.state.wallMaxHP  as any)?.[idx] ?? 0
        const isDestructible = t === WALL_HEDGE || t === WALL_WOOD_WALL || t === WALL_WOOD_DOOR
        if (!isDestructible || mx <= 0 || hp <= 0) return null
        const frac = hp / mx
        return (
          <UiEntity
            uiTransform={{
              width: '100%', positionType: 'absolute', position: { bottom: 50, left: 0 },
              alignItems: 'center', justifyContent: 'center'
            }}
          >
            <UiEntity
              uiTransform={{
                width: 400, height: 100, flexDirection: 'column',
                alignItems: 'center', justifyContent: 'flex-start'
              }}
              uiBackground={{ color: Color4.create(0, 0, 0, 0.85) }}
            >
              <Label
                value={`${wallTypeName(t)}   ${hp} / ${mx}`}
                fontSize={16}
                color={hpBarColor(frac)}
                uiTransform={{ width: 380, height: 24, margin: { top: 8 } }}
              />
              <UiEntity
                uiTransform={{ width: 360, height: 10, margin: { top: 8 }, justifyContent: 'flex-start' }}
                uiBackground={{ color: Color4.create(0.2, 0.2, 0.2, 1) }}
              >
                <UiEntity
                  uiTransform={{ width: `${Math.round(Math.max(0, frac) * 100)}%`, height: '100%' }}
                  uiBackground={{ color: hpBarColor(frac) }}
                />
              </UiEntity>
              <Label
                value={`Break with: ${wallDamageSources(t, hp, mx)}`}
                fontSize={13}
                color={Color4.create(0.95, 0.85, 0.6, 1)}
                uiTransform={{ width: 380, height: 22, margin: { top: 12 } }}
              />
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* ── Ephemeral toast (e.g. "Need bomb to break this hedge") ────────── */}
      {/* Sits above the wall info panel (bottom 50 + height 100 = top at 150)
          so the two overlays don't overlap. */}
      {s.toastText && Date.now() < s.toastExpiresAt && (
        <UiEntity
          uiTransform={{
            width: '100%', positionType: 'absolute', position: { bottom: 160, left: 0 },
            alignItems: 'center', justifyContent: 'center'
          }}
        >
          <UiEntity
            uiTransform={{ width: 360, height: 36, alignItems: 'center', justifyContent: 'center' }}
            uiBackground={{ color: Color4.create(0.05, 0.05, 0.08, 0.85) }}
          >
            <Label
              value={s.toastText}
              fontSize={14}
              color={Color4.create(1, 0.85, 0.4, 1)}
              uiTransform={{ width: 350, height: 30 }}
            />
          </UiEntity>
        </UiEntity>
      )}

      {/* ── Disconnected banner (centred on screen) ────────────────────────── */}
      {!s.connected && (
        <UiEntity
          uiTransform={{
            width: '100%', height: '100%', positionType: 'absolute',
            position: { top: 0, left: 0 },
            alignItems: 'center', justifyContent: 'center'
          }}
          // pointerFilter='none' would be nicer but isn't exposed here; the panel is short so it doesn't trap clicks meaningfully
        >
          <UiEntity
            uiTransform={{ width: 380, height: 64, alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}
            uiBackground={{ color: Color4.create(0.5, 0, 0, 0.88) }}
          >
            <Label
              value="⚠ Reconnecting to server…"
              fontSize={16}
              color={Color4.White()}
              uiTransform={{ width: 360, height: 28 }}
            />
            <Label
              value="Your character will continue once connection is restored"
              fontSize={11}
              color={Color4.create(1, 0.85, 0.85, 1)}
              uiTransform={{ width: 360, height: 22 }}
            />
          </UiEntity>
        </UiEntity>
      )}

      {/* ── How to Play modal (over everything else) ────────────────────────────────── */}
            {s.showHowToPlay && <HowToPlayModal />}

      {/* ── Lobby image-banner modal (opened by clicking a left-wall plane) ──────── */}
            {s.lobbyImageModalUrl !== '' && <LobbyImageModal url={s.lobbyImageModalUrl} />}

      {/* ── Spectator controls (bottom-right) ───────────────────────────────── */}
      {s.zone === 'spectator' && (
        <UiEntity
          uiTransform={{
            width: 300, height: 106,
            positionType: 'absolute', position: { bottom: 20, right: 20 },
            flexDirection: 'column', alignItems: 'center', justifyContent: 'space-evenly'
          }}
          uiBackground={{ color: Color4.create(0, 0, 0, 0.72) }}
        >
          <Label
            value={s.spectatedIds.length > 0
              ? s.spectatedIds[s.spectateIndex] === '__vip__'
                ? `⭐ VIP  (${s.spectateIndex + 1}/${s.spectatedIds.length})`
                : `Watching: ${s.watchedName || ('Player ' + (s.spectateIndex + 1))}  (${s.spectateIndex + 1}/${s.spectatedIds.length})`
              : 'No players in game'}
            fontSize={14}
            color={Color4.White()}
            uiTransform={{ width: 280, height: 32 }}
          />
          <UiEntity
            uiTransform={{ width: 280, height: 50, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Button value="◀" variant="primary" fontSize={16} uiTransform={{ width: 70, height: 42 }} onMouseDown={prevPlayer} />
            <Button value="Next ▶" variant="primary" fontSize={14} uiTransform={{ width: 100, height: 42 }} onMouseDown={nextPlayer} />
            <Button value="✕ Stop" variant="secondary" fontSize={13} uiTransform={{ width: 90, height: 42 }} onMouseDown={stopSpectate} />
          </UiEntity>
        </UiEntity>
      )}
    </UiEntity>
  )
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setupAllUI() {
  ReactEcsRenderer.setUiRenderer(uiRenderer)
}
