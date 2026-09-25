// Minimal 'electron' stub so src/main modules can run under plain Node in tests.
const fs = require('fs')
const userData = process.env.DROPLET_FILES_TEST_USER_DATA
if (!userData) throw new Error('DROPLET_FILES_TEST_USER_DATA must point to an isolated test directory')
fs.mkdirSync(userData, { recursive: true })

module.exports = {
  app: {
    getPath: () => userData
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`test-only:${String(s)}`, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^test-only:/, '')
  }
}
