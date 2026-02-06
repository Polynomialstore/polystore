import { useEffect, useState } from 'react'
import { getFaucetAuthToken, hasBuildFaucetAuthToken, setFaucetAuthToken } from '../lib/faucetAuthToken'

export function FaucetAuthTokenInput({ className = '' }: { className?: string }) {
  const [token, setToken] = useState('')
  const [visible, setVisible] = useState(false)
  const [hasSavedToken, setHasSavedToken] = useState(false)
  const [buildTokenConfigured, setBuildTokenConfigured] = useState(false)

  useEffect(() => {
    const saved = getFaucetAuthToken()
    setToken(saved ?? '')
    setHasSavedToken(Boolean(saved))
    setBuildTokenConfigured(hasBuildFaucetAuthToken())
  }, [])

  const handleSave = () => {
    const trimmed = token.trim()
    setFaucetAuthToken(trimmed ? trimmed : null)
    const saved = getFaucetAuthToken()
    setToken(saved ?? '')
    setHasSavedToken(Boolean(saved))
  }

  const handleClear = () => {
    setFaucetAuthToken(null)
    const saved = getFaucetAuthToken()
    setToken(saved ?? '')
    setHasSavedToken(Boolean(saved))
  }

  return (
    <div className={`rounded-xl border border-border bg-secondary/10 p-4 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Faucet access token</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Only needed if the faucet responds with <span className="font-mono">Unauthorized</span>. Stored in your browser
            only.
          </div>
          {buildTokenConfigured ? (
            <div className="mt-1 text-[11px] text-muted-foreground">
              A deployment-level faucet token is configured for this site.
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className="mt-3 flex flex-col sm:flex-row gap-2">
        <input
          value={token}
          type={visible ? 'text' : 'password'}
          placeholder={hasSavedToken ? 'Token saved' : 'Paste token (optional)'}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSave()
            }
          }}
          className="w-full rounded-md border border-border bg-background/70 px-3 py-2 text-sm font-mono"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!token.trim()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={!hasSavedToken}
            className="inline-flex items-center justify-center rounded-md border border-border bg-background/60 px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary/50 disabled:opacity-50 disabled:pointer-events-none"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  )
}
