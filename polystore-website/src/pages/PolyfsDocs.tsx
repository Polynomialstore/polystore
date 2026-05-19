import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Anchor,
  ArrowRight,
  Box,
  Braces,
  CheckCircle2,
  Database,
  FileCode,
  FileText,
  Grid3X3,
  HardDrive,
  Layers,
  ShieldCheck,
} from "lucide-react";
import {
  BLOBS_PER_MDU,
  BLOB_SIZE_BYTES,
  KZG_COMMITMENT_BYTES,
  MDU_SIZE_BYTES,
  POLYFS_SCALAR_BYTES,
  POLYFS_SCALAR_PAYLOAD_BYTES,
  RAW_MDU_CAPACITY_BYTES,
  formatBytes,
} from "../domain/polyfsLayout";

const FIELD_ELEMENTS_PER_BLOB = BLOB_SIZE_BYTES / POLYFS_SCALAR_BYTES;
const DEFAULT_MODE2_K = 8;
const DEFAULT_MODE2_M = 4;
const DEFAULT_MODE2_LEAVES = (DEFAULT_MODE2_K + DEFAULT_MODE2_M) * (BLOBS_PER_MDU / DEFAULT_MODE2_K);

const pipeline = [
  {
    id: "1",
    title: "Blob (encoded data)",
    stat: formatBytes(BLOB_SIZE_BYTES),
    icon: FileText,
    body: "An EIP-4844-shaped blob contains canonical field elements, not arbitrary byte chunks.",
  },
  {
    id: "2",
    title: "Field elements",
    stat: `${FIELD_ELEMENTS_PER_BLOB} scalars`,
    icon: Grid3X3,
    body: `PolyFS payload encoding uses ${POLYFS_SCALAR_PAYLOAD_BYTES} raw bytes per ${POLYFS_SCALAR_BYTES}-byte scalar.`,
  },
  {
    id: "3",
    title: "Polynomial",
    stat: "degree < 4096",
    icon: Braces,
    body: "The field elements represent a polynomial in the blob domain used by KZG.",
  },
  {
    id: "4",
    title: "KZG commitment",
    stat: `${KZG_COMMITMENT_BYTES} bytes`,
    icon: ShieldCheck,
    body: "The commitment is a compressed BLS12-381 G1 point, not a compressed copy of the data.",
  },
];

const dataRows = [
  ["Blob encoded size", formatBytes(BLOB_SIZE_BYTES), `${BLOB_SIZE_BYTES.toLocaleString()} bytes`],
  ["Field elements per blob", `${FIELD_ELEMENTS_PER_BLOB}`, `${FIELD_ELEMENTS_PER_BLOB} x ${POLYFS_SCALAR_BYTES} bytes`],
  ["Raw payload per scalar", `${POLYFS_SCALAR_PAYLOAD_BYTES} bytes`, "Canonical scalar encoding reserves headroom"],
  ["Encoded MDU", formatBytes(MDU_SIZE_BYTES), `${BLOBS_PER_MDU} blobs x ${formatBytes(BLOB_SIZE_BYTES)}`],
  ["Raw payload per MDU", formatBytes(RAW_MDU_CAPACITY_BYTES), "After 31-byte payload packing"],
  ["KZG commitment", `${KZG_COMMITMENT_BYTES} bytes`, "Compressed G1 point"],
  [
    "MDU root leaves",
    `64 or ${DEFAULT_MODE2_LEAVES}`,
    "64 for metadata/full replica; 96 for default Mode 2 stripes",
  ],
];

function Module({
  children,
  className = "",
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`glass-panel industrial-border ${className}`} data-testid={testId}>
      {children}
    </section>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.24em] text-primary font-mono-data">
      {children}
    </div>
  );
}

function NumberPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center border border-primary bg-primary/10 font-mono text-xs font-bold text-primary">
      {children}
    </span>
  );
}

function BlobGrid() {
  return (
    <div className="mx-auto grid max-w-[18rem] grid-cols-[repeat(24,minmax(0,1fr))] gap-1">
      {Array.from({ length: 288 }).map((_, index) => (
        <span key={index} className="h-1.5 w-1.5 bg-primary/70" />
      ))}
    </div>
  );
}

function ScalarTiles() {
  return (
    <div className="flex flex-wrap items-end justify-center gap-4">
      {["a0", "a1", "a2"].map((label) => (
        <div key={label} className="border border-primary/30 bg-primary/10 px-5 py-4 font-mono text-sm text-foreground">
          {label}
        </div>
      ))}
      <div className="px-2 pb-3 font-mono text-lg text-muted-foreground">...</div>
      <div className="border border-primary/30 bg-primary/10 px-4 py-4 font-mono text-sm text-foreground">a4095</div>
    </div>
  );
}

