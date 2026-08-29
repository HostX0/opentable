import { useEffect, useState } from 'react'
import type { AiProvider, AppSettings } from '../../../shared/types'
import type { UpdateState } from '../../../preload/index.d'

interface Props {
  settings: AppSettings
  onSave: (patch: Partial<AppSettings> & { aiKey?: string }) => void
  onClose: () => void
}

const MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — fast, great default' },
  { id: 'claude-opus-5', label: 'Claude Opus 5 — most capable' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — cheapest' }
]

export default function SettingsModal({ settings, onSave, onClose }: Props): React.JSX.Element {
  const [rowLimit, setRowLimit] = useState(settings.defaultRowLimit)
  const [confirmDestructive, setConfirmDestructive] = useState(settings.confirmDestructive)
  const [aiKey, setAiKey] = useState('')
  const [aiModel, setAiModel] = useState(settings.aiModel)
  const [aiProvider, setAiProvider] = useState<AiProvider>(settings.aiProvider)
  const [aiBaseUrl, setAiBaseUrl] = useState(settings.aiBaseUrl)
  const local = aiProvider === 'openai-compatible'
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    window.opentable.updates.state().then(setUpdate)
    const off = window.opentable.updates.onState(setUpdate)
    return () => {
      window.removeEventListener('keydown', onKey)
      off()
    }
  }, [onClose])

  const updateLabel = (): string => {
    switch (update.status) {
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return `Version ${update.version} found — downloading`
      case 'downloading':
        return `Downloading… ${update.percent}%`
      case 'ready':
        return `Version ${update.version} ready to install`
      case 'none':
        return `You are on the latest version (${update.version})`
      case 'unsupported':
        return update.reason
      case 'error':
        return `Could not check for updates: ${update.message}`
      default:
        return 'Checked automatically every few hours'
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h3>Settings</h3>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Default row limit</label>
            <input
              type="number"
              min={0}
              value={rowLimit}
              onChange={(e) => setRowLimit(Number(e.target.value))}
            />
            <span className="field-note">
              Bare SELECTs get this LIMIT so a huge table cannot freeze the app. 0 disables it.
            </span>
          </div>

          <label className="checkline">
            <input
              type="checkbox"
              checked={confirmDestructive}
              onChange={(e) => setConfirmDestructive(e.target.checked)}
            />
            Confirm before running writes on production, or UPDATE/DELETE without WHERE
          </label>

          <div className="divider" />

          <div className="field">
            <label>AI provider</label>
            <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value as AiProvider)}>
              <option value="anthropic">Anthropic</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
            <span className="field-note">
              {local
                ? 'Ollama and LM Studio locally; vLLM, OpenRouter, Groq or NVIDIA NIM remotely.'
                : 'Claude models through the Anthropic API.'}
            </span>
          </div>

          <div className="field">
            <label>{local ? 'Server URL' : 'API endpoint'}</label>
            <input
              value={aiBaseUrl}
              onChange={(e) => setAiBaseUrl(e.target.value)}
              placeholder={local ? 'http://localhost:11434' : 'https://api.anthropic.com'}
              spellCheck={false}
            />
            <span className="field-note">
              Leave empty for the default. The path is appended for you, so the root is enough.
            </span>
          </div>

          <div className="field">
            <label>{local ? 'API key (optional)' : 'Anthropic API key'}</label>
            <input
              type="password"
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              placeholder={
                settings.hasAiKey
                  ? '••••••••  (saved)'
                  : local
                    ? 'not needed for local models'
                    : 'sk-ant-…'
              }
            />
            <span className="field-note">
              Stored encrypted in your OS keychain, and sent only to the endpoint above.
            </span>
          </div>

          <div className="field">
            <label>Model</label>
            {local ? (
              <input
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                placeholder="llama3.1, qwen2.5-coder, gpt-4o-mini…"
                spellCheck={false}
              />
            ) : (
              <select value={aiModel} onChange={(e) => setAiModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
            <span className="field-note">
              Your schema is sent to this model as context. A local one keeps it on this machine.
            </span>
          </div>

          <div className="divider" />

          <div className="update-row">
            <span className="field-note">{updateLabel()}</span>
            {update.status === 'ready' ? (
              <button className="btn-mini primary" onClick={() => window.opentable.updates.install()}>
                Restart & install
              </button>
            ) : (
              <button
                className="btn-mini"
                disabled={update.status === 'checking' || update.status === 'downloading'}
                onClick={() => window.opentable.updates.check().then(setUpdate)}
              >
                {update.status === 'checking' ? 'Checking…' : 'Check now'}
              </button>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() =>
              onSave({
                defaultRowLimit: rowLimit,
                confirmDestructive,
                aiProvider,
                aiBaseUrl,
                aiModel,
                ...(aiKey ? { aiKey } : {})
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
