import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Anchor,
  ArrowDown,
  ArrowRight,
  BadgeCheck,
  Box,
  Braces,
  CheckCircle2,
  Database,
  FileCode,
  FileText,
  GitBranch,
  Grid3X3,
  Hash,
  Info,
  KeyRound,
  Layers,
  LockKeyhole,
  Network,
  OctagonX,
  ShieldCheck,
} from "lucide-react";
import {
  BLOBS_PER_MDU,
  BLOB_SIZE_BYTES,
  KZG_COMMITMENT_BYTES,
  MDU_SIZE_BYTES,
  POLYFS_SCALAR_BYTES,
  formatBytes,
} from "../domain/polyfsLayout";

const FIELD_ELEMENTS_PER_BLOB = BLOB_SIZE_BYTES / POLYFS_SCALAR_BYTES;

const flowSteps = [
  {
    label: "128 KiB Blob",
    detail: "Ethereum blob atom",
    icon: FileText,
  },
  {
    label: "4096 Scalars",
    detail: "32-byte field elements",
    icon: Grid3X3,
  },
  {
    label: "Polynomial f(x)",
    detail: "coefficients a_i",
    icon: Braces,
  },
  {
    label: "48B KZG Commitment",
    detail: "compressed G1 point",
    icon: BadgeCheck,
  },
  {
    label: "PolyStore Proof Anchor",
    detail: "deal manifest root",
    icon: Anchor,
  },
];

const ladderRows = [
  {
    label: "Blob",
    detail: `${formatBytes(BLOB_SIZE_BYTES)} / ${BLOB_SIZE_BYTES.toLocaleString()} bytes`,
    note: "Ethereum blob atom",
    icon: FileText,
  },
  {
    label: "Field elements",
    detail: `${FIELD_ELEMENTS_PER_BLOB} x ${POLYFS_SCALAR_BYTES}-byte scalars`,
    note: "a_i in Fr",
    icon: Grid3X3,
  },
  {
    label: "Polynomial",
    detail: "degree <= 4095",
    note: "f(x) = sum a_i x^i",
    icon: Braces,
  },
  {
    label: "KZG commitment",
    detail: `compressed BLS12-381 G1 point = ${KZG_COMMITMENT_BYTES} bytes`,
    note: "C in G1",
    icon: BadgeCheck,
  },
];

const commitmentIs = [
  "One compressed BLS12-381 G1 point",
  "A binding commitment to the polynomial",
  "Small and cheap to store",
  "Usable for later KZG opening proofs",
];

const commitmentIsNot = [
  "The blob",
  "Ordinary compression",
  "Enough to reconstruct the polynomial",
  "A replacement for storing the data",
];

const whyKzg = [
  {
    title: "Compact",
    body: "A 128 KiB blob commits to 48 bytes.",
    icon: Database,
  },
  {
    title: "Verifiable",
    body: "Small proofs can be checked against the commitment.",
    icon: ShieldCheck,
  },
  {
    title: "Composable",
    body: "Blob commitments can be nested into MDUs and manifests.",
    icon: Network,
  },
  {
    title: "Ethereum-aligned",
    body: "PolyStore uses the same blob/KZG primitive shape.",
    icon: Layers,
  },
  {
    title: "Storage friendly",
    body: "Providers prove possession without sending data on-chain.",
    icon: LockKeyhole,
  },
  {
    title: "Proof anchor",
    body: "A deal root gives the protocol one compact trust anchor.",
    icon: Anchor,
  },
];

const advancedDetails = [
  {
    title: "Scalar field Fr",
    body: "All coefficients a_i and powers tau^i are field elements; scalar arithmetic is modulo r.",
    token: "Fr",
  },
  {
    title: "G1 group",
    body: "G is the public generator of the BLS12-381 G1 subgroup. scalar x G gives a G1 point.",
    token: "G1",
  },
  {
    title: "Trusted setup",
    body: "The setup publishes [G, tau G, ..., tau^4095 G], not tau.",
    token: "tau",
  },
  {
    title: "MSM",
    body: "The implementation computes C = sum a_i (tau^i G).",
    token: "sum",
  },
];

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`glass-panel industrial-border ${className}`}>{children}</div>;
}