function CurveSketch() {
  return (
    <div className="relative mx-auto h-36 max-w-sm">
      <div className="absolute bottom-8 left-4 right-3 h-px bg-muted-foreground/60" />
      <div className="absolute bottom-3 left-8 top-3 w-px bg-muted-foreground/60" />
      <svg viewBox="0 0 360 144" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <path
          d="M28 104 C 58 24, 92 120, 130 66 S 193 38, 222 84 S 286 12, 330 48"
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth="4"
        />
        <circle cx="282" cy="32" r="5" fill="hsl(var(--primary))" />
      </svg>
      <span className="absolute left-1 top-2 font-mono text-xs text-foreground">f(x)</span>
      <span className="absolute bottom-2 right-0 font-mono text-xs text-foreground">x</span>
    </div>
  );
}

function EvaluationSurface() {
  return (
    <div className="relative mx-auto h-52 max-w-lg overflow-hidden">
      <div className="absolute bottom-8 left-14 right-12 h-px bg-muted-foreground/60" />
      <div className="absolute bottom-8 left-14 h-32 w-px bg-muted-foreground/60" />
      {Array.from({ length: 11 }).map((_, index) => (
        <svg
          key={index}
          viewBox="0 0 420 170"
          className="absolute inset-x-8 top-4 h-40"
          style={{ transform: `translateY(${index * 3}px)`, opacity: 0.18 + index * 0.055 }}
          aria-hidden="true"
        >
          <path
            d="M18 114 C 62 44, 105 132, 148 82 S 228 10, 276 68 S 350 50, 402 84"
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth="3"
          />
        </svg>
      ))}
      <div className="absolute right-28 top-10 h-28 border-l border-dashed border-primary" />
      <div className="absolute right-[6.55rem] top-8 h-3 w-3 rounded-full bg-primary" />
      <div className="absolute right-20 top-3 font-mono text-xs text-foreground">(z, f(z))</div>
      <div className="absolute bottom-1 left-24 font-mono text-xs text-muted-foreground">Re(x)</div>
      <div className="absolute bottom-2 right-8 font-mono text-xs text-muted-foreground">Im(x)</div>
    </div>
  );
}

