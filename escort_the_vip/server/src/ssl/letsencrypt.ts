/**
 * Let's Encrypt certificate via ACME.
 *
 * Challenge modes:
 *   http-01        — serves challenge on port 80 (must be open from internet)
 *   dns-01-duckdns — updates TXT record via DuckDNS API (works behind NAT)
 *
 * See `.env.example` for required SSL_MODE / SSL_DOMAIN / SSL_EMAIL /
 * ACME_CHALLENGE / DUCKDNS_TOKEN variables.
 */

import * as acme from 'acme-client'
import * as http from 'http'
import * as dns from 'dns'
import * as fs from 'fs'
import * as path from 'path'

export type ChallengeType = 'http-01' | 'dns-01-duckdns'

export interface LetsEncryptOptions {
  domain: string
  email: string
  certsDir: string
  staging?: boolean
  challengeType?: ChallengeType
  duckdnsToken?: string
}

// Certs are renewed if older than 60 days (LE issues 90-day certs)
function shouldRenew(certPath: string): boolean {
  try {
    const ageMs = Date.now() - fs.statSync(certPath).mtimeMs
    return ageMs > 60 * 24 * 60 * 60 * 1000
  } catch {
    return true
  }
}

async function duckdnsSetTxt(subdomain: string, token: string, value: string, clear = false): Promise<void> {
  const params = new URLSearchParams({
    domains: subdomain,
    token,
    txt: value,
    verbose: 'true',
    ...(clear ? { clear: 'true' } : {})
  })
  const url = `https://www.duckdns.org/update?${params}`
  const res = await fetch(url)
  const text = (await res.text()).trim()
  if (!text.startsWith('OK')) throw new Error(`DuckDNS update failed: ${text}`)
  console.log(`[SSL] DuckDNS TXT ${clear ? 'cleared' : 'set'} — ${text}`)
}

/**
 * Verify TXT record via DNS-over-HTTPS (Cloudflare DoH).
 * Uses HTTPS port 443 — works even when UDP port 53 is blocked.
 */
