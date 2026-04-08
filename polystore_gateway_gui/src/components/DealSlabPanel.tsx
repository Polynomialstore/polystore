import { useMemo, useState } from "react";
import type { GatewayFileEntry, GatewayUploadResponse } from "../lib/gateway";

const DEFAULT_MDU_SIZE_BYTES = 8 * 1024 * 1024;
const DEFAULT_BLOB_SIZE_BYTES = 128 * 1024;
const DEFAULT_BLOBS_PER_MDU = DEFAULT_MDU_SIZE_BYTES / DEFAULT_BLOB_SIZE_BYTES;

type SlabFileRow = {
  entry: GatewayFileEntry;
  path: string;
  sizeBytes: number;
  startOffset: number;
  startMduIndex: number;
  endMduIndex: number;
  startBlobGlobal: bigint;
  endBlobGlobal: bigint;
};

function formatIntRange(start: number, end: number): string {
  if (start === end) return `#${start}`;
  return `#${start}..#${end}`;
}

function formatBigintRange(start: bigint, end: bigint): string {
  if (start === end) return start.toString();
  return `${start.toString()}..${end.toString()}`;
}

function copyToClipboard(value: string): void {
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "-9999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }
}

export function DealSlabPanel(props: {
  gatewayOnline: boolean;
  listBusy: boolean;
  listError: string | null;
  downloadBusyPath: string | null;
  downloadError: string | null;
  dealId: string;
  owner: string;
  manifestRoot: string;
  files: GatewayFileEntry[];
  uploadResponse: GatewayUploadResponse | null;
  onChangeDealId: (next: string) => void;
  onChangeOwner: (next: string) => void;
  onChangeManifestRoot: (next: string) => void;
  onLoadFiles: () => void;
  onDownload: (entry: GatewayFileEntry) => void;
  onLearnMdus: () => void;
}) {
  const {
    gatewayOnline,
    listBusy,
    listError,
    downloadBusyPath,
    downloadError,
    dealId,
    owner,
    manifestRoot,
    files,
    uploadResponse,
    onChangeDealId,
    onChangeOwner,
    onChangeManifestRoot,
    onLoadFiles,
    onDownload,
    onLearnMdus,
  } = props;

  const [activeTab, setActiveTab] = useState<"overview" | "files" | "mdus">(
    "overview",
  );
  const [witnessOverride, setWitnessOverride] = useState<string>("");
  const [mduInspectorIndex, setMduInspectorIndex] = useState<string>("");

  const inferred = useMemo(() => {
    const normalizedManifest = manifestRoot.trim().toLowerCase();
    const uploadMatches =
      uploadResponse &&
      uploadResponse.manifest_root.trim().toLowerCase() === normalizedManifest;

    const parsedOverride = Number(witnessOverride);
    const overrideOk =
      witnessOverride.trim() !== "" &&
      Number.isFinite(parsedOverride) &&
      parsedOverride >= 0;

    const witnessMdus = overrideOk
      ? Math.floor(parsedOverride)
      : uploadMatches
        ? uploadResponse?.witness_mdus ?? null
        : null;

    const totalMdus = uploadMatches ? uploadResponse?.total_mdus ?? null : null;

    const metaMdus = witnessMdus !== null ? 1 + witnessMdus : 1;
    const userMdus =
      totalMdus !== null && witnessMdus !== null
        ? Math.max(0, totalMdus - metaMdus)
        : null;

    const mduSizeBytes = DEFAULT_MDU_SIZE_BYTES;
    const blobSizeBytes = DEFAULT_BLOB_SIZE_BYTES;
    const blobsPerMdu = DEFAULT_BLOBS_PER_MDU;

    const fileRows: SlabFileRow[] = (files ?? [])
      .filter((f) => Boolean(f?.path))
      .map((f) => {
        const sizeBytes = Number(f.size_bytes ?? 0);
        const startOffset = Number(f.start_offset ?? 0);
        const safeSize = Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0;
        const safeStart = Number.isFinite(startOffset)
          ? Math.max(0, startOffset)
          : 0;

        const endOffset = safeSize > 0 ? safeStart + safeSize - 1 : safeStart;
        const startUserMdu = Math.floor(safeStart / mduSizeBytes);
        const endUserMdu = Math.floor(endOffset / mduSizeBytes);
        const startMduIndex = metaMdus + startUserMdu;
        const endMduIndex = metaMdus + endUserMdu;

        const startBlobInMdu = Math.floor(
          (safeStart % mduSizeBytes) / blobSizeBytes,
        );
        const endBlobInMdu = Math.floor(
          (endOffset % mduSizeBytes) / blobSizeBytes,
        );

        const startBlobGlobal =
          BigInt(startMduIndex) * BigInt(blobsPerMdu) + BigInt(startBlobInMdu);
        const endBlobGlobal =
          BigInt(endMduIndex) * BigInt(blobsPerMdu) + BigInt(endBlobInMdu);

        return {
          entry: f,
          path: f.path,
          sizeBytes: safeSize,
          startOffset: safeStart,
          startMduIndex,
          endMduIndex,
          startBlobGlobal,
          endBlobGlobal,
        };
      });

    const usedMduMin =
      fileRows.length > 0
        ? Math.min(...fileRows.map((r) => r.startMduIndex))
        : null;
    const usedMduMax =
      fileRows.length > 0
        ? Math.max(...fileRows.map((r) => r.endMduIndex))
        : null;

    return {
      uploadMatches,
      witnessMdus,
      totalMdus,
      metaMdus,
      userMdus,
      mduSizeBytes,
      blobSizeBytes,
      blobsPerMdu,
      fileRows,
      usedMduMin,
      usedMduMax,
    };
  }, [files, manifestRoot, uploadResponse, witnessOverride]);

  const inspector = useMemo(() => {
    const parsed = Number(mduInspectorIndex);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    const idx = Math.floor(parsed);
    const startBlob = BigInt(idx) * BigInt(inferred.blobsPerMdu);
    const endBlob = startBlob + BigInt(inferred.blobsPerMdu - 1);
    return { idx, startBlob, endBlob };
  }, [inferred.blobsPerMdu, mduInspectorIndex]);

  return (
    <div className="metric-card industrial-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b subtle-divider px-3 py-2">
        <div>
          <p className="soft-label">Deal storage layout (Slab / MDUs)</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            MDU education lives on the Technology page. This panel focuses on
            visibility and developer-grade ranges.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="control-btn control-btn-inline"
            onClick={onLearnMdus}
          >
            Learn MDUs
          </button>
          <button
            type="button"
            className="control-btn control-btn-inline"
            onClick={() => copyToClipboard(manifestRoot)}
            disabled={!manifestRoot.trim()}
            title="Copy manifest root"
          >
            Copy root
          </button>
        </div>
      </div>

      <div className="px-3 py-3 space-y-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px]">
          <label className="text-xs font-semibold text-muted-foreground">
            Manifest root
            <input
              className="font-mono-data mt-1 w-full rounded-none border border-border/40 bg-muted/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40"
              value={manifestRoot}
              onChange={(event) => onChangeManifestRoot(event.target.value)}
              placeholder="0x…"
            />
          </label>
          <label className="text-xs font-semibold text-muted-foreground">
            Deal ID / Owner
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              <input
                className="font-mono-data w-full rounded-none border border-border/40 bg-muted/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40"
                value={dealId}
                onChange={(event) => onChangeDealId(event.target.value)}
                placeholder="123"
              />
              <input
                className="font-mono-data w-full rounded-none border border-border/40 bg-muted/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40"
                value={owner}
                onChange={(event) => onChangeOwner(event.target.value)}
                placeholder="nil1…"
              />
            </div>
          </label>
          <div className="flex items-end gap-2">
            <button
              type="button"
              className="control-btn control-btn-primary control-btn-inline w-full"
              onClick={onLoadFiles}
              disabled={!gatewayOnline || listBusy}
              title="Calls /gateway/list-files to derive file → MDU ranges"
            >
              {listBusy ? "Loading..." : "Load files"}
            </button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="glass-panel industrial-border px-3 py-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Constants
            </p>
            <p className="mt-1 text-xs text-foreground font-mono-data">
              mdu_size={inferred.mduSizeBytes.toLocaleString()} · blob_size=
              {inferred.blobSizeBytes.toLocaleString()} · blobs_per_mdu=
              {inferred.blobsPerMdu}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground/60">
              Retrieval sessions and receipts often reference global blob indices.
            </p>
          </div>
          <div className="glass-panel industrial-border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Slab breakdown
              </p>
              {!inferred.uploadMatches ? (
                <span className="font-mono-data border border-border bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground tracking-[0.18em]">
                  best-effort
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-foreground font-mono-data">
              meta=1 · witness=
              {inferred.witnessMdus !== null ? inferred.witnessMdus : "?"} ·
              user=
              {inferred.userMdus !== null ? inferred.userMdus : "?"} · total=
              {inferred.totalMdus !== null ? inferred.totalMdus : "?"}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground/60">
              Override witness MDUs if you loaded a manifest without an upload
              response.
            </p>
          </div>
          <div className="glass-panel industrial-border px-3 py-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Witness override (optional)
            </p>
            <input
              className="font-mono-data mt-1 w-full rounded-none border border-border/40 bg-muted/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40"
              value={witnessOverride}
              onChange={(event) =>
                setWitnessOverride(event.target.value.replace(/[^\d]/g, ""))
              }
              placeholder="e.g. 8"
            />
          </div>
        </div>

        {listError ? (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive font-mono-data">
            {listError}
          </div>
        ) : null}

        {downloadError ? (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive font-mono-data">
            {downloadError}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {(["overview", "files", "mdus"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              className={[
                "panel-tab",
                tab === activeTab ? "panel-tab-active" : "",
              ].join(" ")}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "overview"
                ? "Overview"
                : tab === "files"
                  ? `Files (${inferred.fileRows.length})`
                  : "MDUs"}
            </button>
          ))}
        </div>

        {activeTab === "overview" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="glass-panel industrial-border px-3 py-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Artifact map
              </p>
              <ul className="mt-1 space-y-1 text-xs text-foreground">
                <li>
                  <span className="font-semibold">MDU #0</span>: NilFS metadata
                  (file table + root table)
                </li>
                <li>
                  <span className="font-semibold">Witness MDUs</span>: blob
                  commitments for user data MDUs
                </li>
                <li>
                  <span className="font-semibold">User MDUs</span>: file bytes
                  laid out by NilFS offsets
                </li>
              </ul>
            </div>
            <div className="glass-panel industrial-border px-3 py-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Used range (from list-files)
              </p>
              <p className="mt-1 text-xs text-foreground font-mono-data">
                {inferred.usedMduMin !== null && inferred.usedMduMax !== null
                  ? formatIntRange(inferred.usedMduMin, inferred.usedMduMax)
                  : "Load files to derive the used MDU range."}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/60">
                Meta MDUs assumed as {inferred.metaMdus} (1 + witness).
              </p>
            </div>
          </div>
        ) : null}

        {activeTab === "files" ? (
          <div className="glass-panel industrial-border">
            <div className="font-mono-data grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr_auto] gap-2 border-b subtle-divider px-3 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              <span>Path</span>
              <span className="text-right">Bytes</span>
              <span className="text-right">Start offset</span>
              <span className="text-right">MDUs</span>
              <span className="text-right">Actions</span>
            </div>
            {inferred.fileRows.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground font-mono-data">
                No file rows yet. Load files from the gateway to derive MDU
                ranges.
              </div>
            ) : (
              inferred.fileRows.map((row) => (
                <div
                  key={row.path}
                  className="grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr_auto] gap-2 border-b border-border/20 px-3 py-2 text-xs text-foreground last:border-b-0"
                >
                  <span className="truncate font-mono-data font-medium text-foreground">
                    {row.path}
                  </span>
                  <span className="text-right tabular-nums font-mono-data">
                    {row.sizeBytes.toLocaleString()}
                  </span>
                  <span className="text-right tabular-nums font-mono-data">
                    {row.startOffset.toLocaleString()}
                  </span>
                  <span className="text-right font-mono-data text-[11px]">
                    {formatIntRange(row.startMduIndex, row.endMduIndex)}
                  </span>
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      className="control-btn control-btn-inline px-2 py-1 text-[10px]"
                      onClick={() => onDownload(row.entry)}
                      disabled={!gatewayOnline || downloadBusyPath === row.path}
                      title="Download via /gateway/fetch"
                    >
                      {downloadBusyPath === row.path ? "Saving..." : "Download"}
                    </button>
                    <button
                      type="button"
                      className="control-btn control-btn-inline px-2 py-1 text-[10px]"
                      onClick={() =>
                        copyToClipboard(
                          `${row.path} mdus=${formatIntRange(row.startMduIndex, row.endMduIndex)} blobs=${formatBigintRange(row.startBlobGlobal, row.endBlobGlobal)}`,
                        )
                      }
                      title="Copy MDU + blob ranges"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {activeTab === "mdus" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="glass-panel industrial-border px-3 py-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Slab map (MDU #0..#63)
              </p>

              <div className="mt-2 grid grid-cols-8 gap-1">
                {Array.from({ length: 64 }, (_, idx) => {
                  const allocated = inferred.totalMdus === null ? true : idx < inferred.totalMdus;
                  const isMeta = idx === 0;
                  const isWitness =
                    inferred.witnessMdus !== null && idx > 0 && idx < inferred.metaMdus;
                  const isUser =
                    inferred.userMdus !== null &&
                    idx >= inferred.metaMdus &&
                    idx < inferred.metaMdus + inferred.userMdus;

                  const inUsedRange =
                    inferred.usedMduMin !== null &&
                    inferred.usedMduMax !== null &&
                    idx >= inferred.usedMduMin &&
                    idx <= inferred.usedMduMax;

                  const role = !allocated
                    ? "unallocated"
                    : isMeta
                      ? "meta"
                      : isWitness
                        ? "witness"
                        : isUser
                          ? "user"
                          : "unknown";

                  const cellClass = !allocated
                    ? "border-border/10 bg-muted/10 opacity-40"
                    : isMeta
                      ? "border-primary/60 bg-primary/30"
                      : isWitness
                        ? "border-accent/50 bg-accent/20"
                        : isUser
                          ? "border-emerald-400/50 bg-emerald-500/25"
                          : "border-border/40 bg-muted/20";

                  return (
                    <div
                      key={`mdu-cell-${idx}`}
                      className={[
                        "h-6 w-6 border rounded-none",
                        cellClass,
                        inUsedRange ? "shadow-[0_0_0_1px_hsl(var(--primary)/0.3)]" : "",
                      ].join(" ")}
                      title={`MDU #${idx} · ${role}`}
                    />
                  );
                })}
              </div>

              <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-mono-data font-bold uppercase tracking-[0.18em] text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 border border-primary/60 bg-primary/30" /> MDU0
                </span>
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 border border-accent/50 bg-accent/20" /> Witness
                </span>
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 border border-emerald-400/50 bg-emerald-500/25" /> User
                </span>
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 border border-border/40 bg-muted/20" /> ?
                </span>
              </div>

              <p className="mt-2 text-[11px] text-muted-foreground/60">
                Totals inferred from the most recent upload response (when available). Used range
                comes from list-files.
              </p>
            </div>

            <div className="grid gap-3">
              <div className="glass-panel industrial-border px-3 py-2">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Ranges
                </p>
                <div className="mt-1 space-y-1 text-xs text-foreground font-mono-data">
                  <p>
                    meta: <span>#0</span>
                  </p>
                  <p>
                    witness:{" "}
                    <span>
                      {inferred.witnessMdus !== null
                        ? inferred.witnessMdus === 0
                          ? "—"
                          : `#1..#${inferred.witnessMdus}`
                        : "?"}
                    </span>
                  </p>
                  <p>
                    user:{" "}
                    <span>
                      {inferred.userMdus !== null
                        ? inferred.userMdus === 0
                          ? "—"
                          : `#${inferred.metaMdus}..#${inferred.metaMdus + inferred.userMdus - 1}`
                        : "?"}
                    </span>
                  </p>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground/60">
                  If totals are unknown, use list-files derived ranges instead.
                </p>
              </div>

              <div className="glass-panel industrial-border px-3 py-2">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  MDU inspector
                </p>
                <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <input
                    className="font-mono-data w-full rounded-none border border-border/40 bg-muted/20 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40"
                    value={mduInspectorIndex}
                    onChange={(event) =>
                      setMduInspectorIndex(event.target.value.replace(/[^\d]/g, ""))
                    }
                    placeholder="MDU index (e.g. 12)"
                  />
                  <button
                    type="button"
                    className="control-btn control-btn-inline"
                    onClick={() => {
                      if (!inspector) return;
                      copyToClipboard(
                        `mdu=${inspector.idx} blobs=${formatBigintRange(inspector.startBlob, inspector.endBlob)}`,
                      );
                    }}
                    disabled={!inspector}
                    title="Copy global blob range for this MDU"
                  >
                    Copy
                  </button>
                </div>
                <p className="mt-2 text-xs text-foreground font-mono-data break-all">
                  {inspector
                    ? `global_blobs: ${formatBigintRange(inspector.startBlob, inspector.endBlob)}`
                    : "Enter an MDU index to compute its global blob range."}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground font-mono-data">
                  global_blob = mdu_index * {inferred.blobsPerMdu} + blob_index
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
