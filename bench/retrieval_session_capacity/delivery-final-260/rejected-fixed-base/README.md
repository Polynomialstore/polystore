# Rejected fixed-base WASM comparison

Base `5b1d77d11432cf83c8c1e1abe57d09c139605e9c`; [temporary patch](experiment.patch) was removed after measurement. No production change was selected. The installed blst 0.3.16 fixed-base API computes the same individual commitments and validates every canonical field cell before table allocation.

[Raw decision](decision.json), [toolchain](toolchain.json), and all observations are retained. Each run used a fresh Node process and WASM instance. [Initial 3 MiB](4.json) and [6 MiB](5.json) medians were 42% and 28% slower. The [initial three 12 MiB pairs](6.json) were 4% slower; [five alternating-order pairs](6-five.json) were 3% faster. An independent [portable-probe five-pair rerun](6-portable-check.json) yielded only 0.7% median improvement (240.541 ms baseline, 238.949 ms fixed-base). This inconsistent benefit does not justify a 12 MiB table and 694.633 ms cold first commitment, excluding context initialization. There is no dependable break-even. Using only the optimistic second medians gives approximately 63 blobs; the first comparison gives none.

Exact commitment parity passed deterministic AES nonconstant data, zero, sparse, and all cells at r−1. Both paths rejected invalid length and r in the last cell. These are differential regression checks, not a cryptographic soundness proof. Received-byte binding and challenge verification remain unchanged.

The 12 MiB run raised WASM linear-memory high-water from 4,456,448 to 17,104,896 bytes. Table sizes are exact; the context additionally needs 576 KiB scratch and 128 KiB scalar buffer. Linear-memory high-water and whole-process Node maxRSS are not retained-table measurements. These local Node timings are not hosted browser or public delivery qualification.

## Reproduce the rejected experiment

Use an isolated checkout at the base above; apply `experiment.patch` there with `git apply`. The patch is evidence, not a production recommendation. From that checkout, use a new task-owned target/output directory and the recorded toolchain:

```sh
CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang CARGO_BUILD_JOBS=2 CARGO_NET_OFFLINE=true CARGO_TARGET_DIR="$EXPERIMENT_DIR/target" wasm-pack build polystore_core --release --target web --no-opt --out-dir "$EXPERIMENT_DIR/wasm" --out-name polystore_core
node "$EVIDENCE_DIR/probe-initial.mjs" 4 "$EXPERIMENT_DIR/wasm" polystore-website/public/trusted_setup.txt
node "$EVIDENCE_DIR/probe-initial.mjs" 5 "$EXPERIMENT_DIR/wasm" polystore-website/public/trusted_setup.txt
node "$EVIDENCE_DIR/probe-initial.mjs" 6 "$EXPERIMENT_DIR/wasm" polystore-website/public/trusted_setup.txt
node "$EVIDENCE_DIR/probe.mjs" 6 "$EXPERIMENT_DIR/wasm" polystore-website/public/trusted_setup.txt
```

Set `EXPERIMENT_DIR` to the new absolute task-owned directory and `EVIDENCE_DIR` to this evidence directory before running. The recorded build used a 10-minute timeout and a 1 GiB free-space floor; retain those limits. Apple clang lacked a wasm32 backend; installed Homebrew LLVM succeeded in 13 seconds. Exact experimental WASM SHA-256: `bbaba13c061af65832d198944a8fa5b02c7d995fa6a136c7b12f2052eb034127`; the raw files also pin setup and generated fixture hashes. The portable probes accept asset paths as arguments; algorithm and fixtures match the recorded probes.
