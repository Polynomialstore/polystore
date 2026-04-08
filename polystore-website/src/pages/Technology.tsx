import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowRight, Check, Copy, HardDrive, Hash, Layers, Shield, Spline } from "lucide-react";
import { ShardingDeepDive } from "./ShardingDeepDive";
import { KZGDeepDive } from "./KZGDeepDive";
import { PerformanceDeepDive } from "./PerformanceDeepDive";
import { DeputySystem } from "./DeputySystem";

const MDU_SIZE_BYTES = 8 * 1024 * 1024;
const BLOB_SIZE_BYTES = 128 * 1024;
const BLOBS_PER_MDU = MDU_SIZE_BYTES / BLOB_SIZE_BYTES; // 64
const KZG_COMMITMENT_BYTES = 48;

// NilFS (filesystem-on-slab) layout constants for MDU #0 (Super-Manifest).
const NILFS_ROOT_TABLE_BLOBS = 16; // blobs 0..15
const NILFS_FILE_TABLE_BLOBS = 48; // blobs 16..63
const NILFS_ROOT_SIZE_BYTES = 32;
const NILFS_FILE_TABLE_HEADER_BYTES = 128;
const NILFS_FILE_RECORD_BYTES = 256;

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

function formatIntRange(start: number, end: number): string {
  if (start === end) return `#${start}`;
  return `#${start}..#${end}`;
}

function formatBigintRange(start: bigint, end: bigint): string {
  if (start === end) return start.toString();
  return `${start.toString()}..${end.toString()}`;
}

