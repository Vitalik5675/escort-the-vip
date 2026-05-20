// IMPORTANT: polyfills must be imported before this module.
// Guaranteed by index.ts import order: './polyfills' is always first.

import { Client, Room } from '@colyseus/sdk'
import { getPlayer } from '@dcl/sdk/players'

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CONNECT_TIMEOUT_MS  = 15_000   // how long to wait for joinOrCreate before giving up
const DEAD_PONG_MS        = 15_000   // force-reconnect if no pong received for this long
const MAX_FAST_RETRIES    = 3        // quick retries before switching to slow interval
const FAST_RETRY_DELAY_MS = 8_000
const SLOW_RETRY_DELAY_MS = 30_000

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

// Active Colyseus room, or null when not connected.
let _room: Room | null = null

// Server connection parameters.
let _serverUrl = ''
let _roomName  = 'game_room'

// Cached player identity — set from onEnterScene before the first connect.
// Sent to the server both via /auth and the 'identify' message so the server
// can refuse duplicate sessions for the same userId synchronously.
let _identity: { userId: string; displayName: string } | null = null

// ── Scene presence ────────────────────────────────────────────────────────────
//
// This is the central gating flag for all connection activity.
// Set to true only after onEnterScene confirms the LOCAL player entered.
// Set to false in onLeaveScene so the health-check never reconnects while
// the player is outside the scene boundaries.
//
// Rule: nothing in this module ever opens a connection when _playerInScene=false.
let _playerInScene = false

// ── Connection lifecycle flags ────────────────────────────────────────────────

// True while a joinOrCreate is in flight.
let _isConnecting = false

// True when we intentionally disconnected (onLeaveScene).
// Suppresses all automatic reconnect attempts.
let _disconnectedIntentionally = false

// ── Generation counter (zombie session guard) ─────────────────────────────────
//
// Incremented every time we start a new connection attempt, call
// forceReconnect(), or call disconnectFromServer().
// After joinOrCreate resolves, we compare the captured value against the
// current one — a mismatch means something invalidated this attempt while
// we were awaiting, so we leave the stale room instead of overwriting the
// active connection.
let _generation = 0

// Re-entrancy guard for _forceReconnect — prevents recursive calls within
// the same JS tick if two health-check events fire simultaneously.
let _reconnectInProgress = false

// ── Retry state ───────────────────────────────────────────────────────────────

let _retryCount = 0
let _retryTimer: ReturnType<typeof setTimeout> | null = null

// ── Keepalive / latency ───────────────────────────────────────────────────────

let _lastPong   = 0   // Date.now() timestamp of the last received pong
let _lastPingMs = 0   // last measured round-trip time in ms

// ── Game-layer callbacks ──────────────────────────────────────────────────────

let _onJoined: ((room: Room) => void) | null = null
let _onLeft:   (() => void)           | null = null

