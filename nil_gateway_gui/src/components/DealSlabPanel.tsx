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
    <div className="metric-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b subtle-divider px-3 py-2">
        <div>
          <p className="soft-label">Deal storage layout (Slab / MDUs)</p>
          <p className="mt-0.5 text-xs text-slate-500">
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
          <label className="text-xs font-semibold text-slate-500">
            Manifest root
            <input
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              value={manifestRoot}
              onChange={(event) => onChangeManifestRoot(event.target.value)}
              placeholder="0x…"
            />
          </label>
          <label className="text-xs font-semibold text-slate-500">
            Deal ID / Owner
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              <input
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                value={dealId}
                onChange={(event) => onChangeDealId(event.target.value)}
                placeholder="123"
              />
              <input
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
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
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
              Constants
            </p>
            <p className="mt-1 text-xs text-slate-700">
              mdu_size={inferred.mduSizeBytes.toLocaleString()} · blob_size=
              {inferred.blobSizeBytes.toLocaleString()} · blobs_per_mdu=
              {inferred.blobsPerMdu}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Retrieval sessions and receipts often reference global blob indices.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                Slab breakdown
              </p>
              {!inferred.uploadMatches ? (
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                  best-effort
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-slate-700">
              meta=1 · witness=
              {inferred.witnessMdus !== null ? inferred.witnessMdus : "?"} ·
              user=
              {inferred.userMdus !== null ? inferred.userMdus : "?"} · total=
              {inferred.totalMdus !== null ? inferred.totalMdus : "?"}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Override witness MDUs if you loaded a manifest without an upload
              response.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
              Witness override (optional)
            </p>
            <input
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              value={witnessOverride}
              onChange={(event) =>
                setWitnessOverride(event.target.value.replace(/[^\d]/g, ""))
              }
              placeholder="e.g. 8"
            />
          </div>
        </div>

        {listError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {listError}
          </div>
        ) : null}

        {downloadError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {downloadError}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {(["overview", "files", "mdus"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              className={[
                "rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors",
                tab === activeTab
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
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
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                Artifact map
              </p>
              <ul className="mt-1 space-y-1 text-xs text-slate-700">
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
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                Used range (from list-files)
              </p>
              <p className="mt-1 text-xs text-slate-700">
                {inferred.usedMduMin !== null && inferred.usedMduMax !== null
                  ? formatIntRange(inferred.usedMduMin, inferred.usedMduMax)
                  : "Load files to derive the used MDU range."}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Meta MDUs assumed as {inferred.metaMdus} (1 + witness).
              </p>
            </div>
          </div>
        ) : null}

        {activeTab === "files" ? (
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr_auto] gap-2 border-b subtle-divider px-3 py-2 text-[11px] font-semibold text-slate-500">
              <span>Path</span>
              <span className="text-right">Bytes</span>
              <span className="text-right">Start offset</span>
              <span className="text-right">MDUs</span>
              <span className="text-right">Actions</span>
            </div>
            {inferred.fileRows.length === 0 ? (
              <div className="px-3 py-3 text-xs text-slate-500">
                No file rows yet. Load files from the gateway to derive MDU
                ranges.
              </div>
            ) : (
              inferred.fileRows.map((row) => (
                <div
                  key={row.path}
                  className="grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr_auto] gap-2 border-b border-slate-100 px-3 py-2 text-xs text-slate-700 last:border-b-0"
                >
                  <span className="truncate font-medium text-slate-900">
                    {row.path}
                  </span>
                  <span className="text-right tabular-nums">
                    {row.sizeBytes.toLocaleString()}
                  </span>
                  <span className="text-right tabular-nums">
                    {row.startOffset.toLocaleString()}
                  </span>
                  <span className="text-right font-mono text-[11px]">
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
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                Ranges
              </p>
              <div className="mt-1 space-y-1 text-xs text-slate-700">
                <p>
                  meta: <span className="font-mono">#0</span>
                </p>
                <p>
                  witness:{" "}
                  <span className="font-mono">
                    {inferred.witnessMdus !== null
                      ? inferred.witnessMdus === 0
                        ? "—"
                        : `#1..#${inferred.witnessMdus}`
                      : "?"}
                  </span>
                </p>
                <p>
                  user:{" "}
                  <span className="font-mono">
                    {inferred.userMdus !== null
                      ? inferred.userMdus === 0
                        ? "—"
                        : `#${inferred.metaMdus}..#${inferred.metaMdus + inferred.userMdus - 1}`
                      : "?"}
                  </span>
                </p>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                If totals are unknown, use list-files derived ranges instead.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                MDU inspector
              </p>
              <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <input
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
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
              <p className="mt-2 text-xs text-slate-700">
                {inspector
                  ? `global_blobs: ${formatBigintRange(inspector.startBlob, inspector.endBlob)}`
                  : "Enter an MDU index to compute its global blob range."}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                global_blob = mdu_index * {inferred.blobsPerMdu} + blob_index
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
