import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import type {
  AppSettings,
  ConnectionConfig,
  ConnectionSummary,
  HistoryEntry,
  SavedQuery
} from '../shared/types'

interface StoredConnection extends Omit<ConnectionConfig, 'password'> {
  passwordEnc?: string
  sshPasswordEnc?: string
  sshPassphraseEnc?: string
}

interface StoredSettings {
  defaultRowLimit: number
  confirmDestructive: boolean
  aiKeyEnc?: string
  aiModel: string
}

const DEFAULT_SETTINGS: StoredSettings = {
  defaultRowLimit: 500,
  confirmDestructive: true,
  aiModel: 'claude-sonnet-5'
}

const HISTORY_CAP = 500

const dataDir = (): string => app.getPath('userData')
const filePath = (name: string): string => join(dataDir(), name)

function readJson<T>(name: string, fallback: T): T {
  try {
    const p = filePath(name)
    if (!existsSync(p)) return fallback
    return JSON.parse(readFileSync(p, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(filePath(name), JSON.stringify(value, null, 2), 'utf-8')
}

function encrypt(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(value).toString('base64')
  }
  return 'raw:' + Buffer.from(value, 'utf-8').toString('base64')
}

function decrypt(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    if (value.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    }
    if (value.startsWith('raw:')) {
      return Buffer.from(value.slice(4), 'base64').toString('utf-8')
    }
  } catch {
    return undefined
  }
  return value
}

/* ————————————————————— connections ————————————————————— */

function readConnections(): StoredConnection[] {
  return readJson<StoredConnection[]>('connections.json', [])
}

export function listConnections(): ConnectionSummary[] {
  return readConnections().map((s) => {
    // the *Enc fields are intentionally dropped here — secrets never reach the renderer
    const { passwordEnc: _p, sshPasswordEnc: _sp, sshPassphraseEnc: _spp, ssh, ...rest } = s
    return {
      ...rest,
      hasPassword: Boolean(s.passwordEnc),
      ssh: ssh
        ? {
            enabled: ssh.enabled,
            host: ssh.host,
            port: ssh.port,
            user: ssh.user,
            privateKeyPath: ssh.privateKeyPath
          }
        : undefined
    }
  })
}

export function saveConnection(cfg: ConnectionConfig): ConnectionSummary[] {
  const items = readConnections()
  const existing = items.find((s) => s.id === cfg.id)
  const { password, ssh, ...rest } = cfg

  const stored: StoredConnection = {
    ...rest,
    ssh: ssh
      ? {
          enabled: ssh.enabled,
          host: ssh.host,
          port: ssh.port,
          user: ssh.user,
          privateKeyPath: ssh.privateKeyPath
        }
      : undefined,
    // keep previously saved secrets when the form leaves them blank
    passwordEnc: password ? encrypt(password) : existing?.passwordEnc,
    sshPasswordEnc: ssh?.password ? encrypt(ssh.password) : existing?.sshPasswordEnc,
    sshPassphraseEnc: ssh?.passphrase ? encrypt(ssh.passphrase) : existing?.sshPassphraseEnc
  }

  const idx = items.findIndex((s) => s.id === cfg.id)
  if (idx >= 0) items[idx] = stored
  else items.push(stored)
  writeJson('connections.json', items)
  return listConnections()
}

export function deleteConnection(id: string): ConnectionSummary[] {
  writeJson(
    'connections.json',
    readConnections().filter((s) => s.id !== id)
  )
  return listConnections()
}

export function getFullConfig(id: string): ConnectionConfig | undefined {
  const s = readConnections().find((c) => c.id === id)
  if (!s) return undefined
  const { passwordEnc, sshPasswordEnc, sshPassphraseEnc, ssh, ...rest } = s
  return {
    ...rest,
    password: decrypt(passwordEnc),
    ssh: ssh
      ? { ...ssh, password: decrypt(sshPasswordEnc), passphrase: decrypt(sshPassphraseEnc) }
      : undefined
  }
}

/* ————————————————————— query history ————————————————————— */

export function listHistory(limit = 200, search = ''): HistoryEntry[] {
  const all = readJson<HistoryEntry[]>('history.json', [])
  const q = search.trim().toLowerCase()
  const filtered = q ? all.filter((h) => h.sql.toLowerCase().includes(q)) : all
  return filtered.slice(0, limit)
}

export function addHistory(entry: HistoryEntry): void {
  const all = readJson<HistoryEntry[]>('history.json', [])
  all.unshift(entry)
  writeJson('history.json', all.slice(0, HISTORY_CAP))
}

export function clearHistory(): void {
  writeJson('history.json', [])
}

/* ————————————————————— saved queries ————————————————————— */

export function listSaved(): SavedQuery[] {
  return readJson<SavedQuery[]>('saved.json', []).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveQuery(q: SavedQuery): SavedQuery[] {
  const all = readJson<SavedQuery[]>('saved.json', [])
  const idx = all.findIndex((x) => x.id === q.id)
  if (idx >= 0) all[idx] = q
  else all.push(q)
  writeJson('saved.json', all)
  return listSaved()
}

export function deleteSaved(id: string): SavedQuery[] {
  writeJson(
    'saved.json',
    readJson<SavedQuery[]>('saved.json', []).filter((x) => x.id !== id)
  )
  return listSaved()
}

/* ————————————————————— settings ————————————————————— */

function readSettings(): StoredSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<StoredSettings>>('settings.json', {}) }
}

export function getSettings(): AppSettings {
  const s = readSettings()
  return {
    defaultRowLimit: s.defaultRowLimit,
    confirmDestructive: s.confirmDestructive,
    hasAiKey: Boolean(s.aiKeyEnc),
    aiModel: s.aiModel
  }
}

export function updateSettings(patch: Partial<AppSettings> & { aiKey?: string }): AppSettings {
  const current = readSettings()
  const next: StoredSettings = {
    ...current,
    defaultRowLimit: patch.defaultRowLimit ?? current.defaultRowLimit,
    confirmDestructive: patch.confirmDestructive ?? current.confirmDestructive,
    aiModel: patch.aiModel ?? current.aiModel
  }
  if (patch.aiKey !== undefined) {
    next.aiKeyEnc = patch.aiKey ? encrypt(patch.aiKey) : undefined
  }
  writeJson('settings.json', next)
  return getSettings()
}

export function getAiKey(): string | undefined {
  return decrypt(readSettings().aiKeyEnc)
}