function SectionTitle({ number, children }: { number: number; children: ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className="flex h-7 w-7 items-center justify-center bg-primary font-mono text-xs font-bold text-primary-foreground">
        {number}
      </span>
      <h2 className="text-xl font-extrabold leading-tight text-foreground md:text-2xl">{children}</h2>
    </div>
  );
}

function FlowArrow({ vertical = false }: { vertical?: boolean }) {
  return vertical ? (
    <ArrowDown className="mx-auto h-5 w-5 text-primary" />
  ) : (
    <ArrowRight className="hidden h-5 w-5 shrink-0 text-primary md:block" />
  );
}

function BlobSketch() {
  return (
    <div className="mx-auto grid w-24 grid-cols-6 gap-1">
      {Array.from({ length: 36 }).map((_, index) => (
        <span key={index} className="h-2.5 border border-primary/40 bg-primary/10" />
      ))}
    </div>
  );
}

function ScalarGrid() {
  return (
    <div className="mx-auto grid w-20 grid-cols-6 gap-1">
      {Array.from({ length: 36 }).map((_, index) => (
        <span key={index} className="h-1.5 w-1.5 bg-primary" />
      ))}
    </div>
  );
}

function PolynomialSketch() {
  return (
    <div className="relative mx-auto h-24 w-36">
      <div className="absolute bottom-5 left-3 right-2 h-px bg-muted-foreground/40" />
      <div className="absolute bottom-2 left-9 top-2 w-px bg-muted-foreground/40" />
      <svg viewBox="0 0 144 96" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <path d="M16 72 C 36 18, 54 84, 78 50 S 112 18, 132 24" fill="none" stroke="hsl(var(--primary))" strokeWidth="3" />
        <circle cx="104" cy="30" r="4" fill="hsl(var(--primary))" />
      </svg>
      <span className="absolute right-3 top-2 font-mono text-xs font-bold text-primary">C</span>
    </div>
  );
}

function G1Point() {
  return (
    <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border-2 border-primary/50 font-mono text-2xl font-bold text-foreground">
      G1
    </div>
  );
}

function FormulaBlock({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`font-mono text-sm leading-7 text-foreground ${className}`}>
      {children}
    </div>
  );
}

