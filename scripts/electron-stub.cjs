// Minimal 'electron' stub so src/main modules can run under plain Node in tests.
const fs = require('fs')
const os = require('os')
const path = require('path')

// Fixed user-data dir (the test wipes it before each run for fresh trust state)
const userData = path.join(os.tmpdir(), 'droplet-files-e2e-userdata')
fs.mkdirSync(userData, { recursive: true })

module.exports = {
  app: {
    getPath: () => userData
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(String(s), 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8')
  }
}
