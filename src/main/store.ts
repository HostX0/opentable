import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import type {
  AiProvider,
  AppSettings,
  ChatSession,
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
  aiProvider: AiProvider
  aiBaseUrl: string
  aiModel: string
}

interface SessionSecrets {
  password?: string
  sshPassword?: string
  sshPassphrase?: string
}

const DEFAULT_SETTINGS: StoredSettings = {
  defaultRowLimit: 500,
  confirmDestructive: true,
  aiProvider: 'anthropic',
  aiBaseUrl: '',
  aiModel: 'claude-sonnet-5'
}

const HISTORY_CAP = 500
const sessionConnectionSecrets = new Map<string, SessionSecrets>()
let sessionAiKey: string | undefined

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

/** Atomic replace so a crash cannot leave half-written JSON behind. */
function writeJson(name: string, value: unknown): void {
  mkdirSync(dataDir(), { recursive: true })
  const target = filePath(name)
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, target)
}

/**
 * Electron can fall back to Linux's `basic_text` backend. It is deliberately
 * excluded here: a password manager must not silently turn a secret into
 * reversible local text just because a system keyring is unavailable.
 */
function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform !== 'linux') return true
  try {
    const backend = (
      safeStorage as unknown as { getSelectedStorageBackend?: () => string }
    ).getSelectedStorageBackend?.()
    return backend !== 'basic_text'
  } catch {
    return false
  }
}

function encrypt(value: string | undefined): string | undefined {
  if (!value || !secureStorageAvailable()) return undefined
  return 'enc:' + safeStorage.encryptString(value).toString('base64')
}

function legacyRaw(value: string | undefined): string | undefined {
  if (!value?.startsWith('raw:')) return undefined
  try {
    return Buffer.from(value.slice(4), 'base64').toString('utf-8')
  } catch {
    return undefined
  }
}

function decrypt(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    if (value.startsWith('enc:') && secureStorageAvailable()) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    }
    // Read old versions long enough to migrate them out of the file. New code
    // never writes raw: secrets.
    if (value.startsWith('raw:')) return legacyRaw(value)
  } catch {
    return undefined
  }
  return undefined
}

/* ————————————————————— connections ————————————————————— */

function readConnections(): StoredConnection[] {
  const items = readJson<StoredConnection[]>('connections.json', [])
  let migrated = false

  for (const item of items) {
    const session = sessionConnectionSecrets.get(item.id) ?? {}
    const password = legacyRaw(item.passwordEnc)
    const sshPassword = legacyRaw(item.sshPasswordEnc)
    const sshPassphrase = legacyRaw(item.sshPassphraseEnc)
    if (password !== undefined) {
      session.password = password
      delete item.passwordEnc
      migrated = true
    }
    if (sshPassword !== undefined) {
      session.sshPassword = sshPassword
      delete item.sshPasswordEnc
      migrated = true
    }
    if (sshPassphrase !== undefined) {
      session.sshPassphrase = sshPassphrase
      delete item.sshPassphraseEnc
      migrated = true
    }
    if (Object.keys(session).length) sessionConnectionSecrets.set(item.id, session)
  }

  // Upgrade legacy raw: values immediately. If the OS keychain is available we
  // persist encrypted replacements; otherwise the migrated values stay in RAM
  // for this session and disappear from disk.
  if (migrated) {
    for (const item of items) {
      const session = sessionConnectionSecrets.get(item.id)
      if (!session || !secureStorageAvailable()) continue
      if (session.password && !item.passwordEnc) {
        item.passwordEnc = encrypt(session.password)
        delete session.password
      }
      if (session.sshPassword && !item.sshPasswordEnc) {
        item.sshPasswordEnc = encrypt(session.sshPassword)
        delete session.sshPassword
      }
      if (session.sshPassphrase && !item.sshPassphraseEnc) {
        item.sshPassphraseEnc = encrypt(session.sshPassphrase)
        delete session.sshPassphrase
      }
      if (!Object.keys(session).length) sessionConnectionSecrets.delete(item.id)
    }
    writeJson('connections.json', items)
  }
  return items
}

