import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { useWallet } from "./hooks/useWallet";
import { buildCreateDealTypedData } from "./lib/eip712";
import {
  createDealEvm,
  gatewayStart,
  gatewayStatus,
  type GatewayStatusResponse,
  type GatewayTxResponse,
} from "./lib/gateway";

const navItems = [
  { id: "dashboard", label: "Dashboard" },
  { id: "deals", label: "Deals" },
  { id: "uploads", label: "Uploads" },
  { id: "downloads", label: "Downloads" },
  { id: "logs", label: "Logs" },
];

type CreateDealForm = {
  durationBlocks: string;
  serviceHint: string;
  initialEscrow: string;
  maxMonthlySpend: string;
  nonce: string;
  chainId: string;
  eip712ChainId: string;
};

const defaultCreateForm: CreateDealForm = {
  durationBlocks: "1000",
  serviceHint: "Mode2",
  initialEscrow: "1000stake",
  maxMonthlySpend: "10stake",
  nonce: "0",
  chainId: "test-1",
  eip712ChainId: "31337",
};

export default function App() {
  const wallet = useWallet();
  const shortAddress = wallet.address
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : "Not connected";
  const [gateway, setGateway] = useState<GatewayStatusResponse | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [gatewayStarting, setGatewayStarting] = useState(false);
  const [createForm, setCreateForm] = useState<CreateDealForm>(defaultCreateForm);
  const [createResult, setCreateResult] = useState<GatewayTxResponse | null>(
    null,
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  const gatewayStatusLabel = gateway
    ? `Listening on ${gateway.listening_addr}`
    : "Local sidecar offline";

  const gatewayBadge = gateway ? "Online" : "Disconnected";

  const gatewayBadgeClass = gateway
    ? "bg-emerald-100 text-emerald-600"
    : "bg-rose-100 text-rose-600";

  useEffect(() => {
    if (!gateway) {
      return;
    }
    const interval = setInterval(async () => {
      try {
        const status = await gatewayStatus();
        setGateway(status);
        setGatewayError(null);
      } catch (err) {
        setGatewayError(
          err instanceof Error ? err.message : "Gateway status failed",
        );
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [gateway]);

  const handleStartGateway = async () => {
    setGatewayStarting(true);
    setGatewayError(null);
    try {
      await gatewayStart();
      const status = await gatewayStatus();
      setGateway(status);
    } catch (err) {
      setGatewayError(
        err instanceof Error ? err.message : "Failed to start gateway",
      );
    } finally {
      setGatewayStarting(false);
    }
  };

  const handleCreateDeal = async () => {
    if (!wallet.address) {
      setCreateError("Connect a wallet before creating a deal.");
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    setCreateResult(null);
    try {
      const eip712ChainId = Number(createForm.eip712ChainId);
      const typedData = buildCreateDealTypedData(
        {
          creator: wallet.address,
          duration: BigInt(createForm.durationBlocks),
          service_hint: createForm.serviceHint,
          initial_escrow: createForm.initialEscrow,
          max_monthly_spend: createForm.maxMonthlySpend,
          nonce: BigInt(createForm.nonce),
        },
        eip712ChainId,
      );
      const signature = await wallet.signTypedData(typedData);
      const intent = {
        creator_evm: wallet.address,
        duration_blocks: Number(createForm.durationBlocks),
        service_hint: createForm.serviceHint,
        initial_escrow: createForm.initialEscrow,
        max_monthly_spend: createForm.maxMonthlySpend,
        nonce: Number(createForm.nonce),
        chain_id: createForm.chainId,
      };
      const result = await createDealEvm(intent, signature);
      setCreateResult(result);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Create deal failed",
      );
    } finally {
      setCreateBusy(false);
    }
  };

  const formFieldClass =
    "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700";

  const cards = useMemo(
    () => [
      {
        label: "Chain Sync",
        value: gateway?.deps?.lcd_reachable ? "Synced" : "Unknown",
        hint: gateway?.deps?.lcd_reachable ? "LCD reachable" : "LCD offline",
      },
      {
        label: "Relayer Balance",
        value: "--",
        hint: "Local key not loaded yet",
      },
      {
        label: "Provider Peers",
        value: gateway?.p2p_addrs?.length ?? 0,
        hint: "P2P idle",
      },
    ],
    [gateway],
  );

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
              onClick={
                wallet.status === "connected"
                  ? wallet.disconnect
                  : wallet.connect
              }
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
                {gatewayStatusLabel}
              </h2>
              {gatewayError ? (
                <p className="mt-2 text-xs text-rose-500">{gatewayError}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${gatewayBadgeClass}`}
              >
                {gatewayBadge}
              </span>
              <button
                type="button"
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60"
                onClick={handleStartGateway}
                disabled={gatewayStarting || !!gateway}
              >
                {gatewayStarting ? "Starting..." : "Start gateway"}
              </button>
            </div>
          </header>

          <section className="grid grid-cols-3 gap-6">
            {cards.map((card) => (
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
                    {createResult?.deal_id
                      ? `Deal #${createResult.deal_id}`
                      : "No deal selected"}
                  </h3>
                </div>
                <button
                  type="button"
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                  onClick={handleCreateDeal}
                  disabled={
                    createBusy || wallet.status !== "connected" || !gateway
                  }
                >
                  {createBusy ? "Creating..." : "Create deal"}
                </button>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-4 text-sm text-slate-600">
                <label className="flex flex-col gap-2">
                  Duration (blocks)
                  <input
                    className={formFieldClass}
                    value={createForm.durationBlocks}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        durationBlocks: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="flex flex-col gap-2">
                  Service hint
                  <input
                    className={formFieldClass}
                    value={createForm.serviceHint}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        serviceHint: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="flex flex-col gap-2">
                  Initial escrow
                  <input
                    className={formFieldClass}
                    value={createForm.initialEscrow}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        initialEscrow: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="flex flex-col gap-2">
                  Max monthly spend
                  <input
                    className={formFieldClass}
                    value={createForm.maxMonthlySpend}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        maxMonthlySpend: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="flex flex-col gap-2">
                  Nonce
                  <input
                    className={formFieldClass}
                    value={createForm.nonce}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        nonce: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="flex flex-col gap-2">
                  Chain ID (nilchain)
                  <input
                    className={formFieldClass}
                    value={createForm.chainId}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        chainId: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="flex flex-col gap-2">
                  EIP-712 chain ID
                  <input
                    className={formFieldClass}
                    value={createForm.eip712ChainId}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        eip712ChainId: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="flex flex-col gap-2">
                  Creator (EVM)
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                    {wallet.address ?? "Connect wallet to populate"}
                  </div>
                </div>
              </div>

              {createError ? (
                <p className="mt-4 text-xs text-rose-500">{createError}</p>
              ) : null}
              {createResult?.tx_hash ? (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  Submitted tx: {createResult.tx_hash}
                </div>
              ) : null}
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
