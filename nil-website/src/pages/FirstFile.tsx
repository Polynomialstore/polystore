import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount, useBalance, useChainId } from 'wagmi'
import { formatUnits, numberToHex } from 'viem'
import { AlertCircle, CheckCircle2, Coins, Download, HardDrive, Rocket, Upload } from 'lucide-react'

import { appConfig } from '../config'
import { StatusBar } from '../components/StatusBar'
import { ConnectWallet } from '../components/ConnectWallet'
import { FaucetAuthTokenInput } from '../components/FaucetAuthTokenInput'
import { useNetwork } from '../hooks/useNetwork'
import { useFaucet } from '../hooks/useFaucet'
import { useCreateDeal } from '../hooks/useCreateDeal'
import { useUpload, type UploadResult } from '../hooks/useUpload'
import { useUpdateDealContent } from '../hooks/useUpdateDealContent'
import { useFetch } from '../hooks/useFetch'
import { ethToNil } from '../lib/address'
import { buildServiceHint } from '../lib/serviceHint'
import { toHexFromBase64OrHex } from '../domain/hex'
import { classifyWalletError } from '../lib/walletErrors'
import { useWalletNetworkGuard } from '../hooks/useWalletNetworkGuard'

const DURATION_PRESETS = [
  { value: '1d', label: '1 day', seconds: 24 * 60 * 60 },
  { value: '1w', label: '1 week', seconds: 7 * 24 * 60 * 60 },
  { value: '1m', label: '1 month', seconds: 30 * 24 * 60 * 60 },
  { value: '3m', label: '3 months', seconds: 90 * 24 * 60 * 60 },
  { value: '6m', label: '6 months', seconds: 182 * 24 * 60 * 60 },
  { value: '1y', label: '1 year', seconds: 365 * 24 * 60 * 60 },
  { value: '2y', label: '2 years', seconds: 2 * 365 * 24 * 60 * 60 },
  { value: 'custom', label: 'Custom' },
] as const

const DURATION_PRESET_BY_SECONDS = Object.fromEntries(
  DURATION_PRESETS.filter((preset) => preset.value !== 'custom').map((preset) => [preset.value, preset.seconds]),
)

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return `0x${out}`
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle?.digest) return ''
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf)
  return bytesToHex(new Uint8Array(digest))
}