function computeNilfsRanges(args: {
  witnessMdus: number;
  startOffsetBytes: number;
  sizeBytes: number;
}): null | {
  metaMdus: number;
  userMduStart: number;
  userMduEnd: number;
  slabMduStart: number;
  slabMduEnd: number;
  globalBlobStart: bigint;
  globalBlobEnd: bigint;
} {
  const witnessMdus = Math.max(0, Math.floor(args.witnessMdus));
  const startOffset = Math.max(0, Math.floor(args.startOffsetBytes));
  const sizeBytes = Math.max(0, Math.floor(args.sizeBytes));
  if (sizeBytes <= 0) return null;

  const metaMdus = 1 + witnessMdus;
  const endOffset = startOffset + sizeBytes - 1;
  const userMduStart = Math.floor(startOffset / MDU_SIZE_BYTES);
  const userMduEnd = Math.floor(endOffset / MDU_SIZE_BYTES);
  const slabMduStart = metaMdus + userMduStart;
  const slabMduEnd = metaMdus + userMduEnd;

  const startBlobInMdu = Math.floor((startOffset % MDU_SIZE_BYTES) / BLOB_SIZE_BYTES);
  const endBlobInMdu = Math.floor((endOffset % MDU_SIZE_BYTES) / BLOB_SIZE_BYTES);
  const globalBlobStart = BigInt(slabMduStart) * BigInt(BLOBS_PER_MDU) + BigInt(startBlobInMdu);
  const globalBlobEnd = BigInt(slabMduEnd) * BigInt(BLOBS_PER_MDU) + BigInt(endBlobInMdu);

  return {
    metaMdus,
    userMduStart,
    userMduEnd,
    slabMduStart,
    slabMduEnd,
    globalBlobStart,
    globalBlobEnd,
  };
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

  const [nilfsWitnessMdus, setNilfsWitnessMdus] = useState<number>(2);
  const nilfsMetaMdus = 1 + nilfsWitnessMdus;
  const nilfsMaxUserMdus = 4096;
  const nilfsCommitmentsPerUserMdu = BLOBS_PER_MDU;
  const nilfsCommitmentsBytesPerUserMdu = nilfsCommitmentsPerUserMdu * KZG_COMMITMENT_BYTES;
  const nilfsTotalCommitmentBytes = nilfsMaxUserMdus * nilfsCommitmentsBytesPerUserMdu;
  const nilfsSuggestedWitnessMdus = Math.ceil(nilfsTotalCommitmentBytes / MDU_SIZE_BYTES);

  const nilfsExampleFiles = useMemo(() => {
    const files = [
      { path: "docs/readme.md", startOffset: 0, sizeBytes: 24 * 1024 },
      { path: "img/logo.png", startOffset: 24 * 1024, sizeBytes: 640 * 1024 },
      { path: "datasets/telemetry.bin", startOffset: 8 * 1024 * 1024, sizeBytes: 19 * 1024 * 1024 + 700 * 1024 },
      { path: "video/clip.mp4", startOffset: 40 * 1024 * 1024 + 128 * 1024, sizeBytes: 27 * 1024 * 1024 + 300 * 1024 },
      { path: "db/index.sqlite", startOffset: 72 * 1024 * 1024, sizeBytes: 11 * 1024 * 1024 },
    ];
    return files.map((f) => ({
      ...f,
      ranges: computeNilfsRanges({
        witnessMdus: nilfsWitnessMdus,
        startOffsetBytes: f.startOffset,
        sizeBytes: f.sizeBytes,
      }),
    }));
  }, [nilfsWitnessMdus]);

  return (
    <div className="pt-24 pb-12 px-4 max-w-5xl mx-auto space-y-12">
      <header className="space-y-4">
        <h1 className="text-5xl font-bold text-foreground">How PolyStore Works</h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          PolyStore is not just &ldquo;Dropbox on blockchain&rdquo;. It is an MDU-centric storage network where every byte
          is bound to an on-chain deal by a verifiable commitment chain.
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Clients can run fully in-browser (WASM + OPFS) using MetaMask for signing. A local user-gateway is optional
          routing + caching infrastructure, but it never signs transactions on your behalf.
        </p>
      </header>

      <section
        id="nilfs-primer"
        className="rounded-none border border-border bg-card shadow-sm overflow-hidden"
        data-testid="technology-nilfs-primer"
      >
        <div className="border-b border-border bg-muted/30 px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-none bg-primary/10 border border-primary/20">
              <HardDrive className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Filesystem on Slab</div>
              <h2 className="text-2xl font-bold text-foreground">NilFS: files built on MDUs</h2>
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Jump to:{" "}
            <Link className="text-primary hover:underline" to="/technology?section=nilfs-layout">
              Indexing layout
            </Link>
            {" · "}
            <Link className="text-primary hover:underline" to="/technology?section=nilfs-example">
              Worked filesystem
            </Link>
            {" · "}
            <Link className="text-primary hover:underline" to="/technology?section=nilfs-proof-path">
              Proof path
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-none border border-border bg-background/60 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Mental model</div>
              <div className="mt-2 text-sm text-muted-foreground">
                A deal’s <span className="font-semibold text-foreground">slab</span> is an ordered list of MDUs. NilFS turns that slab into a
                filesystem by storing:
              </div>
              <ul className="mt-3 list-disc list-inside space-y-1 text-[12px] text-muted-foreground">
                <li>
                  a <span className="font-semibold text-foreground">file table</span>: path → start_offset + length + flags
                </li>
                <li>
                  a <span className="font-semibold text-foreground">root table</span>: slab MDU index → 32-byte root
                </li>
              </ul>
              <div className="mt-3 rounded-none border border-border bg-secondary/20 p-3 text-[12px] text-muted-foreground">
                Key mapping: <span className="font-mono text-foreground">path → offset → (mdu, blob)</span>.
              </div>
            </div>

            <div className="rounded-none border border-border bg-background/60 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Slab order</div>
              <div className="mt-2 text-sm text-muted-foreground">
                Slab MDUs are ordered as:
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="border border-border bg-background px-3 py-1 font-mono-data text-foreground">MDU #0</span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <span className="border border-border bg-background px-3 py-1 font-mono-data text-foreground">
                    witness MDUs (#1..#{nilfsWitnessMdus})
                  </span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <span className="border border-border bg-background px-3 py-1 font-mono-data text-foreground">
                    user data MDUs (start at #{nilfsMetaMdus})
                  </span>
                </div>
              </div>
              <div className="mt-3 rounded-none border border-border bg-secondary/20 p-3 text-[12px] text-muted-foreground">
                MDU #0 is the <span className="font-semibold text-foreground">Super-Manifest</span>: it stores the file table plus the root table.
              </div>
            </div>
          </div>

          <div id="nilfs-layout" className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-foreground">Indexing layout (MDU #0)</h3>
              <Link className="text-sm text-primary hover:underline" to="/technology?section=mdu-primer">
                Back to MDUs
              </Link>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-none border border-border bg-background/60 p-4">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Root table</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  Blob 0..15 store the <span className="font-semibold text-foreground">root table</span>: 32-byte roots for every slab MDU (witness + user data).
                </div>
                <div className="mt-3 grid gap-2 text-[12px] text-muted-foreground">
                  <div className="flex items-center justify-between">
                    <span>Root table blobs</span>
                    <span className="font-mono text-foreground">{NILFS_ROOT_TABLE_BLOBS}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Root size</span>
                    <span className="font-mono text-foreground">{NILFS_ROOT_SIZE_BYTES}B</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Capacity (roots)</span>
                    <span className="font-mono text-foreground">
                      {(NILFS_ROOT_TABLE_BLOBS * BLOB_SIZE_BYTES) / NILFS_ROOT_SIZE_BYTES}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-none border border-border bg-background/60 p-4">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">File table</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  Blob 16..63 store the file table header + fixed records. Each record is 256 bytes with packed flags.
                </div>
                <div className="mt-3 grid gap-2 text-[12px] text-muted-foreground">
                  <div className="flex items-center justify-between">
                    <span>Header</span>
                    <span className="font-mono text-foreground">{NILFS_FILE_TABLE_HEADER_BYTES}B</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Record size</span>
                    <span className="font-mono text-foreground">{NILFS_FILE_RECORD_BYTES}B</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Record capacity</span>
                    <span className="font-mono text-foreground">
                      {Math.floor((NILFS_FILE_TABLE_BLOBS * BLOB_SIZE_BYTES - NILFS_FILE_TABLE_HEADER_BYTES) / NILFS_FILE_RECORD_BYTES)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div id="nilfs-example" className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-foreground">Worked filesystem (moderate dataset)</h3>
              <div className="text-[12px] text-muted-foreground">
                Capacity hint: <span className="font-mono text-foreground">max_user_mdus = {nilfsMaxUserMdus}</span>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-none border border-border bg-background/60 p-4">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Witness MDUs</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  Each user MDU needs {BLOBS_PER_MDU} KZG blob commitments.
                </div>
                <div className="mt-3 text-[12px] text-muted-foreground">
                  {BLOBS_PER_MDU} × {KZG_COMMITMENT_BYTES}B = {nilfsCommitmentsBytesPerUserMdu}B per user MDU
                </div>
                <div className="mt-2 text-[12px] text-muted-foreground">
                  {nilfsMaxUserMdus} × {nilfsCommitmentsBytesPerUserMdu}B = {formatBytes(nilfsTotalCommitmentBytes)}
                </div>
                <div className="mt-2 font-mono text-foreground">W = {nilfsSuggestedWitnessMdus}</div>
              </div>

              <div className="rounded-none border border-border bg-background/60 p-4">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Live toggle</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  Adjust witness MDUs to see how slab indexing shifts for the sample files below.
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    onClick={() => void handleCopy("nilfs_meta_mdus", String(nilfsMetaMdus))}
                    className="inline-flex items-center gap-2 rounded-none border border-border bg-background/70 px-3 py-2 text-[12px] font-semibold text-foreground hover:bg-muted/40"
                  >
                    {copiedKey === "nilfs_meta_mdus" ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-accent" />
                        Copied meta_mdus
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        Copy meta_mdus
                      </>
                    )}
                  </button>
                  <div className="text-[11px] text-muted-foreground">
                    meta_mdus = 1 + W = <span className="font-mono text-foreground">{nilfsMetaMdus}</span>
                  </div>
                </div>
                <div className="mt-3">
                  <label className="block text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Witness MDUs (W)
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={Math.max(1, nilfsSuggestedWitnessMdus * 2)}
                    value={nilfsWitnessMdus}
                    onChange={(e) => setNilfsWitnessMdus(clampInt(Number(e.target.value), 1, nilfsSuggestedWitnessMdus * 2))}
                    className="mt-2 w-full"
                  />
                  <div className="mt-1 text-[12px] text-muted-foreground">
                    W={nilfsWitnessMdus} → meta_mdus = {nilfsMetaMdus}. User data slab MDUs begin at index{" "}
                    <span className="font-mono text-foreground">#{nilfsMetaMdus}</span>.
                  </div>
                </div>
              </div>

              <div className="rounded-none border border-border bg-secondary/20 p-4 text-[12px] text-muted-foreground">
                <div className="font-semibold text-foreground">Indexing summary</div>
                <ul className="mt-2 space-y-1 list-disc list-inside">
                  <li>MDU #0 holds the NilFS super-manifest.</li>
                  <li>Witness MDUs cache blob commitments.</li>
                  <li>User data MDUs store file bytes.</li>
                  <li>global_blob = slab_mdu * 64 + blob_index.</li>
                </ul>
              </div>
            </div>

            <div className="rounded-none border border-border bg-card p-4 space-y-3">
              <div className="text-sm font-semibold text-foreground">Example file table → derived MDU / blob ranges</div>
              <div className="overflow-auto">
                <table className="min-w-full divide-y divide-border text-sm">
                  <thead className="bg-muted/20">
                    <tr>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Path</th>
                      <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        start_offset
                      </th>
                      <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">size</th>
                      <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">user MDUs</th>
                      <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">slab MDUs</th>
                      <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">global blobs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {nilfsExampleFiles.map((f) => {
                      const r = f.ranges;
                      return (
                        <tr key={f.path} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-3 text-foreground font-semibold whitespace-nowrap">{f.path}</td>
                          <td className="px-4 py-3 text-right font-mono text-[11px] text-muted-foreground">
                            {f.startOffset.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right text-muted-foreground">{formatBytes(f.sizeBytes)}</td>
                          <td className="px-4 py-3 text-right font-mono text-[11px] text-muted-foreground">
                            {r ? formatIntRange(r.userMduStart, r.userMduEnd) : "—"}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[11px] text-muted-foreground">
                            {r ? formatIntRange(r.slabMduStart, r.slabMduEnd) : "—"}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[11px] text-muted-foreground">
                            {r ? formatBigintRange(r.globalBlobStart, r.globalBlobEnd) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-none border border-border bg-secondary/20 p-4 text-[12px] text-muted-foreground">
              <div className="font-semibold text-foreground">Mapping formulas</div>
              <div className="mt-2 font-mono text-[11px] text-foreground whitespace-pre-wrap">
                {`meta_mdus = 1 + witness_mdus
user_mdu = floor(start_offset / 8MiB)
slab_mdu = meta_mdus + user_mdu
blob_in_mdu = floor((start_offset % 8MiB) / 128KiB)
global_blob = slab_mdu * 64 + blob_in_mdu`}
              </div>
            </div>
          </div>

          <div id="nilfs-proof-path" className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-foreground">Proof path (how bytes bind to the deal)</h3>
              <Link className="text-sm text-primary hover:underline" to="/technology?section=mdu-primer">
                Artifact definitions
              </Link>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-none border border-border bg-background/60 p-4">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Step 1: resolve the file</div>
                <ol className="mt-2 space-y-2 text-[12px] text-muted-foreground list-decimal list-inside">
                  <li>Read NilFS file table in slab MDU #0.</li>
                  <li>
                    Find <span className="font-mono text-foreground">start_offset</span> +{" "}
                    <span className="font-mono text-foreground">length</span>.
                  </li>
                  <li>Convert the byte range into slab MDUs and global blob indices (above).</li>
                </ol>
              </div>

              <div className="rounded-none border border-border bg-background/60 p-4">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Step 2: verify inclusion</div>
                <ol className="mt-2 space-y-2 text-[12px] text-muted-foreground list-decimal list-inside">
                  <li>
                    <span className="font-semibold text-foreground">manifest_root</span> (KZG, 48B) commits to the ordered vector of per‑MDU roots.
                  </li>
                  <li>
                    Each <span className="font-semibold text-foreground">MDU root</span> (32B) commits to the 64 blob commitments for that MDU.
                  </li>
                  <li>
                    Each <span className="font-semibold text-foreground">blob commitment</span> (KZG, 48B) commits to the blob bytes.
                  </li>
                </ol>
              </div>
            </div>

            <div className="rounded-none border border-border bg-card overflow-hidden">
              <div className="border-b border-border bg-muted/30 px-6 py-4">
                <div className="text-sm font-semibold text-foreground">Chained proof sketch (3 hops)</div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  Deal commitment <span className="font-mono">→</span> MDU <span className="font-mono">→</span> Blob{" "}
                  <span className="font-mono">→</span> Bytes.
                </div>
              </div>
              <div className="p-6">
                <div className="grid gap-3">
                  {[
                    {
                      label: "Hop 1 (KZG)",
                      detail: "Prove slab MDU root at mdu_index is included in the manifest commitment.",
                    },
                    {
                      label: "Hop 2 (Merkle)",
                      detail: "Prove blob commitment at blob_index is included in that MDU root.",
                    },
                    {
                      label: "Hop 3 (KZG)",
                      detail: "Prove the bytes you fetched are consistent with the blob commitment.",
                    },
                  ].map((row) => (
                    <div key={row.label} className="flex items-start gap-3 rounded-none border border-border bg-background/60 p-3">
                      <div className="rounded-none border border-border bg-secondary/30 px-2 py-1 text-[11px] font-semibold text-foreground">
                        {row.label}
                      </div>
                      <div className="text-[12px] text-muted-foreground">{row.detail}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 text-[12px] text-muted-foreground">
                  NilFS makes the <span className="font-mono text-foreground">path → offset</span> mapping explicit; the chained proof makes the{" "}
                  <span className="font-mono text-foreground">bytes → deal</span> binding verifiable.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-none border border-border bg-gradient-to-br from-background via-background to-primary/5 shadow-sm">
        <div className="p-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">At a glance</div>
            <h2 className="text-2xl font-bold text-foreground">The 4-hop chain that makes bytes verifiable</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              If you only read one thing on this page, make it this: PolyStore binds bytes to a deal through a clean,
              auditable chain of commitments.
            </p>
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                { label: "Deal", detail: "manifest_root" },
                { label: "MDU", detail: "mdu_index" },
                { label: "Blob", detail: "blob_index" },
                { label: "Bytes", detail: "range" },
              ].map((node, idx) => (
                <div key={node.label} className="rounded-none border border-border bg-background/70 p-3 text-center">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{node.label}</div>
                  <div className="mt-1 font-mono text-[12px] text-foreground">{node.detail}</div>
                  {idx < 3 ? <ArrowRight className="mx-auto mt-2 h-4 w-4 text-muted-foreground" /> : null}
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { label: "MDU", value: formatBytes(MDU_SIZE_BYTES) },
                { label: "Blob", value: formatBytes(BLOB_SIZE_BYTES) },
                { label: "KZG", value: `${KZG_COMMITMENT_BYTES} B` },
              ].map((stat) => (
                <div key={stat.label} className="rounded-none border border-border bg-background/60 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{stat.label}</div>
                  <div className="mt-1 font-mono text-lg text-foreground">{stat.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-none border border-border bg-background/80 p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Quick path</div>
              <ol className="mt-2 space-y-2 text-sm text-muted-foreground list-decimal list-inside">
                <li>
                  Start with{" "}
                  <Link className="text-primary hover:underline" to="/technology?section=nilfs-primer">
                    NilFS
                  </Link>{" "}
                  (filesystem view).
                </li>
                <li>
                  Skim the{" "}
                  <Link className="text-primary hover:underline" to="/technology?section=mdu-primer">
                    MDU Primer
                  </Link>{" "}
                  (units + slab order).
                </li>
                <li>
                  Finish at{" "}
                  <Link className="text-primary hover:underline" to="/technology?section=nilfs-proof-path">
                    Proof Path
                  </Link>{" "}
                  (why the bytes are verifiable).
                </li>
              </ol>
            </div>

            <div className="rounded-none border border-border bg-secondary/20 p-4">
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Curious developers</div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                This page is designed for skimming first and deep dives second. Every section includes formulas,
                concrete sizes, and a worked example so you can compute indices by hand if you want to.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="mdu-primer"
        className="rounded-none border border-border bg-card shadow-sm overflow-hidden"
        data-testid="technology-mdu-primer"
      >
        <div className="border-b border-border bg-muted/30 px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-none bg-primary/10 border border-primary/20">
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
            <Link className="text-primary hover:underline" to="/technology?section=nilfs-primer">
              NilFS primer
            </Link>
            {" · "}
            <Link className="text-primary hover:underline" to="/technology?section=worked-example">
              Worked example
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded-none border border-border bg-background/60 p-4">
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
                  className="inline-flex items-center gap-2 rounded-none border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-secondary/40"
                  title="Copy blob size bytes"
                >
                  {copiedKey === "blob_size" ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
                  {BLOB_SIZE_BYTES}
                </button>
              </div>
            </div>

            <div className="rounded-none border border-border bg-background/60 p-4">
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
                  className="inline-flex items-center gap-2 rounded-none border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-secondary/40"
                  title="Copy MDU size bytes"
                >
                  {copiedKey === "mdu_size" ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
                  {MDU_SIZE_BYTES}
                </button>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="rounded-none border border-border bg-background/60 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Manifest Root</div>
              <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Hash className="h-4 w-4 text-accent" />
                <span className="font-semibold">48-byte KZG commitment</span>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Commits to the ordered vector of per-MDU roots (slab order).
              </div>
            </div>

            <div className="rounded-none border border-border bg-background/60 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">MDU Root</div>
              <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Spline className="h-4 w-4 text-primary" />
                <span className="font-semibold">Merkle root</span>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Merkle root over the blob commitments for that MDU (typically 64 leaves).
              </div>
            </div>

            <div className="rounded-none border border-border bg-background/60 p-4">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Blob Commitment</div>
              <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <Shield className="h-4 w-4 text-primary" />
                <span className="font-semibold">48-byte KZG commitment</span>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Commits to a 128 KiB blob. Included in the MDU Merkle tree.
              </div>
            </div>
          </div>

          <div className="rounded-none border border-border bg-secondary/20 p-4 text-sm text-muted-foreground">
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
        <div className="overflow-hidden rounded-none border border-border bg-card">
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
          <div className="rounded-none border border-border bg-card p-6 space-y-4">
            <div className="text-sm text-muted-foreground">
              MDUs and blobs are the units that show up in upload progress, slab layout, and retrieval session planning.
            </div>
            <label className="block">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">File size (bytes)</div>
              <input
                value={String(exampleBytes)}
                onChange={(e) => setExampleBytes(clampInt(Number(e.target.value), 0, 10_000_000_000))}
                className="mt-1 w-full rounded-none border border-border bg-background/60 px-3 py-2 text-sm font-mono text-foreground"
              />
            </label>
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="rounded-none border border-border bg-background/60 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">User MDUs</div>
                <div className="font-mono text-lg text-foreground">{exampleUserMdus}</div>
                <div className="text-[11px] text-muted-foreground mt-1">{formatBytes(exampleUserMdus * MDU_SIZE_BYTES)}</div>
              </div>
              <div className="rounded-none border border-border bg-background/60 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Blobs</div>
                <div className="font-mono text-lg text-foreground">{exampleBlobCount}</div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  {exampleUserMdus} × {BLOBS_PER_MDU}
                </div>
              </div>
              <div className="rounded-none border border-border bg-background/60 px-3 py-2">
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

          <div className="rounded-none border border-border bg-secondary/20 p-6 space-y-3">
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
                <div className="w-12 h-12 bg-primary/10 border border-primary/30 flex items-center justify-center text-primary font-bold shrink-0">
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
                <div className="w-12 h-12 bg-accent/10 border border-accent/30 flex items-center justify-center text-accent font-bold shrink-0">
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
                <div className="w-12 h-12 bg-destructive/10 border border-destructive/30 flex items-center justify-center text-destructive font-bold shrink-0">
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
                <div className="w-12 h-12 bg-primary/10 border border-primary/30 flex items-center justify-center text-primary font-bold shrink-0">
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
