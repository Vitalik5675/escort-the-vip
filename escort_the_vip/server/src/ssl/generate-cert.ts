/**
 * Standalone script — generates a self-signed certificate.
 * Usage:  npm run cert:self-signed
 */
import 'dotenv/config'
import * as path from 'path'
import { generateSelfSignedCert } from './self-signed'

const certsDir = process.env.CERTS_DIR ?? path.join(process.cwd(), 'certs')
const domain = process.env.SSL_DOMAIN ?? 'localhost'

generateSelfSignedCert({ certsDir, domain })
console.log('Done. Certificate files:')
console.log('  cert:', path.join(certsDir, 'cert.pem'))
console.log('  key: ', path.join(certsDir, 'key.pem'))
