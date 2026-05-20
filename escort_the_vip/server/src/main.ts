import 'dotenv/config'
// Lift the schema encoder buffer ABOVE the default 8 KB before any room
// schema is encoded. The maze alone replicates 6 × 480-element uint8 arrays
// (types/states/HP/maxHP + claim teams/ack) plus players, items, bombs and
// the result history — together this can spill past the default and trigger
// the `@colyseus/schema buffer overflow` warning, with later state diffs
// silently dropped.
import { Encoder } from '@colyseus/schema'
Encoder.BUFFER_SIZE = 32 * 1024
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import express from 'express'
import { Server } from 'colyseus'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { getSSLCredentials, SSLMode } from './ssl'
import { ChallengeType } from './ssl/letsencrypt'
import { GameRoom } from './rooms/GameRoom'
import { issueToken, isRateLimited } from './auth'

const PORT = Number(process.env.PORT ?? 2567)
const SSL_MODE = (process.env.SSL_MODE ?? 'none') as SSLMode
const SSL_DOMAIN = process.env.SSL_DOMAIN ?? 'localhost'
const SSL_EMAIL = process.env.SSL_EMAIL ?? ''
const SSL_STAGING = process.env.SSL_STAGING === 'true'
const CERTS_DIR = process.env.CERTS_DIR ?? path.join(process.cwd(), 'certs')
const ACME_CHALLENGE = (process.env.ACME_CHALLENGE ?? 'http-01') as ChallengeType
const DUCKDNS_TOKEN = process.env.DUCKDNS_TOKEN ?? ''

// ── DuckDNS auto-update ───────────────────────────────────────────────────────
// Keeps the DuckDNS domain pointing at the correct public IP.
// Runs once on startup and then every DUCKDNS_UPDATE_INTERVAL_MS.
// Only updates when the IP actually changes — avoids spamming the API.

const DUCKDNS_UPDATE_INTERVAL_MS = 5 * 60 * 1000  // 5 minutes

let _lastPublicIp = ''

// Try several public-IP echo services in order; return the first that responds.
async function getPublicIp(): Promise<string> {
  const services = [
    'https://api.ipify.org',
    'https://checkip.amazonaws.com',
    'https://ifconfig.me/ip',
  ]
  for (const url of services) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      const ip  = (await res.text()).trim()
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
    } catch { /* try next */ }
  }
  throw new Error('All public-IP services failed')
}

async function updateDuckDns(): Promise<void> {
  if (!DUCKDNS_TOKEN || !SSL_DOMAIN || !SSL_DOMAIN.endsWith('.duckdns.org')) return

  let publicIp: string
  try {
    publicIp = await getPublicIp()
  } catch (e) {
    console.warn('[DuckDNS] Could not get public IP:', (e as Error).message)
    return
  }

  if (publicIp === _lastPublicIp) {
    console.log(`[DuckDNS] IP unchanged (${publicIp}) — skipping update`)
    return
  }

  const subdomain = SSL_DOMAIN.replace(/\.duckdns\.org$/, '')
  const url = `https://www.duckdns.org/update?domains=${subdomain}&token=${DUCKDNS_TOKEN}&ip=${publicIp}&verbose=true`

  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    const text = (await res.text()).trim()
    if (text.startsWith('OK')) {
      console.log(`[DuckDNS] Updated ${SSL_DOMAIN} → ${publicIp}${_lastPublicIp ? ` (was ${_lastPublicIp})` : ''}`)
      _lastPublicIp = publicIp
    } else {
      console.warn(`[DuckDNS] Update failed: ${text}`)
    }
  } catch (e) {
    console.warn('[DuckDNS] Update request failed:', (e as Error).message)
  }
}

function startDuckDnsUpdater(): void {
  if (!DUCKDNS_TOKEN || !SSL_DOMAIN.endsWith('.duckdns.org')) return
  // Run immediately, then on interval
  void updateDuckDns()
  setInterval(() => { void updateDuckDns() }, DUCKDNS_UPDATE_INTERVAL_MS).unref()
}

