import selfsigned from 'selfsigned'
import * as fs from 'fs'
import * as path from 'path'

interface Options {
  certsDir: string
  domain?: string
  days?: number
}

export function generateSelfSignedCert(options: Options): { key: Buffer; cert: Buffer } {
  const { certsDir, domain = 'localhost', days = 365 } = options

  const certPath = path.join(certsDir, 'cert.pem')
  const keyPath = path.join(certsDir, 'key.pem')

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    console.log('[SSL] Using existing self-signed certificate')
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
  }

  console.log(`[SSL] Generating self-signed certificate for "${domain}"...`)

  const attrs = [{ name: 'commonName', value: domain }]
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: domain },
          { type: 2, value: 'localhost' }
        ]
      }
    ]
  })

  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true })
  }

  fs.writeFileSync(keyPath, pems.private)
  fs.writeFileSync(certPath, pems.cert)

  console.log(`[SSL] Self-signed certificate saved to ${certsDir}`)
  console.log('[SSL] NOTE: browsers will show a security warning — you must accept it once')

  return { key: Buffer.from(pems.private), cert: Buffer.from(pems.cert) }
}
