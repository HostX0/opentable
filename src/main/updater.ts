import { app, BrowserWindow } from 'electron'
import pkg from 'electron-updater'

const { autoUpdater } = pkg

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'none'; version: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; message: string }

/** Re-checked every six hours, which is frequent enough without being noisy. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Give the window time to appear before spending bandwidth on a check. */
const FIRST_CHECK_DELAY_MS = 8_000

let current: UpdateState = { status: 'idle' }
let timer: NodeJS.Timeout | undefined

function broadcast(state: UpdateState): void {
  current = state
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:state', state)
  }
}

export function getUpdateState(): UpdateState {
  return current
}

/**
 * Why an update can be impossible even when one exists:
 *
 * - In development there is no packaged app to replace.
 * - On macOS, Squirrel refuses to apply an update unless the app is signed by
 *   a Developer ID. An unsigned build can be told a version exists but can
 *   never install it, so we say so plainly rather than failing later.
 */
function unsupportedReason(): string | null {
  if (!app.isPackaged) return 'Updates only apply to an installed build.'
  if (process.platform === 'darwin' && !app.isInApplicationsFolder?.()) {
    return 'Move OpenTable to your Applications folder to receive updates.'
  }
  return null
}

export function initUpdater(): void {
  const blocked = unsupportedReason()
  if (blocked) {
    current = { status: 'unsupported', reason: blocked }
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => broadcast({ status: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    broadcast({ status: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', () =>
    broadcast({ status: 'none', version: app.getVersion() })
  )
  autoUpdater.on('download-progress', (p) =>
    broadcast({ status: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    broadcast({ status: 'ready', version: info.version })
  )
  autoUpdater.on('error', (err) =>
    broadcast({ status: 'error', message: err?.message ?? String(err) })
  )

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS)
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS)
  app.on('before-quit', () => timer && clearInterval(timer))
}

async function check(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    // offline, or no release published yet — not worth alarming anyone about
    broadcast({ status: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

/** Triggered by the Check now button, so this one reports what it finds. */
export async function checkForUpdates(): Promise<UpdateState> {
  const blocked = unsupportedReason()
  if (blocked) {
    current = { status: 'unsupported', reason: blocked }
    return current
  }
  await check()
  return current
}

export function quitAndInstall(): void {
  if (!app.isPackaged) return
  // isSilent=false so the user sees the installer; isForceRunAfter=true reopens
  autoUpdater.quitAndInstall(false, true)
}
