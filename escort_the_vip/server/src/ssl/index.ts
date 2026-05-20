import * as fs from 'fs'
import * as path from 'path'
import { generateSelfSignedCert } from './self-signed'
import { getLetsEncryptCert, ChallengeType } from './letsencrypt'

export type SSLMode = 'none' | 'self-signed' | 'letsencrypt' | 'custom'

export interface SSLConfig {
  mode: SSLMode
  certsDir?: string
  domain?: string
  email?: string
  staging?: boolean
  certPath?: string
  keyPath?: string
  challengeType?: ChallengeType
  duckdnsToken?: string
}

export interface SSLCredentials {
  key: Buffer
  cert: Buffer
}

export async function getSSLCredentials(cfg: SSLConfig): Promise<SSLCredentials | null> {
  if (cfg.mode === 'none') return null

  const certsDir = cfg.certsDir ?? path.join(process.cwd(), 'certs')

  if (cfg.mode === 'self-signed') {
    return generateSelfSignedCert({ certsDir, domain: cfg.domain ?? 'localhost' })
  }

  if (cfg.mode === 'letsencrypt') {
    if (!cfg.domain || !cfg.email) {
      throw new Error('[SSL] SSL_DOMAIN and SSL_EMAIL are required for letsencrypt mode')
    }
    return getLetsEncryptCert({
      domain: cfg.domain,
      email: cfg.email,
      certsDir,
      staging: cfg.staging ?? false,
      challengeType: cfg.challengeType ?? 'http-01',
      duckdnsToken: cfg.duckdnsToken
    })
  }

  if (cfg.mode === 'custom') {
    const certPath = cfg.certPath ?? path.join(certsDir, 'fullchain.pem')
    const keyPath = cfg.keyPath ?? path.join(certsDir, 'key.pem')
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      throw new Error(`[SSL] Certificate files not found:\n  cert: ${certPath}\n  key:  ${keyPath}`)
    }
    console.log('[SSL] Using custom certificate')
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
  }

  return null
}
