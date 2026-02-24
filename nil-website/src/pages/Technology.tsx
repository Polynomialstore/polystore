import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Check, Copy, Hash, Layers, Shield, Spline } from "lucide-react";
import { ShardingDeepDive } from "./ShardingDeepDive";
import { KZGDeepDive } from "./KZGDeepDive";
import { PerformanceDeepDive } from "./PerformanceDeepDive";
import { DeputySystem } from "./DeputySystem";

const MDU_SIZE_BYTES = 8 * 1024 * 1024;
const BLOB_SIZE_BYTES = 128 * 1024;
const BLOBS_PER_MDU = MDU_SIZE_BYTES / BLOB_SIZE_BYTES; // 64

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const precision = idx === 0 ? 0 : idx >= 3 ? 2 : 1;
  return `${value.toFixed(precision)} ${units[idx]}`;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function computeUserMdus(fileBytes: number): number {
  if (!Number.isFinite(fileBytes) || fileBytes <= 0) return 0;
  return Math.ceil(fileBytes / MDU_SIZE_BYTES);
}

function toHexBytes(value: bigint): string {
  const hex = value.toString(16);
  return "0x" + (hex.length % 2 === 0 ? hex : "0" + hex);
}

export const Technology = () => {
  const location = useLocation();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const section = useMemo(() => {
    const params = new URLSearchParams(location.search || "");
    return String(params.get("section") || "").trim();
  }, [location.search]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!section) return;
    const el = document.getElementById(section);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [section]);

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1200);
    } catch {
      // ignore
    }
  };

  const [exampleBytes, setExampleBytes] = useState<number>(128 * 1024 * 1024);
  const exampleUserMdus = computeUserMdus(exampleBytes);
  const exampleBlobCount = exampleUserMdus * BLOBS_PER_MDU;

  return (
    <div className="pt-24 pb-12 px-4 max-w-5xl mx-auto space-y-12">
      <header className="space-y-4">
        <h1 className="text-5xl font-bold text-foreground">How NilStore Works</h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          NilStore is not just &ldquo;Dropbox on blockchain&rdquo;. It is an MDU-centric storage network where every byte
          is bound to an on-chain deal by a verifiable commitment chain.
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Clients can run fully in-browser (WASM + OPFS) using MetaMask for signing. A local user-gateway is optional
          routing + caching infrastructure, but it never signs transactions on your behalf.
        </p>
      </header>

      <section
        id="mdu-primer"
        className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden"
        data-testid="technology-mdu-primer"
      >
        <div className="border-b border-border bg-muted/30 px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary/10 border border-primary/20">
              <Layers className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Developer Primer</div>
              <h2 className="text-2xl font-bold text-foreground">MDUs, Blobs, and the Slab</h2>
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Jump to:{" "}
            <Link className="text-primary hover:underline" to="/technology?section=artifact-map">
              Artifact map
            </Link>
            {" · "}
            <Link className="text-primary hover:underline" to="/technology?section=worked-example">
              Worked example
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Blob</div>
                  <div className="mt-1 text-lg font-mono text-foreground">{formatBytes(BLOB_SIZE_BYTES)}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Atomic KZG unit. Receipts and range planning are blob-aligned.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopy("blob_size", String(BLOB_SIZE_BYTES))}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-secondary/40"
                  title="Copy blob size bytes"
                >
                  {copiedKey === "blob_size" ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  {BLOB_SIZE_BYTES}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">MDU</div>
                  <div className="mt-1 text-lg font-mono text-foreground">{formatBytes(MDU_SIZE_BYTES)}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Service/slab unit. Exactly <span className="font-mono text-foreground">{BLOBS_PER_MDU}</span> blobs per MDU.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopy("mdu_size", String(MDU_SIZE_BYTES))}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-secondary/40"
                  title="Copy MDU size bytes"
                >
                  {copiedKey === "mdu_size" ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  {MDU_SIZE_BYTES}
                </button>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Manifest Root</div>
              <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Hash className="h-4 w-4 text-emerald-500" />
                <span className="font-semibold">48-byte KZG commitment</span>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Commits to the ordered vector of per-MDU roots (slab order).
              </div>
            </div>

            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">MDU Root</div>
              <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Spline className="h-4 w-4 text-indigo-500" />
                <span className="font-semibold">Merkle root</span>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Merkle root over the blob commitments for that MDU (typically 64 leaves).
              </div>
            </div>

            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Blob Commitment</div>
              <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Shield className="h-4 w-4 text-purple-500" />
                <span className="font-semibold">48-byte KZG commitment</span>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Commits to a 128 KiB blob. Included in the MDU Merkle tree.
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-secondary/20 p-4 text-sm text-muted-foreground">
            <div className="font-semibold text-foreground">Slab order (what “MDU index” means)</div>
            <div className="mt-1">
              A deal’s slab is ordered as: <span className="font-mono text-foreground">MDU #0</span> (NilFS Super-Manifest)
              + <span className="font-mono text-foreground">W</span> Witness MDUs + user data MDUs. So{" "}
              <span className="font-mono text-foreground">total_mdus = 1 + witness_mdus + user_mdus</span>.
            </div>
          </div>
        </div>
      </section>

      <section id="artifact-map" className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-2xl font-bold text-foreground">Artifact Map (UI ↔ Protocol)</h2>
          <Link className="text-sm text-primary hover:underline" to="/technology?section=mdu-primer">
            Back to MDU Primer
          </Link>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/30">
              <tr>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Artifact</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Meaning</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Where you see it</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <td className="px-4 py-3 font-mono text-[12px] text-foreground">manifest_root</td>
                <td className="px-4 py-3 text-muted-foreground">Single commitment to all slab MDUs (pins content).</td>
                <td className="px-4 py-3 text-muted-foreground">
                  Deal Explorer → Manifest &amp; MDUs, FileSharder, Dashboard storage layout.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-[12px] text-foreground">witness_mdus</td>
                <td className="px-4 py-3 text-muted-foreground">Metadata MDUs caching blob commitments (prover acceleration).</td>
                <td className="px-4 py-3 text-muted-foreground">Deal Explorer slab layout; Dashboard storage layout; gateway GUI slab panel.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-[12px] text-foreground">mdu_index</td>
                <td className="px-4 py-3 text-muted-foreground">Index into slab order (MDU #0, witness region, then user MDUs).</td>
                <td className="px-4 py-3 text-muted-foreground">Deal Explorer “Load Commitments” selector; planned GUI MDU explorer.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-[12px] text-foreground">blob_index</td>
                <td className="px-4 py-3 text-muted-foreground">Blob position within an MDU (0..63 for Mode 1; Mode 2 uses leaf_index semantics).</td>
                <td className="px-4 py-3 text-muted-foreground">Retrieval session plans and receipts (advanced debugging).</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section id="worked-example" className="space-y-4">
        <h2 className="text-2xl font-bold text-foreground">Worked Example (MDU/Blob math)</h2>
        <div className="grid lg:grid-cols-[1.2fr_0.8fr] gap-4">
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <div className="text-sm text-muted-foreground">
              MDUs and blobs are the units that show up in upload progress, slab layout, and retrieval session planning.
            </div>
            <label className="block">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">File size (bytes)</div>
              <input
                value={String(exampleBytes)}
                onChange={(e) => setExampleBytes(clampInt(Number(e.target.value), 0, 10_000_000_000))}
                className="mt-1 w-full rounded-md border border-border bg-background/60 px-3 py-2 text-sm font-mono text-foreground"
              />
            </label>
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="rounded-lg border border-border bg-background/60 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">User MDUs</div>
                <div className="font-mono text-lg text-foreground">{exampleUserMdus}</div>
                <div className="text-[11px] text-muted-foreground mt-1">{formatBytes(exampleUserMdus * MDU_SIZE_BYTES)}</div>
              </div>
              <div className="rounded-lg border border-border bg-background/60 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Blobs</div>
                <div className="font-mono text-lg text-foreground">{exampleBlobCount}</div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  {exampleUserMdus} × {BLOBS_PER_MDU}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-background/60 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Global blob indices</div>
                <div className="font-mono text-[12px] text-foreground">
                  {exampleUserMdus > 0 ? `${toHexBytes(BigInt(exampleUserMdus) * BigInt(BLOBS_PER_MDU))}…` : "—"}
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  Protocol often uses global_blob = mdu_index * {BLOBS_PER_MDU} + blob_index
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-secondary/20 p-6 space-y-3">
            <div className="text-sm font-semibold text-foreground">How this shows up in UX</div>
            <ul className="text-[12px] text-muted-foreground space-y-2 list-disc list-inside">
              <li>
                FileSharder progress counts blobs and MDUs (and splits meta/witness/user).
              </li>
              <li>
                Deal Explorer can load commitments for a specific MDU index to inspect blob commitments.
              </li>
              <li>
                Retrieval sessions lock budgets for a blob range; a full-file download may submit many receipts.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="space-y-10">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-2xl font-bold text-foreground">Deep Dives</h2>
          <Link className="text-sm text-primary hover:underline" to="/technology?section=mdu-primer">
            Learn MDUs
          </Link>
        </div>

        <div className="space-y-20">
          <div className="flex gap-6 group">
            <div className="flex flex-col items-center">
              <div className="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-500 font-bold shrink-0">
                1
              </div>
              <div className="w-0.5 flex-grow bg-border my-2"></div>
            </div>
            <div className="w-full pb-6">
              <ShardingDeepDive />
            </div>
          </div>

          <div className="flex gap-6 group">
            <div className="flex flex-col items-center">
              <div className="w-12 h-12 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center text-green-500 font-bold shrink-0">
                2
              </div>
              <div className="w-0.5 flex-grow bg-border my-2"></div>
            </div>
            <div className="w-full pb-6">
              <KZGDeepDive />
            </div>
          </div>

          <div className="flex gap-6 group">
            <div className="flex flex-col items-center">
              <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-500 font-bold shrink-0">
                3
              </div>
              <div className="w-0.5 flex-grow bg-border my-2"></div>
            </div>
            <div className="w-full pb-6">
              <PerformanceDeepDive />
            </div>
          </div>

          <div className="flex gap-6 group">
            <div className="flex flex-col items-center">
              <div className="w-12 h-12 rounded-full bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-500 font-bold shrink-0">
                4
              </div>
            </div>
            <div className="w-full pb-6">
              <DeputySystem />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