async function bootstrap() {
  const app = express()

  // CORS — required for Decentraland's browser to reach the matchmaking HTTP endpoint.
  // Colyseus does ws:// upgrade AFTER an initial HTTP POST to /matchmake/...
  // Without these headers the browser blocks that preflight request.
  //
  // NOTE: Colyseus's bindRouterToTransport already handles CORS for /matchmake/*
  // by reflecting the actual request origin. This middleware covers /auth and /health
  // (Express routes). We echo the origin back so any DCL client (play.decentraland.org,
  // play.decentraland.zone, or any future subdomain) can connect without being blocked.
  app.use((_req, res, next) => {
    const origin = _req.headers.origin
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Vary', 'Origin')
    } else {
      res.header('Access-Control-Allow-Origin', '*')
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept, Authorization')
    if (_req.method === 'OPTIONS') return res.sendStatus(200)
    next()
  })

  // IMPORTANT: do NOT add `app.use(express.json())` globally — it would consume
  // the body of EVERY incoming POST, including /matchmake/joinOrCreate/*. By
  // the time Colyseus's matchmaker handler tries to read the body stream, it's
  // already drained, leaving `options = {}` and our auth token unreadable.
  // Apply express.json() ONLY on routes that we own.

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Auth endpoint — clients call this BEFORE joinOrCreate. They send their
  // DCL userId/displayName (and, when running on a real realm, the request
  // arrives with X-Identity-Auth-Chain-N headers added by signedFetch).
  // The server hands back a single-use token that Colyseus's onAuth then
  // validates. Without a valid token the room refuses the connection.
  app.post('/auth', express.json(), (req, res) => {
    const ip = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many auth requests — try again in a minute' })
    }
    const userId      = typeof req.body?.userId      === 'string' ? req.body.userId.trim()      : ''
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : ''
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }
    // Optional: log AuthChain headers for audit. Real cryptographic verification
    // would require @dcl/crypto; for now we trust the userId from the body and
    // rely on the single-use token + onAuth gate to prevent ghost connections.
    const hasAuthChain = Object.keys(req.headers).some(h => h.toLowerCase().startsWith('x-identity-auth-chain-'))
    const token = issueToken(userId, displayName)
    console.log(`[Auth] Issued token for ${userId}${hasAuthChain ? ' (signed)' : ' (unsigned)'}`)
    res.json({ token })
  })

  // ── SSL ──────────────────────────────────────────────────────────────────
  const ssl = await getSSLCredentials({
    mode: SSL_MODE,
    certsDir: CERTS_DIR,
    domain: SSL_DOMAIN,
    email: SSL_EMAIL,
    staging: SSL_STAGING,
    certPath: process.env.SSL_CERT_PATH,
    keyPath: process.env.SSL_KEY_PATH,
    challengeType: ACME_CHALLENGE,
    duckdnsToken: DUCKDNS_TOKEN
  })

  const httpServer: http.Server = ssl
    ? https.createServer({ key: ssl.key, cert: ssl.cert }, app)
    : http.createServer(app)

  // ── Colyseus ─────────────────────────────────────────────────────────────
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer })
  })

  gameServer.define('game_room', GameRoom)

  await gameServer.listen(PORT)

  const proto = ssl ? 'https' : 'http'
  const wsProto = ssl ? 'wss' : 'ws'

  console.log('\n========================================')
  console.log(' Colyseus Server')
  console.log('========================================')
  console.log(` HTTP:      ${proto}://localhost:${PORT}`)
  console.log(` WebSocket: ${wsProto}://localhost:${PORT}`)
  console.log(` Health:    ${proto}://localhost:${PORT}/health`)
  console.log(` SSL mode:  ${SSL_MODE}`)
  if (SSL_DOMAIN && SSL_DOMAIN !== 'localhost') {
    console.log(` Domain:    ${SSL_DOMAIN}`)
    console.log(` Client URL: ${wsProto}://${SSL_DOMAIN}${PORT !== 443 ? ':' + PORT : ''}`)
  }
  console.log('========================================\n')

  // Start DuckDNS IP updater AFTER server is up so startup errors don't
  // prevent us from reaching the DuckDNS API.
  startDuckDnsUpdater()
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
