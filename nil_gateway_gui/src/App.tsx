import "./App.css";
import { useWallet } from "./hooks/useWallet";

const navItems = [
  { id: "dashboard", label: "Dashboard" },
  { id: "deals", label: "Deals" },
  { id: "uploads", label: "Uploads" },
  { id: "downloads", label: "Downloads" },
  { id: "logs", label: "Logs" },
];

export default function App() {
  const wallet = useWallet();
  const shortAddress = wallet.address
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : "Not connected";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-sky-100">
      <div className="mx-auto grid min-h-screen max-w-[1400px] grid-cols-[260px_1fr] gap-6 p-6">
        <aside className="surface-card flex flex-col gap-6 p-6">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
              NilStore
            </p>
            <h1 className="text-2xl font-semibold text-slate-900">
              NilGateway GUI
            </h1>
            <p className="text-sm text-slate-500">
              Monolithic sidecar control panel
            </p>
          </div>

          <nav className="flex flex-col gap-2">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex items-center justify-between rounded-xl border border-transparent px-3 py-2 text-left text-sm font-medium text-slate-700 transition hover:border-slate-200 hover:bg-white"
              >
                <span>{item.label}</span>
                <span className="text-xs text-slate-400">⌘</span>
              </button>
            ))}
          </nav>

          <div className="mt-auto rounded-2xl border border-slate-200 bg-slate-900/95 p-4 text-white">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
              Wallet
            </p>
            <p className="mt-1 text-sm font-medium">{shortAddress}</p>
            {wallet.error ? (
              <p className="mt-2 text-xs text-rose-200">{wallet.error}</p>
            ) : null}
            <button
              type="button"
              className="mt-3 w-full rounded-lg bg-cyan-400/20 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-cyan-100 transition hover:bg-cyan-400/40 disabled:opacity-60"
              onClick={wallet.status === "connected" ? wallet.disconnect : wallet.connect}
              disabled={wallet.status === "connecting"}
            >
              {wallet.status === "connected" ? "Disconnect" : "Connect"}
            </button>
          </div>
        </aside>

        <main className="flex flex-col gap-6">
          <header className="surface-card flex items-center justify-between px-6 py-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                Gateway status
              </p>
              <h2 className="text-xl font-semibold text-slate-900">
                Local sidecar offline
              </h2>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-600">
                Disconnected
              </span>
              <button
                type="button"
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
              >
                Start gateway
              </button>
            </div>
          </header>

          <section className="grid grid-cols-3 gap-6">
            {[
              { label: "Chain Sync", value: "0 blocks", hint: "LCD offline" },
              { label: "Relayer Balance", value: "--", hint: "No key yet" },
              { label: "Provider Peers", value: "0", hint: "P2P idle" },
            ].map((card) => (
              <div key={card.label} className="surface-card p-5">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                  {card.label}
                </p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">
                  {card.value}
                </p>
                <p className="mt-1 text-sm text-slate-500">{card.hint}</p>
              </div>
            ))}
          </section>

          <section className="grid grid-cols-[1.2fr_0.8fr] gap-6">
            <div className="surface-card p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                    Active deal
                  </p>
                  <h3 className="text-lg font-semibold text-slate-900">
                    No deal selected
                  </h3>
                </div>
                <button
                  type="button"
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Create deal
                </button>
              </div>

              <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                <p className="font-semibold text-slate-700">
                  Upload a file to begin
                </p>
                <p>
                  Choose a deal, set a NilFS path, and push content to the
                  local sidecar.
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                  >
                    Select file
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
                  >
                    Commit content
                  </button>
                </div>
              </div>
            </div>

            <div className="surface-card p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                Recent activity
              </p>
              <div className="mt-4 space-y-4 text-sm text-slate-600">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="font-semibold text-slate-800">
                    Gateway logs will appear here
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Start the sidecar to stream output.
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="font-semibold text-slate-800">
                    Deal updates and receipts
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Track uploads, commits, and download proofs.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
