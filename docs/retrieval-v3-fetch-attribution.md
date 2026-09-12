# V3 fetch attribution (#342)

Phase 1: instrumentation and measurement coverage only. No new key/address
cache, admission reordering, concurrency increase, parser replacement, payment
change, or deployment change. The local fixture below does not establish the
deployed bottleneck or justify a product optimization. [#342](https://github.com/Polynomialstore/polystore/issues/342)
remains open for real-route bounded repeats, matched 1 GiB attribution, cost
ranking and a measured optimization/no-optimization disposition. [#343](https://github.com/Polynomialstore/polystore/issues/343)
owns final retained paid end-to-end qualification after that disposition.

## Actual route and safety boundaries

The provider public path is `GatewayMdu` → V2 lookup (not found) → V3 lookup →
`serveFrozenRetrievalDataV3` → `prepareRetrievalDataV3` → multipart response.
Crucially, `GatewayMdu` admits the response **before** either chain lookup or
actual signing-key resolution. The inner admission call reuses that token. The
admission is nonblocking: rejection has no queued wait, and the token remains
held through response writing. Looking only at the inner helper gives the wrong
ordering. Key resolution remains per request, including repeated chunks, and
still checks the actual key plus any configured address override.

The user-gateway first resolves frozen authority and its payee, then resolves the
provider endpoint and proxies the response. It does not use its own signing key
to authorize provider data. Its LCD and proxy phases are separate from the
provider's phases. Existing endpoint caching is unchanged.

The browser keeps its existing two-chunk prefetch bound within an obligation.
Whole-chunk integrity verification still precedes any decode/write. Successful
writes, durable flush, and checkpoint advance still precede the obligation ACK.
Body reading and multipart parsing now have separate child spans; no buffers or
copies were removed. The public parser still bounds and validates the same
response, binds it to the frozen request, and returns it to the existing verifier.

## Enable and collect

Server diagnostics are **off by default**. Set
`POLYSTORE_RETRIEVAL_DIAGNOSTICS=1` in an explicitly scoped diagnostic run of the
provider-daemon and/or user-gateway. A client request cannot enable them. V2 and
requests without one canonical V3 session identifier do not activate this path.
Enabling observation does not change authority, retry, journal or settlement
decisions. Disable the variable after collection; no persistent per-session
diagnostic state is retained by the server.

Each observed request emits one `retrieval_v3_diagnostic` JSON completion record
through the existing logger. Records have a fixed phase vocabulary and no
chain ID, account address, key name, file path, URL, error text or payload.
Explicit `session_id` and numeric-coordinate `chunk_id` fields correlate the
existing public request identifiers; they are not metric labels. Treat these
records as access-log data and apply normal access controls/retention. No new
global session-cardinality metric registry is introduced.

The response also exposes a bounded `Server-Timing` snapshot through CORS.
Names beginning `ps3p_` belong to the provider; `ps3g_` belong to the
user-gateway. Proxying preserves provider metrics and appends gateway metrics.
Only completed pre-body phases appear there. Final `write`, `proxy`, and
`route_ms` are available in server completion logs, **not** in pre-body headers.
The proxy wrapper preserves its flush and `io.ReaderFrom` paths and counts bytes
and errors without adding a response buffer.

Use the existing optional browser hook
`window.__polystoreRetrievalDiagnostic` to collect events. A bounded example for
a single diagnostic attempt (report any dropped events):

```js
const retrievalEvents = [];
let droppedRetrievalEvents = 0;
window.__polystoreRetrievalDiagnostic = (event) => {
  if (retrievalEvents.length < 50000) retrievalEvents.push(event);
  else droppedRetrievalEvents++;
};
// After saving the run's events and drop count:
delete window.__polystoreRetrievalDiagnostic;
```

This is an observational hook; observer exceptions cannot change retrieval
success/failure. Do not use it to make payment/recovery decisions. Provider
headers are untrusted observations, not timing attestations. The browser accepts
only fixed names and bounded numeric values from at most 4096 header characters;
unknown/duplicate metrics and malformed values are ignored.

## Schema and timing interpretation

Server JSON schema version `1`:

- `version`, `role` (`provider-daemon` or `user-gateway`), canonical `session_id`,
  optional `chunk_id` (`slot:first_t:last_t`).
- `status`: HTTP status written by this handler; `0` means no header was written
  before its completion observer ran, not success.
- `response_bytes`: bytes accepted by the response writer, not acknowledged
  network delivery or logical file bytes.
- `response_error`: a write, forwarded copy, or supported flush returned an
  error; an HTTP 200 with this flag is not a completed download.
- `route_ms`: this handler's elapsed monotonic time, excluding completion-log
  serialization and later socket/browser work.
- `phases`: fixed-name entries containing `calls` and cumulative `ms`.

`Server-Timing` entries use `dur` for milliseconds and the decimal `desc` string
for the matching call count, e.g. `ps3p_lcd;dur=2.500;desc="2"`. Durations use
Go's local monotonic clock; no start/end wall-clock timestamps are exported.

| Phase | Measured boundary; what its count means |
| --- | --- |
| `admission` | Non-reused capacity check, including busy/canceled rejection; inner reuse does not increment it |
| `lcd` | Each `readLCDJSON` HTTP attempt through bounded response reading/validation; includes the V2-not-found fallback, not just the V3 query |
| `keys` | Actual `resolveKeyAddress` dispatch through address extraction; one `keys show` attempt, never an environment-address substitute |
| `generation` | Retained generation lookup and lease acquisition |
| `metadata` | Authenticated generation-metadata lookup/preparation, including existing cache/coalescing behavior |
| `index` | Integrity-index lookup/validation or cold construction; warm calls still validate the index |
| `read` | Requested shard-range read helper invocation; one per chunk |
| `hash` | Requested blob integrity-leaf hashing; one per returned blob |
| `path` | Integrity-path read plus root verification; one per returned blob |
| `encode` | Bounded response-metadata JSON serialization |
| `write` | Multipart response construction/write completion; server log only |
| `endpoint` | User-gateway endpoint resolution, including existing cache behavior |
| `proxy` | User-gateway upstream HTTP transfer, response copy and flush; server log only |

These are logical operation counts, **not physical disk syscall counts**.
Metadata/index preparation may perform many underlying reads. Count cold index
scans separately with OS profiling when needed. Context freezing, remaining
authority checks, path hex encoding, other bookkeeping and scheduling are
residual route time. Do not assume phases exhaust `route_ms` or sum across
hosts: gateway proxy time contains provider work and network transfer.

Browser schema retains `atMs` (`performance.now()`), `phase`, optional `edge`,
`sessionId`, `chunkId` and `slot`. New `body_read` spans cover bounded response
stream consumption; `multipart_parse` covers framing, platform FormData parsing,
metadata JSON parsing and the payload slice. These are children of the existing
`chunk_transport` span. Existing `browser_verify`, `decode_write`, `flush`,
`verified_write`, `flushed`, `verified_chunk` and ACK/settlement events remain
unchanged. Concurrent chunk spans overlap; do not sum them as wall time.

Server observations appear as `server_provider_<phase>` or
`server_gateway_<phase>` browser events with `durationMs` and `calls`, no `edge`.
Their browser `atMs` is the observation time, not a server timestamp. Join by
session/chunk, compare durations locally, and never subtract server and browser
timestamps. First verified write is the first actual `verified_write` event,
not response headers/TTFB; durable progress additionally requires `flushed` and
the checkpoint event.

## Bounded local fixture and reproduction

`BenchmarkRetrievalV3PublicRouteAttribution` covers the entire provider public
handler with real generated V3 artifacts and all chunks of 1 KiB and two-user-MDU
logical files (16,252,928 bytes). The fixture has one `0x5a` byte followed by
zeros; it is deliberately **not** representative independent content entropy.
No compression is applied. Concurrency is one request, not the browser's two
prefetches or a CDN load. The 1 KiB file requires one 128 KiB blob/chunk; the
two-MDU file uses sixteen 1 MiB chunks (128 blobs).

It uses loopback HTTP LCD fixtures, stubs the key-process boundary, discards
response writes, and discards the log sink after formatting. It excludes real
chain RPC cost, actual process/keyring startup, response socket backpressure,
browser parsing/verifying/writing/flushing, session open, ACK and settlement.
Go allocations include the fixture LCD server, HTTP requests and diagnostics,
not only the provider. Fixture creation is outside timing. Cold preparation
removes only this fixture's metadata-cache entry and rebuildable index before
each logical read; **OS page caches and native crypto setup are still warm**.
Warm preparation keeps both. This is neither a paid-load baseline nor a measured
instrumentation-on/off overhead comparison.

From `polystore_gateway`, with the matching native library already built:

```sh
GOMAXPROCS=2 go test -p 2 . -run '^$' -bench '^BenchmarkRetrievalV3PublicRouteAttribution$' -benchmem -benchtime=3x -count=3 -timeout=60s
```

For the recorded macOS run, the exact environment was:

```sh
env GOMAXPROCS=2 CGO_LDFLAGS='-L/Users/michaelseiler/dev/polynomialstore/polystore-160m-final/polystore_core/target/release -lpolystore_core' DYLD_LIBRARY_PATH=/Users/michaelseiler/dev/polynomialstore/polystore-160m-final/polystore_core/target/release go test -p 2 . -run '^$' -bench '^BenchmarkRetrievalV3PublicRouteAttribution$' -benchmem -benchtime=3x -count=3 -timeout=60s
```

The diagnostic sample and exact code revision are recorded in
[the benchmark output](benchmarks/retrieval-v3-attribution-342.txt). It is a
small local phase-coverage check, not retained qualification evidence.

Local diagnostic medians (three repeats of three iterations, Apple M3 / Go
1.25.5 / 16 GiB RAM, development host not isolated from other work):

| Logical fixture | Preparation | Handler ms/op | Fixture reads/s | Go B/op | Go allocs/op |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 KiB / 1 chunk | cold metadata/index | 19.868 | 50.33 | 33,923,120 | 2,831 |
| 1 KiB / 1 chunk | warm | 0.615 | 1,625.80 | 278,642 | 2,034 |
| two MDUs / 16 chunks | cold metadata/index | 53.710 | 18.62 | 59,203,053 | 100,124 |
| two MDUs / 16 chunks | warm | 34.230 | 29.21 | 23,340,058 | 98,696 |

Fixture reads/s is the reciprocal of median handler seconds/op: one logical
fixture read invokes the public handler once or sixteen times, respectively.
It measures only this stubbed/discarded-response fixture, **not paid-service
throughput, sessions/s or network-delivered downloads/s**.

One complete fixture read reported respectively 2 / 32 LCD calls and 1 / 16 key
dispatches, matching the actual chunk counts. Cold-local metadata/index work and
warm per-blob work are now visible, but the stubbed key and discarded body phases
cannot rank production bottlenecks. Timing variation on this non-isolated host
is another reason not to derive capacity or an optimization claim from these
small samples. The reciprocal fixture rate must not be extrapolated to deployed
throughput or daily paid capacity.

## Remaining #342 attribution and the #343 qualification gate

For independent paid reads / CDN-style distribution, a repeated verified local
download is not a new paid session. Use the existing public settled-cache purge
action when a genuinely new paid read is required; never delete unfinished
payment/checkpoint journals. Record new session IDs and proof-confirmed outcomes.
Keep repeated-content cache reuse, independent paid objects, and concurrent
distinct requesters as separate workload cases.

After the instrumentation is merged, #342 uses the existing public browser
workload on a quiet runner, starting with real 1 KiB and multi-MDU warm/cold
downloads and then matched 1 GiB attribution. Rank the measured costs before
selecting any minimal fix or issuing a measured no-optimization disposition.
The stub-key/discarded-response fixture above does not satisfy that gate.
Record exact revisions, hardware, fixture entropy/compression, direct vs
gateway routing, chunk counts/concurrency, authority RPC attempts, actual CLI
process counts, real keyring/configuration, server CPU/RSS/Go heap and allocations,
physical I/O, browser first verified write, durable verified throughput, and
complete paid qualification time. For browser allocation/GC, collect a supported
heap/allocation timeline; if unavailable, explicitly report that limit and use
bounded retained-buffer accounting plus browser-process RSS/GC observations.
Neither substitute proves JS allocation counts. A matched diagnostics-on/off
comparison is still missing and blocks #342's measured closure: establish its
overhead before treating enabled real-route times as a baseline or issuing the
measured disposition. The phase-coverage sample above does not fill this gap.

Remaining gaps here: no giant-range browser allocation/GC profile, real
keys-show timings, production RPC/network latency, socket backpressure, actual
browser durable flush cost, peak resident memory, sustained concurrency or new
proof-confirmed capacity result. The historical 601.477 s composite chunk phase
is still not attribution to a single cause, and the earlier 840 s test bound is
not an SLA. These missing real-route costs remain part of #342; #343's final
qualification is gated on its measured disposition, not the phase-1 merge.
No defensible end-to-end optimization is selected by this instrumentation-only
PR. Any later key reuse must define
rotation/config invalidation and preserve actual submission signer checks; any
copy/concurrency change must preserve bounded buffers, cancellation/recovery,
whole-chunk verification and durable-before-ACK ordering.
