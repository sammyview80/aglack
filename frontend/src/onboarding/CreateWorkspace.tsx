import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'
import { ThemeSwitch } from '../discord-ui/ThemeSwitch'
import './start-screen.css'

export type CreateWorkspaceInput = {
  ownerName: string
  workspaceName: string
  password?: string
  kind?: 'headless' | 'server'
}

type Props = {
  onBack: () => void
  onCreate: (input: CreateWorkspaceInput) => void
  busy: boolean
  error: string
  initial?: Partial<CreateWorkspaceInput>
}

/**
 * Slack-style create step: left form, right live workspace preview.
 * Shares tokens with StartScreen via start-screen.css.
 */
export function CreateWorkspace({ onBack, onCreate, busy, error, initial }: Props) {
  const [ownerName, setOwnerName] = useState(initial?.ownerName || '')
  const [workspaceName, setWorkspaceName] = useState(initial?.workspaceName || '')
  const [password, setPassword] = useState(initial?.password || '')
  const [showPassword, setShowPassword] = useState(false)
  const [kind, setKind] = useState<'headless' | 'server'>(initial?.kind || 'headless')
  const previewName = workspaceName.trim() || 'Hermes'
  const previewInitial = previewName.charAt(0).toUpperCase()

  function submit(e: FormEvent) {
    e.preventDefault()
    const owner = ownerName.trim()
    const ws = workspaceName.trim()
    if (!owner || !ws || busy) return
    onCreate({
      ownerName: owner,
      workspaceName: ws,
      password: password.trim() || undefined,
      kind,
    })
  }

  return (
    <div className="onboarding-shell ob-landing">
      <div className="ob-landing__split">
        <section className="ob-landing__pane">
          <header className="ob-landing__brandbar">
            <Link to="/" className="ob-landing__brand">
              <span className="ob-landing__mark" aria-hidden="true">H</span>
              <span className="ob-landing__name">Hermes</span>
            </Link>
            <ThemeSwitch />
          </header>

          <form className="ob-landing__copy ob-landing__copy--form" onSubmit={submit}>
            <p className="ob-landing__step">Step 1 of 4</p>
            <h1>Create a workspace</h1>
            <p className="ob-landing__lead">
              Choose a name and environment for your new workspace.
            </p>

            {error ? <p className="ob-error" role="alert">{error}</p> : null}

            <div className="ob-field-group">
              <label htmlFor="owner-name">Your name</label>
              <input
                id="owner-name"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                disabled={busy}
                autoFocus
                autoComplete="name"
                placeholder="e.g. Alex"
                required
              />
              <p className="ob-field-hint">Shown to teammates as the workspace owner.</p>
            </div>

            <div className="ob-field-group">
              <label htmlFor="ws-name">Workspace name</label>
              <div className="ob-field-prefix">
                <span className="ob-field-prefix__label">hermes /</span>
                <input
                  id="ws-name"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  disabled={busy}
                  autoComplete="off"
                  placeholder="my-workspace"
                  required
                />
              </div>
              <p className="ob-field-hint">Short and memorable. This is what you’ll see in the sidebar.</p>
            </div>

            <div className="ob-field-group">
              <label htmlFor="ws-password">
                Password
                <span className="ob-field-optional">Optional</span>
              </label>
              <div className="ob-input-wrap">
                <input
                  id="ws-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  autoComplete="new-password"
                  placeholder="Add an extra layer of security"
                  style={{ paddingRight: 40 }}
                />
                <button
                  type="button"
                  className="ob-input-icon-btn"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="ob-field-hint">Protect access to this workspace with a private password.</p>
            </div>

            <div className="ob-field-group">
              <label>
                Workspace type
                <span className="ob-field-optional">Default: Standard</span>
              </label>
              <div className="ob-kind-toggle" role="radiogroup" aria-label="Workspace type">
                <button
                  type="button"
                  role="radio"
                  aria-checked={kind === 'headless'}
                  className={`ob-kind-option${kind === 'headless' ? ' is-active' : ''}`}
                  onClick={() => setKind('headless')}
                  disabled={busy}
                >
                  <span className="ob-kind-option__title">Standard</span>
                  <span className="ob-kind-option__hint">Fast, lightweight chat workspace</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={kind === 'server'}
                  className={`ob-kind-option${kind === 'server' ? ' is-active' : ''}`}
                  onClick={() => setKind('server')}
                  disabled={busy}
                >
                  <span className="ob-kind-option__title">Desktop</span>
                  <span className="ob-kind-option__hint">Full Linux desktop with a browser, for visual/GUI tasks</span>
                </button>
              </div>
            </div>

            <div className="ob-landing__actions">
              <button
                type="submit"
                className="ob-btn ob-btn--primary ob-landing__cta"
                disabled={busy || !ownerName.trim() || !workspaceName.trim()}
              >
                {busy ? 'Creating…' : 'Create workspace'}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="ob-landing__secondary"
                onClick={onBack}
                disabled={busy}
              >
                Back
              </button>
            </div>
          </form>
        </section>

        <aside className="ob-landing__preview" aria-hidden="true">
          <div className="ob-mock">
            <div className="ob-mock__rail">
              <span className="ob-mock__dot ob-mock__dot--on">{previewInitial}</span>
              <span className="ob-mock__dot">T</span>
              <span className="ob-mock__dot">C</span>
            </div>
            <div className="ob-mock__side">
              <p className="ob-mock__ws-name">{previewName}</p>
              <p className="ob-mock__label">Work</p>
              <span className="ob-mock__ch is-active"># chat</span>
              <span className="ob-mock__ch"># agents</span>
              <span className="ob-mock__ch"># schedule</span>
            </div>
            <div className="ob-mock__chat">
              <p className="ob-mock__chat-title"># chat</p>
              <div className="ob-mock__msg">
                <span className="ob-mock__who">You</span>
                <span>Plan the next workspace launch.</span>
              </div>
              <div className="ob-mock__msg">
                <span className="ob-mock__who">PM</span>
                <span>On it — I’ll draft the checklist and assign owners.</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