export const Polyfs2Docs = () => {
  return (
    <div className="container mx-auto max-w-7xl px-4 pt-24 pb-16" data-testid="polyfs2-page">
      <header className="grid gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
        <div>
          <div className="nil-badge w-fit text-primary">
            <Layers className="h-4 w-4" />
            PolyFS bottom up
          </div>
          <h1 className="mt-5 max-w-3xl text-4xl font-extrabold leading-tight text-foreground md:text-5xl">
            From Ethereum KZG blobs to <span className="text-primary">PolyStore</span> proof anchors
          </h1>
          <p className="mt-5 max-w-3xl text-sm leading-7 text-muted-foreground md:text-base">
            PolyStore starts with the same KZG commitment primitive used by Ethereum blobs: a 128 KiB blob becomes
            4096 scalar field elements, then one 48-byte compressed BLS12-381 G1 commitment.
          </p>
        </div>

        <Panel className="p-5">
          <div className="grid gap-4 md:flex md:items-center md:justify-between">
            {flowSteps.map((step, index) => {
              const Icon = step.icon;
              return (
                <div key={step.label} className="grid gap-3 md:contents">
                  <div className="text-center md:flex-1">
                    <Icon className="mx-auto h-12 w-12 text-primary" />
                    <div className="mt-3 text-sm font-extrabold text-foreground">{step.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{step.detail}</div>
                  </div>
                  {index < flowSteps.length - 1 ? (
                    <>
                      <ArrowDown className="mx-auto h-5 w-5 text-primary md:hidden" />
                      <ArrowRight className="hidden h-5 w-5 shrink-0 text-primary md:block" />
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Panel>
      </header>

      <main className="mt-8 space-y-4">
        <Panel className="p-5">
          <SectionTitle number={1}>KZG commitment: the first proof anchor</SectionTitle>
          <div className="grid gap-4 md:grid-cols-[0.9fr_1.1fr] md:items-center">
            <div className="text-sm leading-7 text-muted-foreground">
              <p>
                A KZG commitment binds a polynomial to one compact curve point. In PolyStore, the polynomial is not a
                separate object: the blob bytes are parsed into scalar field elements and treated as the polynomial
                coefficients.
              </p>
              <p className="mt-3">
                The 48-byte commitment is small enough to move through Merkle trees, MDU roots, manifests, and deal
                state without reposting the full blob on-chain.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Panel className="p-4">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Blob</div>
                <div className="mt-2 font-mono text-xl text-foreground">{formatBytes(BLOB_SIZE_BYTES)}</div>
              </Panel>
              <Panel className="p-4">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Field elements
                </div>
                <div className="mt-2 font-mono text-xl text-foreground">{FIELD_ELEMENTS_PER_BLOB}</div>
              </Panel>
              <Panel className="p-4">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Commitment
                </div>
                <div className="mt-2 font-mono text-xl text-foreground">{KZG_COMMITMENT_BYTES} B</div>
              </Panel>
            </div>
          </div>
        </Panel>

        <Panel className="p-5">
          <SectionTitle number={2}>Data type ladder</SectionTitle>
          <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] md:items-stretch">
            {ladderRows.map((item, index) => {
              const Icon = item.icon;
              return (
                <div key={item.label} className="contents">
                  <Panel className="p-4 text-center">
                    <div className="mb-3 flex items-center gap-2 text-left">
                      <span className="flex h-6 w-6 items-center justify-center bg-primary font-mono text-xs font-bold text-primary-foreground">
                        {index + 1}
                      </span>
                      <div className="text-sm font-extrabold text-foreground">{item.label}</div>
                    </div>
                    <Icon className="mx-auto h-12 w-12 text-primary" />
                    <div className="mt-4 font-mono text-sm text-foreground">{item.detail}</div>
                    <div className="mt-2 text-xs text-muted-foreground">{item.note}</div>
                  </Panel>
                  {index < ladderRows.length - 1 ? <FlowArrow /> : null}
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-center text-sm font-semibold text-primary">
            Same blob/KZG shape as Ethereum EIP-4844.
          </p>
        </Panel>

        <Panel className="p-5">
          <SectionTitle number={3}>Bytes become a polynomial</SectionTitle>
          <div className="grid gap-6 lg:grid-cols-[0.8fr_auto_1.1fr_auto_0.8fr] lg:items-center">
            <div className="text-center">
              <div className="font-mono text-sm font-bold text-foreground">128 KiB blob</div>
              <div className="mb-4 text-xs text-muted-foreground">({BLOB_SIZE_BYTES.toLocaleString()} bytes)</div>
              <BlobSketch />
            </div>
            <FlowArrow />
            <Panel className="p-4">
              <div className="grid gap-2">
                {[0, 1, 2].map((lane) => (
                  <div key={lane} className="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-2 font-mono text-xs">
                    <span className="border border-border bg-background px-2 py-1 text-muted-foreground">lane {lane}</span>
                    <ArrowRight className="h-4 w-4 text-primary" />
                    <span className="border border-border bg-background px-2 py-1 text-center text-foreground">a{lane}</span>
                  </div>
                ))}
                <div className="text-center font-mono text-sm text-muted-foreground">...</div>
                <div className="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-2 font-mono text-xs">
                  <span className="border border-border bg-background px-2 py-1 text-muted-foreground">lane 4095</span>
                  <ArrowRight className="h-4 w-4 text-primary" />
                  <span className="border border-border bg-background px-2 py-1 text-center text-foreground">a4095</span>
                </div>
              </div>
            </Panel>
            <FlowArrow />
            <Panel className="p-5 text-center">
              <FormulaBlock className="text-xl md:text-2xl">f(x) = sum a_i x^i</FormulaBlock>
              <div className="mt-2 text-xs text-muted-foreground">i = 0..4095</div>
            </Panel>
          </div>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Each 32-byte chunk is interpreted as a BLS12-381 scalar field element. Those 4096 scalars become the
            polynomial coefficients.
          </p>
        </Panel>

        <Panel className="p-5">
          <SectionTitle number={4}>KZG commit = one G1 point</SectionTitle>
          <div className="grid gap-4 lg:grid-cols-4">
            <Panel className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center bg-primary font-mono text-xs font-bold text-primary-foreground">
                  1
                </span>
                <h3 className="font-bold text-foreground">Polynomial coefficients</h3>
              </div>
              <FormulaBlock>f(x) = sum a_i x^i</FormulaBlock>
              <div className="mt-3 text-xs text-muted-foreground">4096 coefficients a_i in Fr.</div>
              <div className="mt-4 space-y-2 font-mono text-xs">
                {["a0", "a1", "a2", "...", "a4095"].map((item) => (
                  <div key={item} className="border border-border bg-background px-3 py-1 text-center text-foreground">
                    {item}
                  </div>
                ))}
              </div>
            </Panel>

            <Panel className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center bg-primary font-mono text-xs font-bold text-primary-foreground">
                  2
                </span>
                <h3 className="font-bold text-foreground">Trusted setup powers</h3>
              </div>
              <FormulaBlock>[G, tau G, tau^2 G, ..., tau^4095 G]</FormulaBlock>
              <p className="mt-3 text-xs leading-6 text-muted-foreground">
                tau is secret; only the encoded G1 points tau^i G are published.
              </p>
              <PolynomialSketch />
              <div className="text-center text-xs text-muted-foreground">G1 elliptic-curve group used by KZG.</div>
            </Panel>

            <Panel className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center bg-primary font-mono text-xs font-bold text-primary-foreground">
                  3
                </span>
                <h3 className="font-bold text-foreground">MSM in G1</h3>
              </div>
              <div className="space-y-2 font-mono text-xs">
                {["a0 x tau^0 G", "a1 x tau^1 G", "a2 x tau^2 G"].map((item) => (
                  <div key={item} className="border border-border bg-background px-3 py-2 text-foreground">
                    {item}
                  </div>
                ))}
              </div>
              <FormulaBlock className="mt-4 text-base">C = sum a_i (tau^i G)</FormulaBlock>
              <div className="mt-3 flex items-start gap-2 border border-primary/30 bg-primary/10 p-3 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>MSM means multi-scalar multiplication: add all 4096 scaled G1 points.</span>
              </div>
            </Panel>

            <Panel className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center bg-primary font-mono text-xs font-bold text-primary-foreground">
                  4
                </span>
                <h3 className="font-bold text-foreground">Output</h3>
              </div>
              <G1Point />
              <FlowArrow vertical />
              <Panel className="p-3 text-center">
                <FormulaBlock>compressed(C)</FormulaBlock>
                <div className="text-sm font-bold text-primary">= {KZG_COMMITMENT_BYTES} bytes</div>
              </Panel>
              <p className="mt-3 text-xs leading-6 text-muted-foreground">
                This 48-byte compressed BLS12-381 G1 point is the KZG commitment.
              </p>
            </Panel>
          </div>

          <Panel className="mt-4 p-4 text-center">
            <FormulaBlock className="text-base">
              C = sum a_i (tau^i G) = (sum a_i tau^i) G = f(tau) G
            </FormulaBlock>
            <p className="mt-2 text-xs text-muted-foreground">
              Implementation view: MSM over setup points. Mathematical view: evaluate f(x) at x = tau, then encode in G1.
            </p>
          </Panel>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="p-5">
            <SectionTitle number={5}>What the 48 bytes are, and are not</SectionTitle>
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-success">
                  <CheckCircle2 className="h-5 w-5" />
                  The commitment is:
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {commitmentIs.map((item) => (
                    <li key={item} className="flex gap-2">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-destructive">
                  <OctagonX className="h-5 w-5" />
                  The commitment is not:
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {commitmentIsNot.map((item) => (
                    <li key={item} className="flex gap-2">
                      <OctagonX className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mt-5 flex items-start gap-3 border border-primary/30 bg-primary/10 p-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>128 KiB to 48 bytes works because this is a cryptographic commitment, not a compressed copy of the data.</span>
            </div>
          </Panel>

          <Panel className="p-5">
            <SectionTitle number={6}>Why the commitment is useful: opening proofs</SectionTitle>
            <div className="flex flex-wrap items-center gap-2">
              {["Commitment C", "Evaluation point z", "Claimed value y", "KZG proof pi", "VerifyKZG(C,z,y,pi)"].map(
                (item, index) => (
                  <div key={item} className="contents">
                    <Panel className="px-3 py-2 text-center font-mono text-xs text-foreground">{item}</Panel>
                    {index < 4 ? <ArrowRight className="h-4 w-4 text-primary" /> : null}
                  </div>
                ),
              )}
              <Panel className="px-4 py-2 text-center text-sm font-bold text-success">
                true
                <CheckCircle2 className="ml-2 inline h-4 w-4" />
              </Panel>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-[0.8fr_1fr] md:items-center">
              <PolynomialSketch />
              <p className="text-sm leading-7 text-muted-foreground">
                A provider can show that the committed polynomial evaluates to y at point z, without sending the full
                128 KiB blob.
              </p>
            </div>
          </Panel>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Panel className="p-5">
            <SectionTitle number={7}>PolyStore composition: Blob {"->"} MDU {"->"} Manifest {"->"} Deal</SectionTitle>
            <div className="space-y-3">
              {[
                { label: "Blob", detail: "128 KiB, one KZG commitment", icon: FileText },
                { label: "MDU", detail: `${formatBytes(MDU_SIZE_BYTES)}, ${BLOBS_PER_MDU} blobs, Merkle root`, icon: GitBranch },
                { label: "Manifest", detail: "maps MDU index to MDU root", icon: Box },
                { label: "Deal manifest_root", detail: "single 48-byte on-chain proof anchor", icon: Anchor },
              ].map((item, index, list) => {
                const Icon = item.icon;
                return (
                  <div key={item.label}>
                    <Panel className="flex items-center gap-3 p-3">
                      <Icon className="h-6 w-6 shrink-0 text-primary" />
                      <div>
                        <div className="font-bold text-foreground">{item.label}</div>
                        <div className="text-xs text-muted-foreground">{item.detail}</div>
                      </div>
                    </Panel>
                    {index < list.length - 1 ? <ArrowDown className="mx-auto my-1 h-4 w-4 text-primary" /> : null}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-start gap-3 border border-primary/30 bg-primary/10 p-3 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                PolyStore chains commitments: blob KZG commitments are included in MDU Merkle trees; MDU roots are
                committed through the manifest; the deal stores a single manifest root.
              </span>
            </div>
          </Panel>

          <Panel className="p-5">
            <SectionTitle number={8}>Triple proof: from deal root to served data</SectionTitle>
            <div className="space-y-3">
              {[
                ["Deal manifest_root", "48-byte KZG commitment", "Hop 1: Identity"],
                ["MDU root at mdu_index", "Hop 1: KZG opening", "Hop 2: Structure"],
                ["Blob commitment at blob_index", "Hop 2: Merkle proof", "Hop 3: Data"],
                ["Field evaluation / challenged data", "Hop 3: KZG opening", ""],
              ].map(([label, detail, hop], index) => (
                <div key={label}>
                  <div className="grid gap-2 md:grid-cols-[1fr_7.5rem] md:items-center">
                    <Panel className="p-3">
                      <div className="font-bold text-foreground">{label}</div>
                      <div className="text-xs text-primary">{detail}</div>
                    </Panel>
                    {hop ? <Panel className="p-3 text-center text-xs font-bold text-foreground">{hop}</Panel> : null}
                  </div>
                  {index < 3 ? <ArrowDown className="mx-auto my-1 h-4 w-4 text-primary" /> : null}
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-start gap-3 border border-primary/30 bg-primary/10 p-3 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>All three checks bind the served bytes back to the deal&apos;s on-chain manifest root.</span>
            </div>
          </Panel>

          <Panel className="p-5">
            <SectionTitle number={9}>Why PolyStore uses KZG commitments</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              {whyKzg.map((item) => {
                const Icon = item.icon;
                return (
                  <Panel key={item.title} className="p-4">
                    <Icon className="h-6 w-6 text-primary" />
                    <div className="mt-3 font-bold text-foreground">{item.title}</div>
                    <div className="mt-1 text-xs leading-5 text-muted-foreground">{item.body}</div>
                  </Panel>
                );
              })}
            </div>
          </Panel>
        </div>

        <Panel className="p-5">
          <SectionTitle number={10}>Advanced details: Fr, G1, trusted setup, MSM</SectionTitle>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {advancedDetails.map((item) => (
              <Panel key={item.title} className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-primary/40 font-mono text-sm font-bold text-foreground">
                    {item.token}
                  </div>
                  <div className="font-bold text-foreground">{item.title}</div>
                </div>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{item.body}</p>
              </Panel>
            ))}
          </div>
        </Panel>

        <section className="border-t border-border pt-8">
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
            <Link
              to="/polyfs"
              className="glass-panel industrial-border inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted/40"
            >
              <Hash className="h-4 w-4" />
              Current PolyFS page
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
};
