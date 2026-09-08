Bounded native CPU diagnostic

One benchmark process exited successfully in 13.675 seconds with GOMAXPROCS=2. The 10-second sample contains 6506 native opening stack observations: 3819 (58.70%) in custom Pippenger MSM, 2659 (40.87%) in scalar inversion, and 28 elsewhere.

The benchmark reports 6.261000166 seconds of fresh generation for 52 openings (120.404ms/opening). These are preparation timings, excluded from keeper acceptance. The sample contains no setup initialization/loader observations; this does not establish zero setup cost or an exact end-to-end setup fraction. Warmup and subsequent preparation are not separately timestamped.

The measured bottleneck is recurring native opening arithmetic, so serial generation optimization is justified for evaluation before adding a parallel pool. Source pointers: polystore_core/src/kzg.rs:680 and:708 perform repeated scalar inversion, :727 calls custom MSM, :1268 defines that MSM; ffi.rs:33 retains setup OnceLock. No code changed, no service started, no comparison or capacity qualification.
