# Gateway Mode-2 Throughput Harness

This harness drives the end-to-end Mode-2 ingest path (`/gateway/upload`) and emits
structured telemetry for `kzg` + stripe throughput experiments.

- Generates random payload files with `dd` for reproducible load (`/dev/urandom`).
- Creates a mode-2 deal via `/gateway/create-deal` (`General:rs=8+4` by default).
- Uploads each payload to `/gateway/upload?deal_id=...&upload_id=...`.
- Persists:
  - `${prefix}-${run_id}.csv` (summary row format)
  - `${prefix}-${run_id}.jsonl` (full payload + run metadata)
  - `${prefix}-${run_id}.summary.json` (run-level aggregate)

## Quick start

```bash
./performance/gateway_mode2_benchmark.sh \
  --sizes "64,128,256,512" \
  --iterations 2 \
  --gateway http://localhost:8080
```

Artifacts are written to `.artifacts/gateway_mode2_benchmark` by default.

## Typical workflow

1. Start your gateway and provider stack normally.
2. Ensure tx-relay is enabled for create-deal (the current `gateway create-deal` endpoint is tx-relayed).
3. Run with target sizes:
   - `./performance/gateway_mode2_benchmark.sh --sizes "32,128,256"`
4. Compare:
   - `mode2_encode_user_mdus_ms`
   - `mode2_build_witness_mdus_ms`
   - `mode2_build_manifest_ms`
   - `mode2_upload_requests_ms`
   - `mode2_upload_retries`

Throughput is computed from `gateway_total_ms` and `file_size_bytes` as:

```
MiB/s = file_size_bytes / (1024*1024) / (gateway_total_ms / 1000)
```

## Runtime options

See `--help` in the script for all options and supported env overrides.

### Environment knobs

- `GATEWAY_MODE2_BENCH_SIZES` (e.g. `32,64,128`)
- `GATEWAY_MODE2_BENCH_ITERATIONS`
- `GATEWAY_MODE2_BENCH_SERVICE_HINT`
- `GATEWAY_MODE2_BENCH_UPLOAD_TIMEOUT_SECONDS`
- `GATEWAY_MODE2_BENCH_OUTPUT_DIR`
- `GATEWAY_MODE2_BENCH_PREFIX`