// ─────────────────────────────────────────────────────────────────────────────
// DCL-compatible fetch (module-level — created once, reused on every reconnect)
// ─────────────────────────────────────────────────────────────────────────────
//
// DCL-specific quirks we work around:
//   1. DCL's fetch ignores `Headers` instances on init.headers — it only reads
//      plain { key: value } objects. Without this fix, the Colyseus SDK's
//      `Authorization: Bearer <token>` header is silently dropped and the
//      server's onAuth receives an empty token.
//   2. DCL's Response lacks .blob() — the Colyseus SDK falls back to it when
//      the content-type isn't json/text (e.g. on 5xx error pages). Without
//      the stub it throws and crashes the matchmaking flow.
//   3. DCL mobile: Response.headers may be a plain object without .get().
//      Colyseus SDK calls raw.headers.get("content-type") — wrap if needed.
//   4. Colyseus hardcodes credentials:"include" — on mobile DCL (no browser
//      Origin header) this triggers a CORS rejection when the server responds
//      with Access-Control-Allow-Origin:*. We force "omit" since auth is
//      handled entirely via Authorization Bearer header, not cookies.
//   5. Colyseus passes non-standard options (query, params) that DCL's fetch
//      rejects or misinterprets — only forward standard Fetch API keys.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _dclFetch = (input: any, init?: any): any => {
  // Only forward keys that DCL's fetch understands (standard Fetch API)
  const STANDARD_FETCH_KEYS = new Set([
    'method', 'headers', 'body', 'mode', 'cache',
    'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'signal'
  ])
  const fixed: any = {}
  if (init) {
    for (const key of Object.keys(init)) {
      if (STANDARD_FETCH_KEYS.has(key)) fixed[key] = init[key]
    }
  }

  // Fix 1: Headers instance → plain object (DCL fetch ignores Headers instances)
  if (init?.headers) {
    const plain: Record<string, string> = {}
    if (typeof init.headers.forEach === 'function') {
      // Headers instance
      init.headers.forEach((v: string, k: string) => { plain[k] = v })
    } else if (Array.isArray(init.headers)) {
      // [key, value][] array
      for (const [k, v] of init.headers) plain[k] = v
    } else {
      // Already a plain object
      Object.assign(plain, init.headers)
    }
    fixed.headers = plain
  }

  // Fix 4: Force credentials omit — auth is via Bearer token, not cookies.
  // credentials:"include" + Access-Control-Allow-Origin:* = CORS error on mobile.
  fixed.credentials = 'omit'

  return fetch(input, fixed).then((res: any) => {
    // Fix 2: Add .blob() stub if missing
    if (typeof res.blob !== 'function') {
      res.blob = async () => {
        const txt = await res.text()
        return { size: txt.length, type: 'text/plain', text: async () => txt }
      }
    }

    // Fix 3: Wrap plain-object headers so .get() works (mobile DCL returns
    // Response.headers as a plain { key: value } map, not a Headers instance)
    if (res.headers && typeof res.headers.get !== 'function') {
      const rawH: Record<string, string> = { ...res.headers }
      res.headers = {
        get: (name: string): string | null => {
          const lower = name.toLowerCase()
          for (const k of Object.keys(rawH)) {
            if (k.toLowerCase() === lower) return rawH[k]
          }
          return null
        },
        has: (name: string): boolean => {
          const lower = name.toLowerCase()
          return Object.keys(rawH).some(k => k.toLowerCase() === lower)
        }
      }
    }

    return res
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _notifyJoined(room: Room): void {
  try { _onJoined?.(room) } catch (e) { console.error('[Colyseus] onJoined callback threw:', e) }
}

function _notifyLeft(): void {
  try { _onLeft?.() } catch (e) { console.error('[Colyseus] onLeft callback threw:', e) }
}

function _cancelRetry(): void {
  if (_retryTimer !== null) { clearTimeout(_retryTimer); _retryTimer = null }
}

function _scheduleRetry(): void {
  // Never schedule a retry when:
  //   • player left the scene (we should not reconnect on their behalf)
  //   • player disconnected intentionally (onLeaveScene path)
  //   • a retry is already pending
  if (!_playerInScene || _disconnectedIntentionally || _retryTimer !== null) return

  const delay = _retryCount < MAX_FAST_RETRIES ? FAST_RETRY_DELAY_MS : SLOW_RETRY_DELAY_MS
  _retryCount++
  console.log(`[Colyseus] Retry #${_retryCount} in ${delay / 1000}s…`)
  _retryTimer = setTimeout(() => { _retryTimer = null; void _doConnect() }, delay)
}

function _withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s`)), ms)
    )
  ])
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth token exchange
// ─────────────────────────────────────────────────────────────────────────────
//
// Calls POST /auth on the server. Tries DCL signedFetch first (includes the
// X-Identity-Auth-Chain-N headers that prove the request came from a real DCL
// player); falls back to plain fetch in local preview / non-DCL environments.

async function _fetchAuthToken(
  httpOrigin: string,
  identity: { userId: string; displayName: string }
): Promise<string | null> {
  const url  = `${httpOrigin}/auth`
  const body = JSON.stringify({ userId: identity.userId, displayName: identity.displayName })

  // ── Attempt 1: signedFetch (real DCL realm) ───────────────────────────────
  try {
    const mod = await import('~system/SignedFetch')
    const res = await mod.signedFetch({
      url,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
    })
    if (res?.body) {
      const parsed = JSON.parse(res.body)
      if (typeof parsed?.token === 'string' && parsed.token) return parsed.token
    }
  } catch (_) {
    // signedFetch not available in preview — fall through
  }

  // ── Attempt 2: plain fetch (local preview) ────────────────────────────────
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    })
    if (!res.ok) {
      if (res.status === 429) console.log('[Colyseus] /auth rate-limited — will retry')
      else                    console.log(`[Colyseus] /auth returned HTTP ${res.status}`)
      return null
    }
    const parsed = JSON.parse(await res.text())
    if (typeof parsed?.token === 'string' && parsed.token) return parsed.token
    console.log('[Colyseus] /auth response has no token')
    return null
  } catch (e) {
    console.error('[Colyseus] /auth network error:', e)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Force reconnect — tears down the current (stale) connection and opens fresh
// ─────────────────────────────────────────────────────────────────────────────

function _forceReconnect(reason: string): void {
  if (_reconnectInProgress) return   // re-entrancy guard

  console.log(`[Colyseus] ${reason} — reconnecting`)
  _reconnectInProgress = true

  const oldRoom = _room

  // Reset state synchronously so checkAndReconnect ticks see a clean slate
  // immediately, even while leave() is still pending below.
  _cancelRetry()
  _retryCount   = 0
  _lastPong     = 0
  _lastPingMs   = 0
  _room         = null
  _isConnecting = false
  _generation++           // invalidate the in-flight joinOrCreate (if any)
  _notifyLeft()

  if (oldRoom) {
    // Race leave() against a 5s cap. A wedged WebSocket can hang leave()
    // forever — we cannot await it. The server will GC the orphaned session on
    // its own; handleGhostsForUserId kicks any leftover ghost on the next join.
    Promise.race([
      Promise.resolve(oldRoom.leave()).catch(() => {}),
      new Promise<void>(res => setTimeout(res, 5_000))
    ]).catch(() => {})
  }

  _reconnectInProgress = false
  void _doConnect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Core connection — opens a Colyseus room
// ─────────────────────────────────────────────────────────────────────────────

async function _doConnect(): Promise<void> {

  // ── Pre-flight checks ───────────────────────────────────────────────────────

  // Never connect when the player is not in the scene.
  // This is the primary guard — all other flags are secondary.
  if (!_playerInScene) return

  if (_disconnectedIntentionally) return
  if (_isConnecting || _room !== null || _reconnectInProgress) return

  _isConnecting = true
  const myGen   = ++_generation   // capture generation; _forceReconnect will bump it

  try {

    // ── Resolve identity ──────────────────────────────────────────────────────
    //
    // setLocalIdentity() is called from onEnterScene before _doConnect, so
    // _identity is normally already set here.
    // The getPlayer() fallback covers the edge case where the health-check
    // fires before onEnterScene has completed (cold scene load on slow clients).

    if (!_identity?.userId) {
      const live = getPlayer()
      if (live?.userId) {
        _identity = { userId: live.userId, displayName: live.name ?? '' }
      }
    }

    if (!_identity?.userId) {
      // Player object not ready yet — abort and let the retry timer try again.
      throw new Error('Player identity not available yet')
    }

    console.log(`[Colyseus] Connecting to ${_serverUrl} as "${_identity.displayName}" …`)

    // ── Auth token ────────────────────────────────────────────────────────────
    //
    // Exchange our DCL identity for a short-lived server-issued token.
    // The server's onAuth validates this token before allowing us into the room.

    const httpOrigin = _serverUrl
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://')

    const token = await _fetchAuthToken(httpOrigin, _identity)
    if (!token) throw new Error('Failed to get auth token from /auth endpoint')

    // ── Join room ─────────────────────────────────────────────────────────────
    //
    // The token goes in client.auth.token so Colyseus sends it as
    // "Authorization: Bearer <token>" on the matchmaking HTTP request.
    // Body options are intentionally empty — auth lives in the header.

    const client = new Client(_serverUrl, { fetchFn: _dclFetch })
    client.auth.token = token

    // Track the join promise separately so we can clean up the zombie session
    // if withTimeout rejects before joinOrCreate actually resolves.
    let joinSettled = false
    const joinPromise = client.joinOrCreate<unknown>(_roomName, {})
    joinPromise.then(() => { joinSettled = true }).catch(() => { joinSettled = true })

    let newRoom: Room
    try {
      newRoom = await _withTimeout(joinPromise, CONNECT_TIMEOUT_MS)
    } catch (err) {
      // If joinOrCreate is still pending after the timeout, clean up the
      // zombie that will eventually resolve.
      if (!joinSettled) {
        joinPromise
          .then(zombie => {
            console.log(`[Colyseus] Late joinOrCreate after timeout — leaving zombie ${zombie.sessionId}`)
            try { zombie.leave(true) } catch (_) {}
          })
          .catch(() => {})
      }
      throw err
    }

    // ── Generation check ──────────────────────────────────────────────────────
    //
    // If _forceReconnect() or disconnectFromServer() fired while we were
    // awaiting joinOrCreate, our generation is now stale. Leave this room
    // immediately so the newer connection can own _room.

    if (myGen !== _generation) {
      console.log(`[Colyseus] Stale connection resolved (gen ${myGen} vs ${_generation}) — leaving ${newRoom.sessionId}`)
      try { newRoom.leave(true) } catch (_) {}
      _isConnecting = false
      return
    }

    // ── Success ───────────────────────────────────────────────────────────────

    _room         = newRoom
    _isConnecting = false
    _retryCount   = 0
    _lastPong     = Date.now()

    console.log(`[Colyseus] ✓ Connected — room "${_room.roomId}" | session "${_room.sessionId}"`)

    // Send identify as a backup in case server options were lost in transit.
    // The server uses this to kick any ghost session with the same userId.
    try {
      _room.send('identify', { userId: _identity.userId, displayName: _identity.displayName })
    } catch (_) {}

    _notifyJoined(_room)

    // ── Wire room events ──────────────────────────────────────────────────────

    _room.onMessage('pong', (msg: { timestamp: number }) => {
      _lastPong   = Date.now()
      _lastPingMs = Date.now() - msg.timestamp
      // Mirror our measured RTT to the server so it can show latency in the HUD.
      try { _room?.send('report_ping', { ms: _lastPingMs }) } catch (_) {}
    })

    _room.onError((code, message) => {
      console.error(`[Colyseus] Room error ${code}: ${message}`)
    })

    // Capture room in closure — prevents a stale onLeave from clobbering the
    // _room variable if forceReconnect already opened a new session.
    const thisRoom = newRoom
    thisRoom.onLeave((code) => {
      if (thisRoom !== _room) {
        // This onLeave belongs to a superseded session — ignore it.
        console.log(`[Colyseus] Stale onLeave (code ${code}) from old session — ignored`)
        return
      }

      const wasIntentional = _disconnectedIntentionally
      _room         = null
      _isConnecting = false
      _lastPong     = 0

      if (wasIntentional) {
        console.log(`[Colyseus] Room left (code ${code}) — intentional`)
        return
      }

      // Code 4000 = server kicked us because another session claimed this userId.
      // Reconnecting would just kick that session too — stop here.
      if (code === 4000) {
        console.log('[Colyseus] Kicked (duplicate userId) — reconnect suppressed')
        _disconnectedIntentionally = true
        _notifyLeft()
        return
      }

      console.log(`[Colyseus] Connection lost (code ${code})`)
      _notifyLeft()
      _scheduleRetry()
    })

    // Send initial ping so we have a baseline pong timestamp immediately.
    _room.send('ping', { timestamp: Date.now() })

  } catch (err) {
    _room         = null
    _isConnecting = false
    _lastPong     = 0
    _lastPingMs   = 0
    console.error('[Colyseus] Connection attempt failed:', err)
    // Notify game layer so the HUD shows "Reconnecting…" during retries.
    _notifyLeft()
    _scheduleRetry()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register callbacks that the game layer (index.ts) uses to react to
 * connection state changes. Call once during scene setup.
 */
export function setRoomCallbacks(
  onJoined: (room: Room) => void,
  onLeft:   () => void
): void {
  _onJoined = onJoined
  _onLeft   = onLeft
}

/**
 * Store the local player's DCL identity so it's available synchronously
 * when the first joinOrCreate fires.
 *
 * Call from onEnterScene BEFORE connectToServer() so the server can
 * identify this session in onJoin without waiting for the 'identify' message.
 */
export function setLocalIdentity(userId: string, displayName: string): void {
  _identity = { userId, displayName }
}

/**
 * Tell the connection module whether the local player is inside the scene.
 *
 *   setPlayerInScene(true)  — call from onEnterScene (local player only)
 *   setPlayerInScene(false) — call from onLeaveScene (local player only)
 *
 * When false, no connection attempts will be made and all pending retries
 * are cancelled. This is the primary guard that prevents reconnecting on
 * behalf of a player who has already left the scene.
 */
export function setPlayerInScene(inScene: boolean): void {
  if (_playerInScene === inScene) return   // no change

  _playerInScene = inScene
  console.log(`[Colyseus] Player ${inScene ? 'entered' : 'left'} scene`)

  // If the player left the scene, cancel any pending retry immediately so we
  // don't attempt to reconnect while they're outside.
  if (!inScene) _cancelRetry()
}

/**
 * Check if a given userId belongs to the local player.
 *
 * Uses the cached _identity (set in onEnterScene) as the primary check —
 * more reliable than getPlayer() which can return null during loading.
 * Falls back to getPlayer() if identity hasn't been set yet.
 */
export function isLocalPlayer(userId: string): boolean {
  if (_identity?.userId) return _identity.userId === userId
  const live = getPlayer()
  return live !== null && live.userId === userId
}

/**
 * Begin connecting to the Colyseus server.
 *
 * Safe to call multiple times — re-entrant calls are ignored when the URL
 * hasn't changed and a connection (or retry) is already active.
 * Resets the intentional-disconnect flag so auto-reconnect resumes.
 */
export function connectToServer(url: string, name = 'game_room'): void {
  const urlChanged = url !== _serverUrl

  // If the URL is the same and we're already connected / connecting / retrying,
  // just ensure we're not stuck in intentional-leave mode and return.
  if (!urlChanged && (_room !== null || _isConnecting || _retryTimer !== null || _reconnectInProgress)) {
    _disconnectedIntentionally = false
    return
  }

  _serverUrl                 = url
  _roomName                  = name
  _disconnectedIntentionally = false
  _cancelRetry()
  _retryCount = 0
  _generation++   // invalidate any in-flight attempt from a previous URL/session

  void _doConnect()
}

/**
 * Disconnect cleanly and suppress all auto-reconnect attempts.
 * Called from onLeaveScene.
 */
export async function disconnectFromServer(): Promise<void> {
  if (_disconnectedIntentionally && _room === null) return   // already disconnected

  console.log('[Colyseus] Disconnecting…')
  _disconnectedIntentionally = true
  _generation++    // invalidate any in-flight joinOrCreate
  _cancelRetry()

  const oldRoom = _room
  _room         = null
  _isConnecting = false
  _lastPong     = 0

  if (oldRoom) {
    // Race leave() against a 5s cap — same as _forceReconnect.
    // A wedged WebSocket can hang leave() indefinitely; we cannot block onLeaveScene.
    await Promise.race([
      Promise.resolve(oldRoom.leave()).catch(() => {}),
      new Promise<void>(res => setTimeout(res, 5_000))
    ]).catch(() => {})
  }

  console.log('[Colyseus] Disconnected')
}

/**
 * Health-check tick — call every 5 seconds from an ECS system.
 *
 * Connected:    sends a keepalive ping; force-reconnects if no pong in DEAD_PONG_MS.
 * Disconnected: triggers a new connection attempt if conditions are met.
 *
 * Skipped entirely when _playerInScene is false.
 */
export function checkAndReconnect(): void {
  // Primary guard — do nothing if the player is not in the scene.
  if (!_playerInScene)             return
  if (_disconnectedIntentionally)  return
  if (_reconnectInProgress)        return

  if (_room !== null) {
    // Send keepalive ping. A throw here means the WebSocket is already closed.
    try {
      _room.send('ping', { timestamp: Date.now() })
    } catch (_) {
      _forceReconnect('Health check: WebSocket closed (send failed)')
      return
    }

    // If pong stopped arriving, the connection is silently dead.
    if (_lastPong > 0 && Date.now() - _lastPong > DEAD_PONG_MS) {
      _forceReconnect(`Health check: no pong for ${DEAD_PONG_MS / 1000}s`)
    }
    return
  }

  // Not connected — attempt if no retry is already scheduled.
  if (_retryTimer !== null || _isConnecting) return

  // Last-chance identity refresh: onEnterScene should have set _identity,
  // but on very slow clients the health-check can fire first.
  if (!_identity?.userId) {
    const live = getPlayer()
    if (live?.userId) {
      _identity = { userId: live.userId, displayName: live.name ?? '' }
    } else {
      return   // still no identity — wait for next tick
    }
  }

  console.log('[Colyseus] Health check: not connected — attempting reconnect')
  void _doConnect()
}

// ── Getters ───────────────────────────────────────────────────────────────────

export function getRoom():        Room | null { return _room }
export function isConnected():    boolean     { return _room !== null }
export function getLastPingMs():  number      { return _lastPingMs }

export function sendToRoom(type: string, data?: unknown): void {
  if (!_room) { console.error('[Colyseus] sendToRoom: not connected'); return }
  _room.send(type, data)
}
