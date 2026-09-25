import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Profile } from '../shared/types'

interface StoredProfile extends Profile {
  /** Base64 of safeStorage-encrypted passphrase, when rememberPassphrase is set */
  passphraseEnc?: string
}

type TrustedHosts = Record<string, string>

const PROFILES_FILE = 'profiles.json'
const HOSTS_FILE = 'trusted-hosts.json'

function dataFile(name: string): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const file = dataFile(name)
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, data: unknown): void {
  writeFileSync(dataFile(name), JSON.stringify(data, null, 2), 'utf8')
}

export const Store = {
  listProfiles(): StoredProfile[] {
    const data = readJson<{ profiles: StoredProfile[] }>(PROFILES_FILE, { profiles: [] })
    return Array.isArray(data.profiles) ? data.profiles : []
  },

  getProfile(id: string): StoredProfile | undefined {
    return Store.listProfiles().find((p) => p.id === id)
  },

  saveProfile(profile: Omit<Profile, 'id'> & { id?: string }, passphrase?: string): Profile {
    const profiles = Store.listProfiles()
    const existing = profile.id ? profiles.find((p) => p.id === profile.id) : undefined
    const stored: StoredProfile = {
      ...profile,
      id: existing?.id ?? randomUUID(),
      passphraseEnc: undefined
    }
    // Keep a remembered passphrase only while the profile still opts in.
    if (profile.rememberPassphrase && existing?.passphraseEnc) {
      stored.passphraseEnc = existing.passphraseEnc
    }

    if (profile.rememberPassphrase && passphrase) {
      if (safeStorage.isEncryptionAvailable()) {
        stored.passphraseEnc = safeStorage.encryptString(passphrase).toString('base64')
      }
      // If encryption is unavailable we silently skip remembering the passphrase
    }

    if (existing) {
      Object.assign(existing, stored)
      writeJson(PROFILES_FILE, { profiles })
      return existing
    }
    profiles.push(stored)
    writeJson(PROFILES_FILE, { profiles })
    return stored
  },

  deleteProfile(id: string): void {
    const profiles = Store.listProfiles().filter((p) => p.id !== id)
    writeJson(PROFILES_FILE, { profiles })
  },

  /** Remember a passphrase against an existing profile (called on connect) */
  rememberPassphrase(profileId: string, passphrase: string): void {
    const profiles = Store.listProfiles()
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile?.rememberPassphrase || !passphrase) return
    if (!safeStorage.isEncryptionAvailable()) return
    profile.passphraseEnc = safeStorage.encryptString(passphrase).toString('base64')
    writeJson(PROFILES_FILE, { profiles })
  },

  getPassphrase(profileId: string): string | undefined {
    const profile = Store.getProfile(profileId)
    if (!profile?.rememberPassphrase || !profile.passphraseEnc) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(profile.passphraseEnc, 'base64'))
    } catch {
      return undefined
    }
  },

  // Trusted SSH host fingerprints ("host:port" -> "SHA256:...")

  getTrustedFingerprint(hostPort: string): string | undefined {
    return readJson<TrustedHosts>(HOSTS_FILE, {})[hostPort]
  },

  setTrustedFingerprint(hostPort: string, fingerprint: string): void {
    const hosts = readJson<TrustedHosts>(HOSTS_FILE, {})
    hosts[hostPort] = fingerprint
    writeJson(HOSTS_FILE, hosts)
  }
}
