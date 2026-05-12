import { Link } from "react-router-dom";
import {
  ArrowRight,
  Box,
  Database,
  FileSearch,
  FileText,
  GitBranch,
  HardDrive,
  KeyRound,
  Layers,
  Network,
  RefreshCw,
  ShieldCheck,
  Split,
  TableProperties,
  Workflow,
} from "lucide-react";
import {
  BLOBS_PER_MDU,
  BLOB_SIZE_BYTES,
  KZG_COMMITMENT_BYTES,
  MDU_SIZE_BYTES,
  POLYFS_FILE_RECORD_BYTES,
  POLYFS_FILE_RECORD_CAPACITY,
  POLYFS_FILE_TABLE_END_BLOB,
  POLYFS_FILE_TABLE_HEADER_BYTES,
  POLYFS_FILE_TABLE_START_BLOB,
  POLYFS_RECORD_PATH_BYTES,
  POLYFS_ROOT_SIZE_BYTES,
  POLYFS_ROOT_TABLE_BLOBS,
  POLYFS_ROOT_TABLE_CAPACITY,
  RAW_MDU_CAPACITY_BYTES,
  computePolyfsResolvedRange,
  computeStripeProfile,
  computeUserMduCount,
  computeWitnessLayout,
  formatBytes,
  leafIndexForSlotRow,
} from "../domain/polyfsLayout";

function formatIntRange(start: number, end: number): string {
  if (start === end) return `#${start}`;
  return `#${start}..#${end}`;
}

function formatBigintRange(start: bigint, end: bigint): string {
  if (start === end) return start.toString();
  return `${start.toString()}..${end.toString()}`;
}

const protocolProfile = computeStripeProfile(8, 4);
const trustedDevnetProfile = computeStripeProfile(2, 1);
const witnessLayout = computeWitnessLayout({ totalUserMdus: 4096, k: 8, m: 4 });
const exampleWitnessMdus = witnessLayout.witnessMduCount;
const exampleMetaMdus = 1 + exampleWitnessMdus;
const exampleFiles = [
  { path: "notes/readme.md", startOffset: 0, sizeBytes: 18 * 1024 },
  { path: "photos/logo.png", startOffset: 18 * 1024, sizeBytes: 740 * 1024 },
  {
    path: "datasets/window.parquet",
    startOffset: RAW_MDU_CAPACITY_BYTES - 256 * 1024,
    sizeBytes: 3 * 1024 * 1024,
  },
  {
    path: "video/clip.mp4",
    startOffset: 5 * RAW_MDU_CAPACITY_BYTES + 640 * 1024,
    sizeBytes: 19 * 1024 * 1024,
  },
].map((file) => ({
  ...file,
  ranges: computePolyfsResolvedRange({
    witnessMdus: exampleWitnessMdus,
    startOffsetBytes: file.startOffset,
    sizeBytes: file.sizeBytes,
  }),
}));

const slabSegments = [
  { label: "MDU #0", detail: "Super-Manifest", tone: "primary", count: 1 },
  { label: `Witness #1..#${exampleWitnessMdus}`, detail: "Blob commitments", tone: "accent", count: exampleWitnessMdus },
  { label: `User #${exampleMetaMdus}+`, detail: "Encoded file payloads", tone: "foreground", count: 6 },
];

const proofHops = [
  {
    label: "Hop 1",
    title: "Manifest KZG",
    detail: "Proves an ordered MDU root is included under the deal's 48-byte manifest_root.",
  },
  {
    label: "Hop 2",
    title: "MDU root",
    detail: "Proves the requested blob commitment is one of the leaves for that MDU.",
  },
  {
    label: "Hop 3",
    title: "Blob KZG",
    detail: "Proves the served bytes match the 128 KiB blob commitment.",
  },
];

const generationSteps = [
  {
    label: "1. Bootstrap",
    detail: "Read the chain's current manifest_root and reconstruct MDU #0 plus witness MDUs into OPFS or the user-gateway cache.",
  },
  {
    label: "2. Mutate locally",
    detail: "Append, overwrite, or tombstone file records against the current generation and compute a new slab root.",
  },
  {
    label: "3. Stage artifacts",
    detail: "Upload the new MDU #0, witness MDUs, user MDUs, and manifest blob as a provisional generation.",
  },
  {
    label: "4. Signed CAS",
    detail: "Commit previous_manifest_root -> new_manifest_root. The chain rejects stale writers.",
  },
];

