**Prompt for the Next Agent:**

We have successfully debugged and fixed the `nilchain` Cosmos SDK application simulation tests.

**Current Status:**
1.  **Simulation Tests Passing:** `TestFullAppSimulation`, `TestAppImportExport`, `TestAppSimulationAfterImport`, and `TestAppStateDeterminism` are all PASSING.
2.  **Fix Implemented:** The panic in `app.go` was caused by `app.App` (the embedded `*runtime.App`) being nil because `appBuilder.Build(...)` was accidentally removed during the EVM disabling process. We restored this call.
3.  **EVM Disabled:** The EVM and FeeMarket modules remain disabled in `app_config.go` and `app.go` to avoid the `MsgEthereumTx` signer panic in simulations.
4.  **Codebase:** `nilchain/app/app.go` is clean and compiles.

**Repository Context:**
-   The `nilchain` directory is the focus.
-   EVM integration is currently commented out.

**Next Steps / Potential Goals:**
-   If the goal is to re-enable EVM, you will need to address the `MsgEthereumTx` signer panic in `depinject` or find a way to exclude `MsgEthereumTx` from simulation transaction generation while keeping the module loaded.
-   Otherwise, continue with other development tasks on `nilchain` knowing the base simulation is stable.

**To Run Tests:**
`cd nilchain && go test ./app -v -Enabled=true -NumBlocks=100 -BlockSize=200 -Commit=true -Period=5`