export const PolyfsDocs = () => {
  return (
    <div className="container mx-auto max-w-7xl px-4 pt-24 pb-16" data-testid="polyfs-docs-page">
      <Module className="p-6 md:p-8">
        <div className="nil-badge w-fit text-primary">
          <Layers className="h-4 w-4" />
          PolyFS bottom up
        </div>
        <h1 className="mt-5 max-w-4xl text-4xl font-extrabold leading-tight text-foreground md:text-6xl">
          KZG Commitments in PolyStore
        </h1>
        <p className="mt-4 max-w-5xl text-base leading-7 text-muted-foreground">
          PolyStore uses <span className="font-semibold text-primary">Ethereum-style KZG commitments</span> to bind
          encoded blobs to compact proof anchors. The commitment is small; the data still lives with storage providers.
        </p>

        <div className="mt-8">
          <SectionLabel>The Pipeline</SectionLabel>
          <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch">
            {pipeline.map((step, index) => {
              return (
                <div key={step.id} className="contents">
                  <div className="rounded-none border border-border bg-background/60 p-5">
                    <div className="flex items-start gap-3">
                      <NumberPill>{step.id}</NumberPill>
                      <div>
                        <h2 className="font-bold text-foreground">{step.title}</h2>
                        <div className="font-mono text-sm font-bold text-primary">{step.stat}</div>
                      </div>
                    </div>
                    <div className="mt-5 min-h-24">
                      {step.id === "1" ? (
                        <BlobGrid />
                      ) : step.id === "2" ? (
                        <ScalarTiles />
                      ) : step.id === "3" ? (
                        <CurveSketch />
                      ) : (
                        <div className="mx-auto flex h-24 max-w-xs items-center justify-center border border-primary/30 bg-background font-mono text-sm text-foreground">
                          C = commit(blob polynomial)
                        </div>
                      )}
                    </div>
                    <p className="mt-5 text-sm leading-6 text-muted-foreground">{step.body}</p>
                  </div>
                  {index < pipeline.length - 1 ? (
                    <ArrowRight className="mx-auto hidden h-6 w-6 text-muted-foreground lg:mt-28 lg:block" />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </Module>

      <div className="mt-4 grid gap-4 lg:grid-cols-[0.95fr_1.05fr_0.95fr]">
        <Module className="p-6" testId="polyfs-data-types">
          <SectionLabel>Data Types</SectionLabel>
          <div className="overflow-hidden border border-border">
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-border">
                {dataRows.map(([label, value, note]) => (
                  <tr key={label} className="bg-background/50">
                    <th className="px-4 py-3 font-mono text-xs font-bold text-foreground">{label}</th>
                    <td className="px-4 py-3 font-mono text-xs text-primary">{value}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Module>

        <Module className="p-6" testId="polyfs-evaluation-view">
          <SectionLabel>Geographic Evaluation View</SectionLabel>
          <p className="text-sm leading-6 text-muted-foreground">
            KZG binds the polynomial representation everywhere. An opening proof shows that the committed polynomial
            evaluates to <span className="font-mono text-foreground">y</span> at point{" "}
            <span className="font-mono text-foreground">z</span>.
          </p>
          <EvaluationSurface />
        </Module>

        <Module className="p-6" testId="polyfs-verification">
          <SectionLabel>Verification</SectionLabel>
          <p className="text-sm leading-6 text-muted-foreground">
            Given commitment <span className="font-mono text-foreground">C</span>, point{" "}
            <span className="font-mono text-foreground">z</span>, claimed value{" "}
            <span className="font-mono text-foreground">y</span>, and KZG proof{" "}
            <span className="font-mono text-foreground">pi</span>, the verifier checks a pairing equation.
          </p>
          <div className="mt-5 border border-primary/40 bg-background/70 px-4 py-3 font-mono text-sm text-foreground">
            VerifyKZG(C, z, y, pi) -&gt; true / false
          </div>
          <p className="mt-5 text-sm leading-6 text-muted-foreground">
            Hop 3 proves a challenged field element or evaluation against a blob commitment. Retrieval clients still
            verify fetched blobs or shards against commitments before decoding file ranges.
          </p>
        </Module>
      </div>

      <Module className="mt-4 p-6" testId="polyfs-composition">
        <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr] lg:items-center">
          <div className="flex items-start gap-5">
            <HardDrive className="mt-1 h-10 w-10 shrink-0 text-primary" />
            <div>
              <h2 className="text-2xl font-extrabold text-foreground">Blob -&gt; MDU -&gt; Manifest -&gt; Deal</h2>
              <p className="mt-3 text-base leading-7 text-muted-foreground">
                PolyStore builds on the same KZG commitment scheme standardized by Ethereum. Blob commitments are
                folded into MDU roots; ordered MDU roots are committed by the manifest; the chain stores{" "}
                <span className="font-mono text-foreground">Deal.manifest_root</span> as the compact on-chain proof
                anchor.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] sm:items-center">
            {[
              { label: "Blob", sub: "128 KiB", icon: Grid3X3 },
              { label: "MDU", sub: "8 MiB encoded", icon: Box },
              { label: "Manifest", sub: "ordered MDU roots", icon: Layers },
              { label: "Deal", sub: "manifest_root", icon: FileCode },
            ].map((item, index) => {
              const Icon = item.icon;
              return (
                <div key={item.label} className="contents">
                  <div className="text-center">
                    <Icon className="mx-auto h-10 w-10 text-foreground" />
                    <div className="mt-2 font-bold text-foreground">{item.label}</div>
                    <div className="text-xs text-muted-foreground">{item.sub}</div>
                  </div>
                  {index < 3 ? <ArrowRight className="mx-auto hidden h-5 w-5 text-muted-foreground sm:block" /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </Module>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Module className="p-6" testId="polyfs-mdu-proof-notes">
          <SectionLabel>MDU Roots</SectionLabel>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-none border border-border bg-background/60 p-4">
              <Database className="h-6 w-6 text-primary" />
              <h3 className="mt-3 font-bold text-foreground">Metadata / full replica</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Uses a 64-leaf Merkle root over the 64 blob commitments in one encoded MDU.
              </p>
            </div>
            <div className="rounded-none border border-border bg-background/60 p-4">
              <Anchor className="h-6 w-6 text-primary" />
              <h3 className="mt-3 font-bold text-foreground">Mode 2 striped user data</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Uses <span className="font-mono text-foreground">leaf_index</span> over{" "}
                <span className="font-mono text-foreground">L=(K+M)*(64/K)</span> shard blob commitments. Default
                K=8, M=4 gives {DEFAULT_MODE2_LEAVES} leaves.
              </p>
            </div>
          </div>
        </Module>

        <Module className="p-6" testId="polyfs-triple-proof">
          <SectionLabel>Triple Proof Path</SectionLabel>
          <div className="grid gap-3">
            {[
              ["Hop 1", "KZG opening", "Proves an MDU root is included under Deal.manifest_root."],
              ["Hop 2", "Merkle proof", "Proves a blob or shard commitment is included under the MDU root."],
              ["Hop 3", "KZG opening", "Proves a challenged field evaluation against the blob commitment."],
            ].map(([hop, kind, detail]) => (
              <div key={hop} className="grid gap-3 rounded-none border border-border bg-background/60 p-4 sm:grid-cols-[5rem_8rem_1fr]">
                <div className="font-mono text-xs font-bold text-primary">{hop}</div>
                <div className="font-semibold text-foreground">{kind}</div>
                <div className="text-sm text-muted-foreground">{detail}</div>
              </div>
            ))}
          </div>
        </Module>
      </div>

      <section className="mt-8 border-t border-border pt-8">
        <div className="flex flex-wrap gap-3">
          <Link
            to="/technology/kzg"
            className="glass-panel industrial-border inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted/40"
          >
            <Braces className="h-4 w-4" />
            KZG deep dive
          </Link>
          <Link
            to="/spec"
            className="glass-panel industrial-border inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted/40"
          >
            <FileCode className="h-4 w-4" />
            Protocol spec
          </Link>
          <span className="glass-panel industrial-border inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-success">
            <CheckCircle2 className="h-4 w-4" />
            Canonical PolyFS page
          </span>
        </div>
      </section>
    </div>
  );
};
