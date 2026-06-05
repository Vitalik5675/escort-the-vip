import * as crypto from 'crypto'

// Self-contained, dependency-free auth. Two pieces:
//   1) issueToken(userId, displayName)         → opaque random token; remembered in-memory until TTL.
//   2) verifyToken(token)                      → returns { userId, displayName } or null.
//
// We deliberately don't ship JWT/HMAC machinery — a single Colyseus instance
// holds the issued tokens in process memory, so a random 256-bit token is just
// as unforgeable as any signed payload from the attacker's perspective.

interface IssuedToken {
  userId:      string
  displayName: string
  expiresAt:   number   // Date.now() ms
}

// 60s is enough: client gets token → immediately calls joinOrCreate.
// Colyseus SDK can internally retry joinOrCreate up to 2x with the same
// token, so we keep it reusable (not single-use) within the TTL window.
const TOKEN_TTL_MS = 60_000

// Rate-limit: max N tokens issued per IP per minute.
// Prevents memory exhaustion via /auth spam.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX       = 10
const _rateBuckets = new Map<string, { count: number; windowStart: number }>()

function checkRateLimit(ip: string): boolean {
  const now    = Date.now()
  const bucket = _rateBuckets.get(ip)
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    _rateBuckets.set(ip, { count: 1, windowStart: now })
    return true
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false
  bucket.count++
  return true
}

const issued = new Map<string, IssuedToken>()

function purgeExpired(): void {
  const now = Date.now()
  for (const [token, rec] of [...issued.entries()]) {
    if (rec.expiresAt <= now) issued.delete(token)
  }
  // Also purge stale rate-limit buckets
  for (const [ip, bucket] of [..._rateBuckets.entries()]) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) _rateBuckets.delete(ip)
  }
}

// Periodic cleanup — runs every 2 minutes regardless of traffic.
// Without this, issued tokens accumulate in memory until the next
// issueToken/verifyToken call (lazy purge only).
setInterval(purgeExpired, 2 * 60_000).unref?.()


/** Returns false if this IP has exceeded the rate limit. */
export function isRateLimited(ip: string): boolean {
  return !checkRateLimit(ip)
}

/** Mint a fresh auth token for the given identity (valid until TOKEN_TTL_MS expires). */
export function issueToken(userId: string, displayName: string): string {
  purgeExpired()
  const token = crypto.randomBytes(24).toString('base64url')
  issued.set(token, {
    userId,
    displayName,
    expiresAt: Date.now() + TOKEN_TTL_MS
  })
  return token
}

/**
 * Look up a token. Returns null if missing/expired.
 * NOT single-use — Colyseus's matchmaker can POST to /matchmake/joinOrCreate
 * up to MaxRetriesCount=2 times with the same token; we'd reject the retries
 * if we consumed on first read.
 */
export function verifyToken(token: string): { userId: string; displayName: string } | null {
  purgeExpired()
  const rec = issued.get(token)
  if (!rec) return null
  if (rec.expiresAt <= Date.now()) { issued.delete(token); return null }
  return { userId: rec.userId, displayName: rec.displayName }
}