export const PolyfsDocs = () => {
  const exampleHighWaterBytes = Math.max(...exampleFiles.map((file) => file.startOffset + file.sizeBytes));
  const exampleUserMdus = computeUserMduCount(exampleHighWaterBytes);
  const exampleTotalMdus = 1 + exampleWitnessMdus + exampleUserMdus;
  const protocolLeafExample = leafIndexForSlotRow(protocolProfile, 7, 3);

  return (
    <div className="container mx-auto max-w-6xl px-4 pt-24 pb-16" data-testid="polyfs-docs-page">
      <header className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
        <div className="space-y-5">
          <div className="inline-flex items-center gap-2 border border-primary/20 bg-primary/10 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
            <HardDrive className="h-4 w-4" />
            Filesystem on slab
          </div>
          <div className="space-y-4">
            <h1 className="max-w-4xl text-4xl font-extrabold leading-tight text-foreground md:text-6xl">
              Polynomial Filesystem technical details
            </h1>
            <p className="max-w-3xl text-base leading-7 text-muted-foreground md:text-lg">
              PolyFS turns a mutable file tree into ordered, content-committed slab generations. Each file path resolves to
              raw byte offsets, those offsets resolve to MDUs and blobs, and the final bytes verify against the deal's
              on-chain <span className="font-mono text-foreground">manifest_root</span>.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link
              to="/technology/kzg"
              className="inline-flex items-center gap-2 border border-border bg-card px-4 py-2 font-semibold text-foreground hover:bg-muted/40"
            >
              KZG deep dive
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/spec"
              className="inline-flex items-center gap-2 border border-border bg-card px-4 py-2 font-semibold text-foreground hover:bg-muted/40"
            >
              Protocol spec
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <div className="border border-border bg-card p-5 shadow-sm">
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Blob", value: formatBytes(BLOB_SIZE_BYTES) },
              { label: "MDU", value: formatBytes(MDU_SIZE_BYTES) },
              { label: "Raw MDU capacity", value: formatBytes(RAW_MDU_CAPACITY_BYTES) },
              { label: "KZG commitment", value: `${KZG_COMMITMENT_BYTES} B` },
            ].map((stat) => (
              <div key={stat.label} className="border border-border bg-background/70 p-4">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{stat.label}</div>
                <div className="mt-2 font-mono text-lg text-foreground">{stat.value}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 border border-border bg-secondary/20 p-4 text-sm leading-6 text-muted-foreground">
            On disk, an MDU is exactly 8 MiB. For PolyFS file payloads, each 32-byte scalar carries 31 bytes of user
            data, so file offsets advance by <span className="font-mono text-foreground">{RAW_MDU_CAPACITY_BYTES}</span>{" "}
            raw bytes per user MDU.
          </div>
        </div>
      </header>

      <main className="mt-14 space-y-16">
        <section className="space-y-6" data-testid="polyfs-slab-anatomy">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
                <Layers className="h-4 w-4" />
                Slab anatomy
              </div>
              <h2 className="mt-2 text-2xl font-bold text-foreground md:text-3xl">A deal is an ordered slab generation</h2>
            </div>
            <div className="font-mono text-sm text-muted-foreground">
              total_mdus = 1 + witness_mdus + user_mdus
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
            <div className="space-y-4">
              <p className="text-sm leading-7 text-muted-foreground">
                PolyFS does not make every uploaded file its own deal. A deal is a container. Its current generation is a
                slab of MDUs where metadata occupies the lowest indices and user payloads occupy the rest.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  { label: "MDU #0", value: "File table + roots", icon: TableProperties },
                  { label: "Witness", value: "KZG blob map", icon: KeyRound },
                  { label: "User MDUs", value: "File payload bytes", icon: Database },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="border border-border bg-card p-4">
                      <Icon className="h-5 w-5 text-primary" />
                      <div className="mt-3 text-sm font-bold text-foreground">{item.label}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{item.value}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border border-border bg-card p-5">
              <div className="flex flex-wrap items-stretch gap-2">
                {slabSegments.map((segment) => (
                  <div
                    key={segment.label}
                    className="min-w-[150px] flex-1 border border-border bg-background/70 p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                        {segment.label}
                      </div>
                      <Box className="h-4 w-4 text-primary" />
                    </div>
                    <div className="mt-2 text-sm font-semibold text-foreground">{segment.detail}</div>
                    <div className="mt-4 grid grid-cols-6 gap-1">
                      {Array.from({ length: Math.min(12, Math.max(1, segment.count)) }).map((_, i) => (
                        <div
                          key={i}
                          className="h-7 border border-border bg-primary/10"
                          aria-hidden="true"
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
                <div className="border border-border bg-secondary/20 p-3">
                  Example user MDUs: <span className="font-mono text-foreground">{exampleUserMdus}</span>
                </div>
                <div className="border border-border bg-secondary/20 p-3">
                  Witness MDUs: <span className="font-mono text-foreground">{exampleWitnessMdus}</span>
                </div>
                <div className="border border-border bg-secondary/20 p-3">
                  Total MDUs: <span className="font-mono text-foreground">{exampleTotalMdus}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-6" data-testid="polyfs-mdu0-layout">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
              <FileText className="h-4 w-4" />
              MDU #0
            </div>
            <h2 className="mt-2 text-2xl font-bold text-foreground md:text-3xl">The Super-Manifest is the filesystem index</h2>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <div className="border border-primary/20 bg-primary/10 p-2">
                  <TableProperties className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <div className="text-lg font-bold text-foreground">Root table</div>
                  <div className="text-xs text-muted-foreground">Blobs 0..15</div>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                The root table stores 32-byte roots for every slab MDU after MDU #0: witness roots first, then user-data
                roots. MDU #0's own root is computed from its full 8 MiB buffer and included in the manifest separately.
              </p>
              <div className="mt-4 grid gap-2 text-sm">
                <div className="flex justify-between border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Reserved blobs</span>
                  <span className="font-mono text-foreground">{POLYFS_ROOT_TABLE_BLOBS}</span>
                </div>
                <div className="flex justify-between border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Root width</span>
                  <span className="font-mono text-foreground">{POLYFS_ROOT_SIZE_BYTES} B</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-muted-foreground">Root capacity</span>
                  <span className="font-mono text-foreground">{POLYFS_ROOT_TABLE_CAPACITY.toLocaleString()}</span>
                </div>
              </div>
            </div>

            <div className="border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <div className="border border-accent/20 bg-accent/10 p-2">
                  <FileSearch className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <div className="text-lg font-bold text-foreground">File table</div>
                  <div className="text-xs text-muted-foreground">
                    Blobs {POLYFS_FILE_TABLE_START_BLOB}..{POLYFS_FILE_TABLE_END_BLOB}
                  </div>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                The file table starts with a <span className="font-mono text-foreground">NILF</span> header, then fixed
                records. Each active record maps a PolyFS path to a raw start offset, packed length and flags, timestamp,
                and a null-terminated path field.
              </p>
              <div className="mt-4 grid gap-2 text-sm">
                <div className="flex justify-between border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Header</span>
                  <span className="font-mono text-foreground">{POLYFS_FILE_TABLE_HEADER_BYTES} B</span>
                </div>
                <div className="flex justify-between border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Record size</span>
                  <span className="font-mono text-foreground">{POLYFS_FILE_RECORD_BYTES} B</span>
                </div>
                <div className="flex justify-between border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Path field</span>
                  <span className="font-mono text-foreground">{POLYFS_RECORD_PATH_BYTES} B</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-muted-foreground">Record capacity</span>
                  <span className="font-mono text-foreground">{POLYFS_FILE_RECORD_CAPACITY.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="border border-border bg-background/70 p-4">
            <div className="grid grid-cols-8 gap-1 md:grid-cols-16">
              {Array.from({ length: BLOBS_PER_MDU }).map((_, blob) => {
                const root = blob < POLYFS_ROOT_TABLE_BLOBS;
                return (
                  <div
                    key={blob}
                    className={`flex h-9 items-center justify-center border text-[10px] font-mono ${
                      root
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-accent/30 bg-accent/10 text-accent"
                    }`}
                    title={root ? "Root table blob" : "File table blob"}
                  >
                    {blob}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span>
                <span className="mr-2 inline-block h-2 w-2 bg-primary/40" />
                Root table
              </span>
              <span>
                <span className="mr-2 inline-block h-2 w-2 bg-accent/40" />
                File table
              </span>
            </div>
          </div>
        </section>

        <section className="space-y-6" data-testid="polyfs-path-resolution">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
              <Workflow className="h-4 w-4" />
              Path resolution
            </div>
            <h2 className="mt-2 text-2xl font-bold text-foreground md:text-3xl">From file path to MDU and blob ranges</h2>
          </div>
          <div className="grid gap-5 lg:grid-cols-[0.82fr_1.18fr]">
            <div className="space-y-4">
              <p className="text-sm leading-7 text-muted-foreground">
                Fetch starts by mounting MDU #0, finding the latest non-tombstone file record for a path, then converting
                the raw byte interval into user MDU, slab MDU, and encoded blob positions.
              </p>
              <div className="border border-border bg-card p-4 font-mono text-xs leading-6 text-foreground">
                <div>meta_mdus = 1 + witness_mdus</div>
                <div>user_mdu = floor(start_offset / raw_mdu_capacity)</div>
                <div>slab_mdu = meta_mdus + user_mdu</div>
                <div>encoded_blob = floor(encoded_byte_offset / 128KiB)</div>
                <div>global_blob = slab_mdu * 64 + encoded_blob</div>
              </div>
              <div className="border border-border bg-secondary/20 p-4 text-sm leading-6 text-muted-foreground">
                Raw payload bytes are right-aligned into 32-byte field elements. That is why the raw capacity is slightly
                smaller than the 8 MiB encoded MDU.
              </div>
            </div>

            <div className="overflow-auto border border-border bg-card">
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Path
                    </th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Offset
                    </th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Size
                    </th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Slab MDUs
                    </th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Global blobs
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {exampleFiles.map((file) => {
                    const ranges = file.ranges;
                    return (
                      <tr key={file.path} className="hover:bg-muted/20">
                        <td className="whitespace-nowrap px-4 py-3 font-semibold text-foreground">{file.path}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                          {file.startOffset.toLocaleString()}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-muted-foreground">
                          {formatBytes(file.sizeBytes)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                          {ranges ? formatIntRange(ranges.slabMduStart, ranges.slabMduEnd) : "-"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                          {ranges ? formatBigintRange(ranges.globalBlobStart, ranges.globalBlobEnd) : "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="space-y-6" data-testid="polyfs-stripereplica">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
              <Split className="h-4 w-4" />
              StripeReplica
            </div>
            <h2 className="mt-2 text-2xl font-bold text-foreground md:text-3xl">Witness MDUs make striped storage verifiable</h2>
          </div>

          <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
            <div className="space-y-4">
              <p className="text-sm leading-7 text-muted-foreground">
                User data MDUs are striped across provider slots. Metadata MDUs, meaning MDU #0 and the witness region,
                are replicated to every slot. This gives each provider the local commitment map needed for
                shared-nothing proof generation.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  {
                    label: "Protocol profile",
                    value: `K=${protocolProfile.k}, M=${protocolProfile.m}, N=${protocolProfile.n}`,
                    note: `${protocolProfile.rows} rows, ${protocolProfile.leafCount} leaves`,
                  },
                  {
                    label: "Trusted devnet profile",
                    value: `K=${trustedDevnetProfile.k}, M=${trustedDevnetProfile.m}, N=${trustedDevnetProfile.n}`,
                    note: `${trustedDevnetProfile.rows} rows, ${trustedDevnetProfile.leafCount} leaves`,
                  },
                  {
                    label: "Witness bytes per user MDU",
                    value: formatBytes(witnessLayout.witnessBytesPerUserMdu),
                    note: `${witnessLayout.profile.leafCount} commitments x ${KZG_COMMITMENT_BYTES} B`,
                  },
                  {
                    label: "Example witness MDUs",
                    value: String(witnessLayout.witnessMduCount),
                    note: "for max_user_mdus = 4096",
                  },
                ].map((item) => (
                  <div key={item.label} className="border border-border bg-card p-4">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      {item.label}
                    </div>
                    <div className="mt-2 font-mono text-lg text-foreground">{item.value}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{item.note}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <Network className="h-5 w-5 text-primary" />
                <div>
                  <div className="font-bold text-foreground">Slot-major leaf ordering</div>
                  <div className="text-xs text-muted-foreground">
                    leaf_index = slot * rows + row
                  </div>
                </div>
              </div>
              <div className="mt-5 grid gap-2">
                {Array.from({ length: protocolProfile.n }).map((_, slot) => (
                  <div key={slot} className="grid grid-cols-[72px_1fr] items-center gap-3">
                    <div className="font-mono text-xs text-muted-foreground">slot {slot}</div>
                    <div className="grid grid-cols-8 gap-1">
                      {Array.from({ length: protocolProfile.rows }).map((__, row) => {
                        const leaf = leafIndexForSlotRow(protocolProfile, slot, row);
                        return (
                          <div
                            key={leaf}
                            className="flex h-7 items-center justify-center border border-border bg-background/70 font-mono text-[10px] text-muted-foreground"
                            title={`slot ${slot}, row ${row}, leaf ${leaf}`}
                          >
                            {leaf}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 border border-border bg-secondary/20 p-3 text-xs leading-5 text-muted-foreground">
                Example: in the 8+4 profile, slot 7 row 3 is leaf{" "}
                <span className="font-mono text-foreground">{protocolLeafExample}</span>. In striped proofs,
                <span className="font-mono text-foreground"> ChainedProof.blob_index</span> is interpreted as this
                leaf index.
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-6" data-testid="polyfs-verification">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
              <ShieldCheck className="h-4 w-4" />
              Verification
            </div>
            <h2 className="mt-2 text-2xl font-bold text-foreground md:text-3xl">Every served byte is checked through three proof hops</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {proofHops.map((hop, index) => (
              <div key={hop.label} className="relative border border-border bg-card p-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                    {hop.label}
                  </div>
                  {index < proofHops.length - 1 ? <ArrowRight className="hidden h-5 w-5 text-muted-foreground md:block" /> : null}
                </div>
                <div className="mt-4 text-lg font-bold text-foreground">{hop.title}</div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{hop.detail}</p>
              </div>
            ))}
          </div>
          <div className="border border-border bg-background/70 p-4 font-mono text-xs leading-6 text-foreground">
            <div>Deal.manifest_root</div>
            <div>  -&gt; MDU root at mdu_index</div>
            <div>  -&gt; blob commitment at blob_index / leaf_index</div>
            <div>  -&gt; bytes at requested range</div>
          </div>
        </section>

        <section className="space-y-6" data-testid="polyfs-generation-cas">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
              <GitBranch className="h-4 w-4" />
              Generation CAS
            </div>
            <h2 className="mt-2 text-2xl font-bold text-foreground md:text-3xl">Mutable files commit as generation swaps</h2>
          </div>
          <div className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
            <div className="space-y-4">
              <p className="text-sm leading-7 text-muted-foreground">
                PolyFS is mutable at the filesystem layer, but every committed state is content-addressed at the deal
                layer. A write produces a new slab generation and the owner signs a compare-and-swap update.
              </p>
              <div className="border border-border bg-card p-4 font-mono text-xs leading-6 text-foreground">
                <div>previous_manifest_root = H1</div>
                <div>new_manifest_root = H2</div>
                <div>chain accepts iff Deal.manifest_root == H1</div>
              </div>
              <div className="border border-border bg-secondary/20 p-4 text-sm leading-6 text-muted-foreground">
                Browser clients cache verified generations in OPFS. A user-gateway may help route, cache, or reconstruct
                slabs, but the signed owner intent is the authoritative overwrite guard.
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {generationSteps.map((step) => (
                <div key={step.label} className="border border-border bg-card p-4">
                  <div className="flex items-center gap-3">
                    <RefreshCw className="h-4 w-4 text-primary" />
                    <div className="font-bold text-foreground">{step.label}</div>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">{step.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};
