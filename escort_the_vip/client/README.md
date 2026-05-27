# Escort Game — Decentraland Scene (Client)

Multiplayer escort game built with Decentraland SDK7 and Colyseus.

## Overview

Two teams fight in a procedurally generated maze:
- **Bodyguards** — escort the VIP to the green safe zone
- **Haters** — kill the VIP before time runs out

## Setup

```bash
cd client
npm install
npm run start       # preview (connects to local server on ws://localhost:2567)
npm run build       # production build
```

The server URL is configured in `src/colyseus-client.ts`.

## Game Mechanics

### Teams & Win Conditions
| Winner | Condition |
|--------|-----------|
| Bodyguards | VIP reaches the safe zone |
| Bodyguards | All haters eliminated |
| Draw | Time runs out, VIP alive but didn't reach safe zone |
| Haters | VIP killed |
| Haters | All bodyguards eliminated |

### Controls
- **WASD** — move
- **Click** — attack enemy / interact with VIP
- **F** — toggle defend stance
- **E** — cancel defend / place bomb / attack wall

### Items
- **Baton** (right hand) — bonus melee damage
- **Shield** (left hand) — absorbs damage when defending; has HP, can break
- **Bomb** (left hand) — 5-second fuse; press E to place on current tile or aim at door for a trap

### Defense System
| State | Source | Damage to HP |
|-------|--------|-------------|
| Not defending, no shield | any | 100% |
| Not defending, shield | any | 50% HP + 50% shield |
| Defending, no shield | hand/baton | 75% |
| Defending, no shield | bomb | 50% |
| Defending, shield | any | 0% (all to shield) |

Attacking while defending deals 25% less damage.

### VIP Behaviour
- Follows the bodyguard who clicked her
- Flees from haters only after being hit
- Escapes dead-ends automatically; idles in open areas until threatened again
- Glowing column above VIP: colour = HP state (yellow → orange → red)
- Concrete wall stripes: white = safe, yellow = hater ≤6 tiles, orange = ≤3 tiles, red = VIP hit recently

### Walls
| Type | How to break |
|------|-------------|
| Hedge | Bomb, baton (hover for HP) |
| Wood wall | Any attack |
| Concrete | Indestructible |
| Door | Bomb or trap bomb |

## Project Structure

```
src/
├── index.ts              — entry point, Colyseus callbacks, ECS systems
├── ui.tsx                — React-ECS HUD
├── colyseus-client.ts    — server connection
├── polyfills.ts          — QuickJS polyfills
├── state/localState.ts   — client-side state
├── game/
│   ├── constants.ts      — tile size, zone Y, helpers
│   ├── maze.ts           — wall/item/bomb rendering
│   ├── npcRenderer.ts    — VIP avatar + hitbox
│   ├── playerHitboxes.ts — enemy click/physics boxes
│   ├── combatInput.ts    — E/F key handling
│   ├── healthBar.ts      — world-space HP bars
│   ├── lightEffects.ts   — VIP beacon + stripe colours
│   └── screenEffects.ts  — red hit flash
├── audio/
│   ├── soundManager.ts   — sound pool + play/stop/loop
│   └── vipAudio.ts       — 3-tier proximity sound system
└── zones/
    ├── spectatorZone.ts  — lobby cube + buttons + How to Play
    ├── gameZone.ts       — arena floor + modifier areas
    └── zoneTriggers.ts   — TriggerArea enter/stay/exit
```