export function listConnections(): ConnectionSummary[] {
  return readConnections().map((s) => {
    const { passwordEnc: _p, sshPasswordEnc: _sp, sshPassphraseEnc: _spp, ssh, ...rest } = s
    const session = sessionConnectionSecrets.get(s.id)
    return {
      ...rest,
      hasPassword: Boolean(s.passwordEnc || session?.password),
      ssh: ssh
        ? {
            enabled: ssh.enabled,
            authMethod: ssh.authMethod,
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
  const session = sessionConnectionSecrets.get(cfg.id) ?? {}
  const canPersist = secureStorageAvailable()

  const persistOrSession = (
    value: string | undefined,
    existingValue: string | undefined,
    sessionKey: keyof SessionSecrets
  ): string | undefined => {
    if (!value) return existingValue
    if (canPersist) {
      delete session[sessionKey]
      return encrypt(value)
    }
    session[sessionKey] = value
    return undefined
  }

  const stored: StoredConnection = {
    ...rest,
    ssh: ssh
      ? {
          enabled: ssh.enabled,
          authMethod: ssh.authMethod,
          host: ssh.host,
          port: ssh.port,
          user: ssh.user,
          privateKeyPath: ssh.privateKeyPath
        }
      : undefined,
    passwordEnc: persistOrSession(password, existing?.passwordEnc, 'password'),
    sshPasswordEnc: persistOrSession(ssh?.password, existing?.sshPasswordEnc, 'sshPassword'),
    sshPassphraseEnc: persistOrSession(
      ssh?.passphrase,
      existing?.sshPassphraseEnc,
      'sshPassphrase'
    )
  }

  if (Object.keys(session).length) sessionConnectionSecrets.set(cfg.id, session)
  else sessionConnectionSecrets.delete(cfg.id)

  const idx = items.findIndex((s) => s.id === cfg.id)
  if (idx >= 0) items[idx] = stored
  else items.push(stored)
  writeJson('connections.json', items)
  return listConnections()
}

export function deleteConnection(id: string): ConnectionSummary[] {
  sessionConnectionSecrets.delete(id)
  writeJson(
    'connections.json',
    readConnections().filter((s) => s.id !== id)
  )
  return listConnections()
}

export function getFullConfig(id: string): ConnectionConfig | undefined {
  const s = readConnections().find((c) => c.id === id)
  if (!s) return undefined
  const session = sessionConnectionSecrets.get(id)
  const { passwordEnc, sshPasswordEnc, sshPassphraseEnc, ssh, ...rest } = s
  return {
    ...rest,
    password: decrypt(passwordEnc) ?? session?.password,
    ssh: ssh
      ? {
          ...ssh,
          password: decrypt(sshPasswordEnc) ?? session?.sshPassword,
          passphrase: decrypt(sshPassphraseEnc) ?? session?.sshPassphrase
        }
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

/* ————————————————————— chat sessions ————————————————————— */

const CHAT_CAP = 100

export function listChats(): ChatSession[] {
  return readJson<ChatSession[]>('chats.json', []).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveChat(session: ChatSession): ChatSession[] {
  const all = readJson<ChatSession[]>('chats.json', [])
  const idx = all.findIndex((c) => c.id === session.id)
  if (idx >= 0) all[idx] = session
  else all.push(session)
  const trimmed = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CHAT_CAP)
  writeJson('chats.json', trimmed)
  return listChats()
}

export function deleteChat(id: string): ChatSession[] {
  writeJson(
    'chats.json',
    readJson<ChatSession[]>('chats.json', []).filter((c) => c.id !== id)
  )
  return listChats()
}

/* ————————————————————— settings ————————————————————— */

function readSettings(): StoredSettings {
  const loaded = { ...DEFAULT_SETTINGS, ...readJson<Partial<StoredSettings>>('settings.json', {}) }
  const legacy = legacyRaw(loaded.aiKeyEnc)
  if (legacy !== undefined) {
    sessionAiKey = legacy
    loaded.aiKeyEnc = secureStorageAvailable() ? encrypt(legacy) : undefined
    if (loaded.aiKeyEnc) sessionAiKey = undefined
    writeJson('settings.json', loaded)
  }
  return loaded
}

export function getSettings(): AppSettings {
  const s = readSettings()
  return {
    defaultRowLimit: s.defaultRowLimit,
    confirmDestructive: s.confirmDestructive,
    hasAiKey: Boolean(s.aiKeyEnc || sessionAiKey),
    aiProvider: s.aiProvider,
    aiBaseUrl: s.aiBaseUrl,
    aiModel: s.aiModel
  }
}

export function updateSettings(patch: Partial<AppSettings> & { aiKey?: string }): AppSettings {
  const current = readSettings()
  const next: StoredSettings = {
    ...current,
    defaultRowLimit: patch.defaultRowLimit ?? current.defaultRowLimit,
    confirmDestructive: patch.confirmDestructive ?? current.confirmDestructive,
    aiProvider: patch.aiProvider ?? current.aiProvider,
    aiBaseUrl: patch.aiBaseUrl ?? current.aiBaseUrl,
    aiModel: patch.aiModel ?? current.aiModel
  }
  if (patch.aiKey !== undefined) {
    if (!patch.aiKey) {
      next.aiKeyEnc = undefined
      sessionAiKey = undefined
    } else if (secureStorageAvailable()) {
      next.aiKeyEnc = encrypt(patch.aiKey)
      sessionAiKey = undefined
    } else {
      next.aiKeyEnc = undefined
      sessionAiKey = patch.aiKey
    }
  }
  writeJson('settings.json', next)
  return getSettings()
}

export function getAiKey(): string | undefined {
  return decrypt(readSettings().aiKeyEnc) ?? sessionAiKey
}

export function getAiConfig(): {
  provider: AiProvider
  baseUrl: string
  model: string
  key?: string
} {
  const s = readSettings()
  return {
    provider: s.aiProvider,
    baseUrl: s.aiBaseUrl.trim(),
    model: s.aiModel,
    key: decrypt(s.aiKeyEnc) ?? sessionAiKey
  }
}
