# Prompt: Fix `/gateway/upload` Hanging / Slow Canonical Ingest

## Symptom
`/gateway/upload` appears to “hang forever” for tiny files during local testing (web UI + curl).

Repro (from repo root):
```bash
./scripts/run_local_stack.sh start
timeout 600s curl --verbose -X POST \
  -F file=@README.md \
  -F owner=nil1ser7fv30x7e7xr7n62tlr7m7z07ldqj4thdezk \
  http://localhost:8080/gateway/upload
```
Observed: the request can exceed minutes; the e2e script times out; users perceive an infinite hang.

## What’s Actually Happening (Likely Root Cause)
Canonical ingest (`nil_s3/IngestNewDeal`) calls `nil_cli shard` multiple times per upload:
- User file sharding
- Witness MDU sharding (W depends on `max_user_mdus`)
- MDU #0 sharding

Each `nil_cli shard` run computes KZG commitments for 64 blobs of an 8 MiB MDU. In `nil_core`, `blob_to_commitment` currently does a naive loop of scalar multiplications:
- `nil_core/src/kzg.rs` → `blob_to_commitment()` multiplies each setup point by each scalar one-by-one (4096 scalar muls per blob × 64 blobs).
- This is ~60s per MDU on a dev laptop, so even a 1 KB file becomes multiple minutes because canonical ingest touches multiple MDUs.

Additional issues that worsen “hang” perception:
- `nil_s3` does not propagate `r.Context()` into ingest/sharding, so if the client disconnects (Ctrl+C, browser nav), the gateway continues doing expensive work anyway.
- `IngestNewDeal` shards MDU #0 using `raw=false`, causing `nil_cli` to treat an 8 MiB file as raw bytes and split into 2 MDUs (adds ~+1 MDU of work and yields a root mismatch risk).

## Goals / Acceptance Criteria
1. `README.md` upload completes in **< 60s** on a dev laptop (preferably single-digit seconds).
2. Aborted HTTP upload cancels `nil_cli` work (no “zombie” CPU burn after client disconnect).
3. Tests catch regressions:
   - JS unit tests: no indefinite hangs (upload uses fetch timeout/AbortController).
   - Go unit tests for `nil_s3`: shard subprocess cancellation/timeout is enforced.
   - `./scripts/e2e_lifecycle.sh` fails fast if upload exceeds the target (after perf fix).

## Implementation Plan (Suggested Order)

### 1) Make gateway cancellation + deadlines real (behavioral fix)
Files:
- `nil_s3/main.go`
- `nil_s3/ingest.go`
- `nil_s3/aggregate.go`

Actions:
- Thread a `context.Context` through `GatewayUpload` → `IngestNewDeal`/`IngestAppendToDeal` → `shardFile`/`aggregateRoots`.
- Replace `context.Background()` with `r.Context()` and wrap in a bounded timeout (e.g. `context.WithTimeout(r.Context(), 60*time.Second)` once perf is fixed; use a higher value while landing perf work).
- Ensure `exec.CommandContext(ctx, ...)` receives that ctx so cancel kills `nil_cli`.
- Add periodic `if ctx.Err()!=nil { return ... }` checks between steps so we stop early.

### 2) Fix the “extra MDU” bug in MDU #0 sharding (correctness + performance)
File:
- `nil_s3/ingest.go`

Action:
- When sharding MDU #0 (already an 8 MiB MDU buffer), call `shardFile(..., raw=true, ...)` so `nil_cli` does not re-encode/split it into 2 MDUs.

### 3) Speed up KZG commitments (the real perf fix)
File:
- `nil_core/src/kzg.rs`

Action options:
- Replace naive per-scalar loop in `blob_to_commitment` with a real MSM (Pippenger).
  - The easiest path is switching to `blstrs` for native builds and using `G1Projective::multi_exp(points, scalars)`.
  - Keep wasm compatibility via `cfg(target_arch="wasm32")` if needed (either keep the old path for wasm or find a wasm-safe MSM implementation).
- Optional: parallelize `mdu_to_kzg_commitments` across 64 blobs on native (e.g., `rayon`) once MSM is in place.

Perf validation:
```bash
time ./nil_cli/target/release/nil_cli --trusted-setup nilchain/trusted_setup.txt shard README.md --out /tmp/out.json
```
Target: seconds, not minutes.

### 4) Add tests that replicate “hang” and enforce timeouts

#### Go (`nil_s3`) unit tests
File:
- `nil_s3/main_test.go` (or new focused test files)

Fix existing test scaffolding:
- `TestHelperProcess` exists but `execNilCli` uses `exec.CommandContext` directly, so tests can’t mock `nil_cli`.
- Refactor so `execNilCli` (and `execNilchaind`) use an injectable command factory (e.g., `execCommandContext` var) to allow a helper process in tests.

Add tests:
- `TestShardFile_TimeoutCancels`:
  - Set `shardTimeout` to ~50ms in test.
  - Mock `nil_cli shard` helper to sleep longer than timeout.
  - Assert `shardFile` returns a timeout error quickly.
- `TestGatewayUpload_RespectsRequestCancel`:
  - Use a request with a context that is canceled immediately.
  - Assert handler returns promptly and does not create a new deal dir.
- `TestIngestNewDeal_Mdu0UsesRaw`:
  - Have helper process record args; assert `--raw` is present for mdu0 sharding.

#### JS (`nil-website`) unit tests
Files:
- `nil-website/src/hooks/useUpload.ts` (refactor)
- Add `nil-website/src/lib/http.ts` with `fetchWithTimeout()`
- Add `nil-website/src/lib/http.test.ts`

Plan:
- Implement `fetchWithTimeout(url, init, timeoutMs)` using `AbortController`.
- Make `useUpload` call it with a sane default (e.g. 60s) and surface a clear error message.
- Unit test that a never-resolving fetch is aborted and the promise rejects quickly (use small timeout in test).

### 5) Tighten the e2e gate after perf lands
File:
- `scripts/e2e_lifecycle.sh`

Change:
- Reduce upload timeout from `600s` to `<=60s` and print elapsed time.

## Notes / Gotchas
- Do not “fix” this by just increasing timeouts: the goal is to make small uploads fast and cancelable.
- Ensure changes don’t break wasm build (the website’s `predev`/`prebuild` runs `wasm-pack build`).
- Avoid leaving large `uploads/*.shard.mdu.*.bin` artifacts around in tests; use temp dirs and clean up.