export function FirstFile() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchNetwork } = useNetwork()
  const { requestFunds, loading: faucetLoading, lastTx: faucetTx, txStatus: faucetTxStatus } = useFaucet()
  const { submitDeal, loading: dealLoading, lastTx: dealTx } = useCreateDeal()
  const { upload, loading: uploadLoading } = useUpload()
  const { submitUpdate, loading: commitLoading, lastTx: commitTx } = useUpdateDealContent()
  const { fetchFile, loading: fetchLoading, progress, receiptStatus, receiptError } = useFetch()
  const {
    walletChainId,
    isWrongNetwork: walletIsWrongNetwork,
    genesisMismatch,
    accountPermissionMismatch,
    refresh: refreshWalletNetwork,
  } = useWalletNetworkGuard({ enabled: isConnected, pollMs: 15_000 })

  const [duration, setDuration] = useState('31536000')
  const [durationPreset, setDurationPreset] = useState('1y')
  const [initialEscrow, setInitialEscrow] = useState('1000000')
  const [maxMonthlySpend, setMaxMonthlySpend] = useState('5000000')

  const [dealId, setDealId] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedFileHash, setSelectedFileHash] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null)
  const [commitOk, setCommitOk] = useState(false)
  const [downloadOk, setDownloadOk] = useState<boolean | null>(null)
  const [downloadHash, setDownloadHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const autoSwitchKeyRef = useRef<string | null>(null)

  const activeChainId = walletChainId ?? chainId
  const isWrongNetwork = isConnected && walletIsWrongNetwork
  const nilAddress = useMemo(() => {
    if (!address) return ''
    return address.startsWith('0x') ? ethToNil(address) : address
  }, [address])

  const { data: balance } = useBalance({
    address,
    chainId: appConfig.chainId,
    query: { enabled: Boolean(address) },
  })

  const hasBalance = useMemo(() => {
    try {
      return Boolean(balance?.value && BigInt(balance.value) > 0n)
    } catch {
      return Boolean(balance?.value)
    }
  }, [balance?.value])

  const balanceLabel = useMemo(() => {
    if (!balance) return '—'
    const formatted = formatUnits(balance.value, balance.decimals)
    const [whole, frac] = formatted.split('.')
    const trimmed = frac ? `${whole}.${frac.slice(0, 4)}` : whole
    return `${trimmed} ${balance.symbol || 'NIL'}`
  }, [balance])

  useEffect(() => {
    if (!accountPermissionMismatch) return
    setError('MetaMask account changed. Reconnect wallet and approve access for the active account.')
  }, [accountPermissionMismatch])

  useEffect(() => {
    if (!isConnected || !isWrongNetwork) {
      autoSwitchKeyRef.current = null
      return
    }
    const mismatchKind = genesisMismatch ? 'genesis' : 'chain'
    const key = `${String(activeChainId ?? 'unknown')}:${mismatchKind}`
    if (autoSwitchKeyRef.current === key) return
    autoSwitchKeyRef.current = key
    void switchNetwork({ forceAdd: genesisMismatch })
      .then(() => refreshWalletNetwork())
      .catch(() => undefined)
  }, [
    activeChainId,
    genesisMismatch,
    isConnected,
    isWrongNetwork,
    refreshWalletNetwork,
    switchNetwork,
  ])

  const handleUseSampleFile = async () => {
    setError(null)
    setNotice(null)
    const text = [
      'Hello NilStore 👋',
      '',
      `Timestamp: ${new Date().toISOString()}`,
      `ChainId: ${appConfig.chainId}`,
      '',
      'This file was generated by the First File wizard.',
    ].join('\n')
    const bytes = new TextEncoder().encode(text)
    const file = new File([bytes], 'hello-nilstore.txt', { type: 'text/plain' })
    setSelectedFile(file)
    setUploadResult(null)
    setCommitOk(false)
    setDownloadOk(null)
    setDownloadHash(null)
    const h = await sha256Hex(await file.arrayBuffer())
    setSelectedFileHash(h || null)
  }

  const handleFilePicked = async (file: File | null) => {
    setError(null)
    setNotice(null)
    setSelectedFile(file)
    setUploadResult(null)
    setCommitOk(false)
    setDownloadOk(null)
    setDownloadHash(null)
    setSelectedFileHash(null)
    if (!file) return
    if (file.size > 512 * 1024) return
    const h = await sha256Hex(await file.arrayBuffer())
    setSelectedFileHash(h || null)
  }

  const handleRequestFunds = async () => {
    setError(null)
    setNotice(null)
    try {
      await requestFunds(address)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e) || 'Faucet request failed')
    }
  }

  const handleCreateDeal = async () => {
    setError(null)
    setNotice(null)
    if (!address) {
      setError('Connect wallet first')
      return
    }
    if (!address.startsWith('0x')) {
      setError('EVM 0x address required')
      return
    }
    if (accountPermissionMismatch) {
      setError('MetaMask account changed. Reconnect wallet before creating a deal.')
      return
    }
    if (isWrongNetwork) {
      setError(
        genesisMismatch
          ? `Wrong network identity for chainId ${activeChainId}. Repair MetaMask network settings and retry.`
          : `Wrong network (wallet chainId=${activeChainId}). Switch to ${appConfig.chainId}.`,
      )
      return
    }
    try {
      const res = await submitDeal({
        creator: address,
        durationSeconds: Number(duration),
        initialEscrow,
        maxMonthlySpend,
        serviceHint: buildServiceHint('General', {}),
      })
      setDealId(String(res.deal_id))
    } catch (e) {
      const walletError = classifyWalletError(e, 'Create deal failed')
      setError(walletError.message)
    }
  }

  const handleUpload = async () => {
    setError(null)
    setNotice(null)
    if (!selectedFile) {
      setError('Pick a file first')
      return
    }
    if (!dealId) {
      setError('Create a deal first')
      return
    }
    try {
      const result = await upload(selectedFile, address, { dealId })
      setUploadResult(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e) || 'Upload failed')
    }
  }

  const handleCommit = async () => {
    setError(null)
    setNotice(null)
    setCommitOk(false)
    if (!uploadResult) {
      setError('Upload a file first')
      return
    }
    if (!dealId) {
      setError('Deal ID missing')
      return
    }
    if (!address?.startsWith('0x')) {
      setError('Connect wallet to commit on-chain')
      return
    }

    const cidRaw = String(uploadResult.cid || '').trim()
    const manifestHex = toHexFromBase64OrHex(cidRaw) || cidRaw
    if (!manifestHex.startsWith('0x')) {
      setError('Upload did not return a 0x manifest root; retry upload')
      return
    }

    const totalMdusRaw = uploadResult.totalMdus ?? uploadResult.allocatedLength
    const witnessMdusRaw = uploadResult.witnessMdus
    const totalMdus = Number(totalMdusRaw || 0)
    const witnessMdus = Number(witnessMdusRaw || 0)
    if (!Number.isFinite(totalMdus) || totalMdus <= 0) {
      setError('Upload did not include total_mdus; retry upload')
      return
    }
    if (!Number.isFinite(witnessMdus) || witnessMdus < 0) {
      setError('Upload did not include witness_mdus; retry upload')
      return
    }

    try {
      await submitUpdate({
        creator: address,
        dealId: Number(dealId),
        cid: manifestHex,
        sizeBytes: Number(uploadResult.sizeBytes || 0),
        totalMdus,
        witnessMdus,
      })
      setCommitOk(true)
    } catch (e) {
      const walletError = classifyWalletError(e, 'Commit failed')
      setError(walletError.message)
    }
  }

  const handleRetrieve = async () => {
    setError(null)
    setNotice(null)
    setDownloadOk(null)
    setDownloadHash(null)
    if (!commitOk) {
      setError('Commit content first')
      return
    }
    if (!uploadResult) {
      setError('Upload result missing')
      return
    }
    if (!dealId) {
      setError('Deal ID missing')
      return
    }
    if (!nilAddress) {
      setError('Owner address missing')
      return
    }

    const cidRaw = String(uploadResult.cid || '').trim()
    const manifestHex = toHexFromBase64OrHex(cidRaw) || cidRaw
    if (!manifestHex.startsWith('0x')) {
      setError('Manifest root must be 0x hex')
      return
    }

    const filePath = String(uploadResult.filename || selectedFile?.name || '').trim()
    if (!filePath) {
      setError('Uploaded filename missing')
      return
    }

    const blobSizeBytes = 128 * 1024
    const wantLen = Number(uploadResult.fileSizeBytes || 0)
    const rangeLen = wantLen > 0 ? Math.min(wantLen, blobSizeBytes) : blobSizeBytes
    const rangeNote = wantLen > blobSizeBytes ? ` (first ${rangeLen} bytes)` : ''

    try {
      const res = await fetchFile({
        dealId,
        manifestRoot: manifestHex,
        owner: nilAddress,
        filePath,
        rangeStart: 0,
        rangeLen,
      })
      if (!res?.url) throw new Error('Download failed')

      const anchor = document.createElement('a')
      anchor.href = res.url
      anchor.download = filePath.split('/').pop() || 'download'
      anchor.click()
      setTimeout(() => window.URL.revokeObjectURL(res.url), 1000)

      if (selectedFile && selectedFile.size <= blobSizeBytes) {
        const origHash = selectedFileHash || ''
        const gotHash = await sha256Hex(await res.blob.arrayBuffer())
        setDownloadHash(gotHash || null)
        setDownloadOk(Boolean(origHash && gotHash && origHash === gotHash))
      } else {
        setDownloadOk(true)
      }
      if (rangeNote) {
        setNotice(`Downloaded ${rangeLen} bytes${rangeNote}. Full downloads for larger files require slab metadata.`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e) || 'Fetch failed')
      setDownloadOk(false)
    }
  }

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold text-foreground flex items-center gap-3">
            <Rocket className="w-8 h-8 text-cyan-500" />
            First File Wizard
          </h1>
          <p className="mt-3 text-muted-foreground">
            Guided flow to store and retrieve a file on the devnet. Keep the file ≤128&nbsp;KiB for a full download in this wizard.
          </p>
        </div>
        <Link
          to="/dashboard"
          className="hidden sm:inline-flex items-center gap-2 rounded-lg border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40 transition-colors"
        >
          <HardDrive className="w-4 h-4" />
          Open Dashboard
        </Link>
      </div>

      <StatusBar />

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive flex items-start gap-3">
          <AlertCircle className="w-5 h-5 mt-0.5" />
          <div className="min-w-0">
            <div className="font-semibold">Action required</div>
            <div className="mt-1 text-destructive/90 break-words">{error}</div>
          </div>
        </div>
      )}

      {notice && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-700 dark:text-yellow-200 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 mt-0.5" />
          <div className="min-w-0">
            <div className="font-semibold">Note</div>
            <div className="mt-1 break-words">{notice}</div>
          </div>
        </div>
      )}

    <section className="bg-card rounded-xl border border-border p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-secondary/40 flex items-center justify-center font-bold text-foreground">
              1
            </div>
            <div>
              <div className="font-semibold text-foreground">Connect &amp; switch network</div>
              <div className="text-xs text-muted-foreground">Chain ID {appConfig.chainId}</div>
            </div>
          </div>
          {isConnected && !isWrongNetwork && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <ConnectWallet />
          {isWrongNetwork && (
            <button
              type="button"
              onClick={() => void switchNetwork({ forceAdd: genesisMismatch })}
              className="inline-flex items-center justify-center rounded-lg bg-yellow-600 hover:bg-yellow-500 px-4 py-2 text-sm font-bold text-white transition-colors"
            >
              {genesisMismatch ? 'Repair MetaMask network' : `Switch to ${numberToHex(appConfig.chainId)}`}
            </button>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          Owner address (Nil bech32): <span className="font-mono text-foreground">{nilAddress || '—'}</span>
        </div>
      </section>

      <section className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-secondary/40 flex items-center justify-center font-bold text-foreground">
              2
            </div>
            <div>
              <div className="font-semibold text-foreground">Fund your wallet</div>
              <div className="text-xs text-muted-foreground">Gas is required for on-chain transactions.</div>
            </div>
          </div>
          {hasBalance && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
        </div>
        {!appConfig.faucetEnabled ? (
          <div className="text-sm text-muted-foreground">
            Faucet is disabled in this build. Fund your wallet externally, then continue.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <button
                type="button"
                onClick={() => void handleRequestFunds()}
                disabled={!isConnected || faucetLoading}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-yellow-500/10 px-4 py-2 text-sm font-semibold text-yellow-700 dark:text-yellow-200 hover:bg-yellow-500/20 transition-colors disabled:opacity-60"
              >
                <Coins className="w-4 h-4" />
                {faucetLoading ? 'Requesting…' : 'Request faucet funds'}
              </button>
              <div className="text-xs text-muted-foreground">
                {faucetTx ? (
                  <span className="font-mono">Faucet tx: {faucetTx.slice(0, 10)}… ({faucetTxStatus})</span>
                ) : (
                  <span>Balance: {balanceLabel}</span>
                )}
              </div>
            </div>
            <FaucetAuthTokenInput />
          </div>
        )}
      </section>

      <section className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-secondary/40 flex items-center justify-center font-bold text-foreground">
              3
            </div>
            <div>
              <div className="font-semibold text-foreground">Allocate a deal</div>
              <div className="text-xs text-muted-foreground">Creates a thin-provisioned container on-chain.</div>
            </div>
          </div>
          {dealId && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
        </div>

        <div className="grid md:grid-cols-3 gap-3 text-sm">
          <label className="block">
            <div className="text-xs text-muted-foreground">Duration</div>
            <select
              value={durationPreset}
              onChange={(e) => {
                const preset = e.target.value
                setDurationPreset(preset)
                const presetSeconds = DURATION_PRESET_BY_SECONDS[preset]
                if (typeof presetSeconds === 'number') {
                  setDuration(String(presetSeconds))
                }
              }}
              className="mt-1 w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm"
            >
              {DURATION_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-xs text-muted-foreground">Duration (seconds)</div>
            <input
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              readOnly={durationPreset !== 'custom'}
              className="mt-1 w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <div className="text-xs text-muted-foreground">Initial escrow</div>
            <input
              value={initialEscrow}
              onChange={(e) => setInitialEscrow(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <div className="text-xs text-muted-foreground">Max monthly spend</div>
            <input
              value={maxMonthlySpend}
              onChange={(e) => setMaxMonthlySpend(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <button
            type="button"
            onClick={() => void handleCreateDeal()}
            disabled={!isConnected || isWrongNetwork || dealLoading}
            className="inline-flex items-center gap-2 rounded-lg bg-primary hover:bg-primary/90 px-4 py-2 text-sm font-bold text-primary-foreground transition-colors disabled:opacity-60"
          >
            <HardDrive className="w-4 h-4" />
            {dealLoading ? 'Creating…' : 'Create deal'}
          </button>
          <div className="text-xs text-muted-foreground">
            {dealId ? (
              <span className="font-mono text-foreground">Deal ID: #{dealId}</span>
            ) : dealTx ? (
              <span className="font-mono">Create tx: {dealTx.slice(0, 10)}…</span>
            ) : (
              <span>Service hint: <span className="font-mono">General</span> (Mode 2 auto)</span>
            )}
          </div>
        </div>
      </section>

      <section className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-secondary/40 flex items-center justify-center font-bold text-foreground">
              4
            </div>
            <div>
              <div className="font-semibold text-foreground">Upload a file</div>
              <div className="text-xs text-muted-foreground">Shards locally and uploads via your selected route.</div>
            </div>
          </div>
          {uploadResult && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <input
            type="file"
            onChange={(e) => void handleFilePicked(e.target.files?.[0] || null)}
            className="text-sm"
          />
          <button
            type="button"
            onClick={() => void handleUseSampleFile()}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-background/60 px-4 py-2 text-sm font-semibold hover:bg-secondary/40 transition-colors"
          >
            <Upload className="w-4 h-4" />
            Use sample file
          </button>
        </div>

        {selectedFile && (
          <div className="text-xs text-muted-foreground">
            Selected: <span className="font-mono text-foreground">{selectedFile.name}</span> ({selectedFile.size} bytes)
            {selectedFileHash && <span className="ml-2 font-mono">sha256 {selectedFileHash.slice(0, 12)}…</span>}
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleUpload()}
          disabled={!selectedFile || !dealId || uploadLoading}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-bold text-white transition-colors disabled:opacity-60"
        >
          <Upload className="w-4 h-4" />
          {uploadLoading ? 'Uploading…' : 'Upload'}
        </button>

        {uploadResult && (
          <div className="rounded-lg border border-border bg-secondary/20 p-4 text-xs space-y-1">
            <div>
              Manifest root: <span className="font-mono text-foreground">{String(uploadResult.cid).slice(0, 18)}…</span>
            </div>
            <div>
              File size: <span className="font-mono text-foreground">{uploadResult.fileSizeBytes}</span> bytes · total_mdus:{' '}
              <span className="font-mono text-foreground">{uploadResult.totalMdus ?? '—'}</span> · witness_mdus:{' '}
              <span className="font-mono text-foreground">{uploadResult.witnessMdus ?? '—'}</span>
              <span className="ml-2">
                <Link to="/technology?section=mdu-primer" className="text-primary hover:underline">
                  Learn MDUs
                </Link>
              </span>
            </div>
          </div>
        )}
      </section>

      <section className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-secondary/40 flex items-center justify-center font-bold text-foreground">
              5
            </div>
            <div>
              <div className="font-semibold text-foreground">Commit content on-chain</div>
              <div className="text-xs text-muted-foreground">Updates the deal to the new manifest root.</div>
            </div>
          </div>
          {commitOk && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
        </div>

        <button
          type="button"
          onClick={() => void handleCommit()}
          disabled={!uploadResult || !dealId || commitLoading}
          className="inline-flex items-center gap-2 rounded-lg bg-primary hover:bg-primary/90 px-4 py-2 text-sm font-bold text-primary-foreground transition-colors disabled:opacity-60"
        >
          <HardDrive className="w-4 h-4" />
          {commitLoading ? 'Committing…' : 'Commit'}
        </button>
        {commitTx && (
          <div className="text-xs text-muted-foreground font-mono">
            Commit tx: {String(commitTx).slice(0, 10)}…
          </div>
        )}
      </section>

      <section className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-secondary/40 flex items-center justify-center font-bold text-foreground">
              6
            </div>
            <div>
              <div className="font-semibold text-foreground">Retrieve</div>
              <div className="text-xs text-muted-foreground">Downloads the file (or first 128&nbsp;KiB) and submits receipts.</div>
            </div>
          </div>
          {downloadOk && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
          {downloadOk === false && <AlertCircle className="w-5 h-5 text-destructive" />}
        </div>

        <button
          type="button"
          onClick={() => void handleRetrieve()}
          disabled={!commitOk || fetchLoading}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-4 py-2 text-sm font-bold text-white transition-colors disabled:opacity-60"
        >
          <Download className="w-4 h-4" />
          {fetchLoading ? 'Fetching…' : 'Fetch now'}
        </button>

        <div className="text-xs text-muted-foreground space-y-1">
          <div>
            Phase: <span className="font-mono text-foreground">{progress.phase}</span> · Chunks: {progress.chunksFetched}/{progress.chunkCount} · Bytes: {progress.bytesFetched}/{progress.bytesTotal}
          </div>
          <div>
            Receipts: {progress.receiptsSubmitted}/{progress.receiptsTotal} · Status: <span className="font-mono">{receiptStatus}</span>
            {receiptError ? <span className="text-destructive"> ({receiptError})</span> : null}
          </div>
          {downloadHash && (
            <div>
              Download sha256: <span className="font-mono text-foreground">{downloadHash.slice(0, 12)}…</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