async function checkTxtViaDoH(fqdn: string, expectedValue: string): Promise<boolean> {
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(fqdn)}&type=TXT`
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(8_000)
    })
    const data = await res.json() as { Answer?: Array<{ data: string }> }
    const records = (data.Answer ?? []).map((a) => a.data.replace(/^"|"$/g, ''))
    return records.includes(expectedValue)
  } catch {
    return false
  }
}

/**
 * Verify TXT record via classic DNS using public resolvers.
 */
function checkTxtViaDns(fqdn: string, expectedValue: string, resolverIp: string): Promise<boolean> {
  return new Promise((resolve) => {
    const r = new dns.Resolver()
    r.setServers([resolverIp])
    r.resolveTxt(fqdn, (err, records) => {
      if (err) return resolve(false)
      resolve(records.flat().includes(expectedValue))
    })
  })
}

/**
 * Poll until the TXT record is visible via both DNS-over-HTTPS and
 * at least one public UDP resolver. This mirrors what Let's Encrypt
 * validators will see.
 */
async function waitForTxtPropagation(
  fqdn: string,
  expectedValue: string,
  pollIntervalMs = 10_000,
  maxWaitMs = 180_000
): Promise<void> {
  const publicResolvers = ['1.1.1.1', '9.9.9.9', '208.67.222.222']
  const deadline = Date.now() + maxWaitMs
  console.log(`[SSL] Waiting for TXT to propagate on ${fqdn}...`)

  while (Date.now() < deadline) {
    // Check via DoH (HTTPS port 443 — always works through firewalls)
    const dohOk = await checkTxtViaDoH(fqdn, expectedValue)

    // Check via UDP DNS public resolvers
    const dnsChecks = await Promise.allSettled(
      publicResolvers.map((ip) => checkTxtViaDns(fqdn, expectedValue, ip))
    )
    const dnsOk = dnsChecks.filter((r) => r.status === 'fulfilled' && r.value).length

    console.log(`[SSL]   DoH: ${dohOk ? '✓' : '✗'}  UDP resolvers: ${dnsOk}/${publicResolvers.length}`)

    // Require DoH AND at least one UDP resolver to confirm
    if (dohOk && dnsOk >= 1) {
      console.log('[SSL] TXT confirmed via DoH + DNS — proceeding')
      return
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }

  console.warn('[SSL] TXT not fully confirmed within timeout — proceeding anyway')
}

export async function getLetsEncryptCert(opts: LetsEncryptOptions): Promise<{ key: Buffer; cert: Buffer }> {
  const {
    domain,
    email,
    certsDir,
    staging = false,
    challengeType = 'http-01',
    duckdnsToken
  } = opts

  if (challengeType === 'dns-01-duckdns' && !duckdnsToken) {
    throw new Error('[SSL] DUCKDNS_TOKEN is required for dns-01-duckdns challenge type')
  }

  const certPath = path.join(certsDir, 'fullchain.pem')
  const keyPath = path.join(certsDir, 'key.pem')

  if (fs.existsSync(certPath) && fs.existsSync(keyPath) && !shouldRenew(certPath)) {
    console.log("[SSL] Existing Let's Encrypt certificate is still valid — reusing")
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
  }

  const mode = staging ? 'STAGING' : 'PRODUCTION'
  console.log(`[SSL] Requesting Let's Encrypt cert for "${domain}" [${mode}] via ${challengeType}`)

  // Pre-clear any stale TXT from a previous failed attempt
  if (challengeType === 'dns-01-duckdns' && duckdnsToken) {
    const subdomain = domain.replace(/\.duckdns\.org$/, '')
    await duckdnsSetTxt(subdomain, duckdnsToken, '', true).catch(() => {})
    await new Promise((r) => setTimeout(r, 5_000))
  }

  // ── HTTP-01: temporary server on port 80 ─────────────────────────────────
  let challengeServer: http.Server | null = null
  const httpChallenges: Record<string, string> = {}

  if (challengeType === 'http-01') {
    challengeServer = http.createServer((req, res) => {
      const prefix = '/.well-known/acme-challenge/'
      if (req.url?.startsWith(prefix)) {
        const token = req.url.slice(prefix.length)
        const body = httpChallenges[token]
        if (body) {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(body)
          return
        }
      }
      res.writeHead(200)
      res.end('OK')
    })
    await new Promise<void>((resolve, reject) =>
      challengeServer!.listen(80, () => resolve()).on('error', (e) => {
        console.error('[SSL] Could not bind port 80 — try running as Administrator or use dns-01-duckdns mode')
        reject(e)
      })
    )
    console.log('[SSL] ACME challenge server listening on :80')
  }

  try {
    const accountKey = await acme.crypto.createPrivateKey()
    const client = new acme.Client({
      directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
      accountKey
    })

    const [key, csr] = await acme.crypto.createCsr({ altNames: [domain] })

    const challengePriority: string[] =
      challengeType === 'dns-01-duckdns' ? ['dns-01', 'http-01'] : ['http-01', 'dns-01']

    const cert = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      // Skip local self-verification — acme-client otherwise tries to fetch the
      // challenge through our own public IP. Home routers typically don't
      // support NAT hairpin loopback, and system DNS may return stale TXT
      // records. With this flag the server signals "ready" and LE validates
      // from its external vantage point.
      skipChallengeVerification: true,
      challengePriority: challengePriority as ['http-01' | 'dns-01' | 'tls-alpn-01'],

      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        if (challenge.type === 'http-01') {
          httpChallenges[challenge.token] = keyAuthorization
        } else if (challenge.type === 'dns-01' && challengeType === 'dns-01-duckdns') {
          const subdomain = domain.replace(/\.duckdns\.org$/, '')
          await duckdnsSetTxt(subdomain, duckdnsToken!, keyAuthorization)
          await waitForTxtPropagation(`_acme-challenge.${domain}`, keyAuthorization)
        }
      },

      challengeRemoveFn: async (_authz, challenge) => {
        if (challenge.type === 'http-01') {
          delete httpChallenges[challenge.token]
        } else if (challenge.type === 'dns-01' && challengeType === 'dns-01-duckdns') {
          const subdomain = domain.replace(/\.duckdns\.org$/, '')
          await duckdnsSetTxt(subdomain, duckdnsToken!, '', true).catch(() => {})
        }
      }
    })

    if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true })

    fs.writeFileSync(keyPath, key)
    fs.writeFileSync(certPath, cert)

    console.log('[SSL] Certificate saved — expires in ~90 days')
    return { key: Buffer.from(key), cert: Buffer.from(cert) }
  } finally {
    challengeServer?.close()
  }
}
