import { LatticeMap } from "../components/LatticeMap";
import { FileSharder } from "../components/FileSharder";

export const TestnetDocs = () => {
  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
      <div className="mb-12">
        <h1 className="text-4xl font-bold mb-4 text-foreground">NilStore Incentivized Testnet (Phase 3)</h1>
        <p className="text-xl text-muted-foreground">
          Welcome to "Store Wars". This documentation details how to run the entire stack locally: the L1 Chain (Cosmos SDK), the Cryptography Core (Rust), the L2 Bridge (Foundry), and the Visualizer (React).
        </p>
      </div>

      <div className="grid gap-12">
        {/* Section 0: Playground */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-green-400">Interactive Playground</h2>
          <p className="text-muted-foreground">
            Experience the "Sharding & Binding" process directly in your browser. Upload any file to see how the NilStore protocol splits it into 128 KiB Data Units (DUs) and computes the cryptographic binding for each.
          </p>
          <FileSharder />
        </section>

        {/* Section 1: Architecture Overview */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground">System Architecture & Behaviors</h2>
          <div className="grid md:grid-cols-3 gap-6 mt-4">
            <div className="bg-secondary/20 p-6 rounded-lg border">
              <h3 className="font-bold text-lg mb-2">1. NilChain (L1)</h3>
              <p className="text-sm text-muted-foreground mb-2">
                <strong>Stack:</strong> Cosmos SDK, Go, Ignite.
              </p>
              <p className="text-sm text-muted-foreground">
                <strong>Behavior:</strong> The L1 is the source of truth. It uses <code>CGO</code> to call into the Rust Core for proof verification. When a valid proof is submitted via <code>MsgSubmitProof</code>, the module <strong>mints 1 NIL</strong> token and sends it to the prover.
              </p>
            </div>
            <div className="bg-secondary/20 p-6 rounded-lg border">
              <h3 className="font-bold text-lg mb-2">2. Cryptography Core</h3>
              <p className="text-sm text-muted-foreground mb-2">
                <strong>Stack:</strong> Rust (FFI), KZG, Argon2id.
              </p>
              <p className="text-sm text-muted-foreground">
                <strong>Behavior:</strong> Compiled as a static library (<code>libnil_core.a</code>). It handles the heavy lifting: verifying the KZG commitments against the trusted setup parameters to ensure data availability.
              </p>
            </div>
            <div className="bg-secondary/20 p-6 rounded-lg border">
              <h3 className="font-bold text-lg mb-2">3. L2 Bridge</h3>
              <p className="text-sm text-muted-foreground mb-2">
                <strong>Stack:</strong> Solidity, Foundry.
              </p>
              <p className="text-sm text-muted-foreground">
                <strong>Behavior:</strong> Acts as an Oracle. It receives state roots from the L1 validators and allows Ethereum smart contracts to verify that a file exists on NilStore using standard Merkle Proofs.
              </p>
            </div>
          </div>
        </section>

        {/* Section 2: Developer Setup Guide */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground">Developer Setup Guide</h2>
          <p className="text-muted-foreground">
            Follow these steps to build and run the entire stack from source.
          </p>
          
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold text-green-400 mb-2">Step 1: Build the Cryptography Core (Rust)</h3>
              <p className="text-sm mb-2">We must compile the Rust library first so the Go chain can link against it.</p>
              <div className="bg-slate-900 text-slate-50 p-4 rounded-lg font-mono text-sm overflow-x-auto">
                <p>$ cd nil_core</p>
                <p>$ cargo build --release</p>
                <p className="text-slate-500"># Generates target/release/libnil_core.a</p>
              </div>
            </div>

            <div>
              <h3 className="text-lg font-semibold text-green-400 mb-2">Step 2: Build & Run L1 Chain (Custom Binary)</h3>
              <p className="text-sm mb-2">
                We cannot use standard `ignite chain serve` because it won't link our Rust library. We must build manually.
              </p>
              <div className="bg-slate-900 text-slate-50 p-4 rounded-lg font-mono text-sm overflow-x-auto">
                <p>$ cd ../nilchain</p>
                <p className="text-slate-500"># 1. Copy trusted setup</p>
                <p>$ cp ../demos/kzg/trusted_setup.txt .</p>
                <br/>
                <p className="text-slate-500"># 2. Build Custom Binary with CGO Linking</p>
                <p>$ export CGO_LDFLAGS="-L$(pwd)/../nil_core/target/release -lnil_core"</p>
                <p>$ go build -v ./cmd/nilchaind</p>
                <br/>
                <p className="text-slate-500"># 3. Initialize Config (if first time)</p>
                <p>$ ignite chain serve --reset-once</p>
                <p className="text-yellow-400"># WAIT for it to start, then Press Ctrl+C to stop it immediately.</p>
                <br/>
                <p className="text-slate-500"># 4. Start the Chain using OUR binary</p>
                <p>$ ./nilchaind start</p>
              </div>
              <p className="text-sm mt-2 italic text-slate-400">
                <strong>Note:</strong> <code>./nilchaind start</code> uses the config created by Ignite in step 3.
              </p>
            </div>

            <div>
              <h3 className="text-lg font-semibold text-green-400 mb-2">Step 3: Run the Visualizer</h3>
              <p className="text-sm mb-2">Open a new terminal tab.</p>
              <div className="bg-slate-900 text-slate-50 p-4 rounded-lg font-mono text-sm overflow-x-auto">
                <p>$ cd ../nil-website</p>
                <p>$ npm install</p>
                <p>$ npm run dev</p>
              </div>
              <p className="text-sm mt-2 italic text-slate-400">
                <strong>Behavior:</strong> Open <code>localhost:5173</code>. You will see the "Nil-Lattice" map.
              </p>
            </div>
          </div>
        </section>

        {/* Section 3: Live Lattice Status */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground">Live Network Status</h2>
          <p className="text-sm text-muted-foreground">
            Below is the live visualization of the local testnet. Submitting a proof via CLI will update this map in real-time.
          </p>
          <LatticeMap />
        </section>

        {/* Section 4: Demo Interaction */}
        <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-foreground">Interactive Demo</h2>
            <p className="text-sm">To simulate a storage node submitting a proof, run this command in a new terminal (ensure you are in the <code>nilchain</code> directory):</p>
            <div className="bg-slate-900 text-slate-50 p-4 rounded-lg font-mono text-sm overflow-x-auto">
                <p className="text-slate-500"># Submit a valid "Non-Zero" proof (generated from Rust core)</p>
                <p>$ ./nilchaind tx nilchain submit-proof \</p>
                <p>  877a8a151198b0face7c5a12d1c02ed9f1570ac3c859719e00edd120e35183db0a69e68ba394f341eee8d629b10ee6a3 \</p>
                <p>  0a00000000000000000000000000000000000000000000000000000000000000 \</p>
                <p>  547e3ff09598a939051a5d3af5767c49beb4763ada0daea6a53675650f562673 \</p>
                <p>  ab91c229c5c40c56dff69aec2b96d17d1fc368731ecf6a422f910e9da88b980a5b616c4633d155075521d602d9a1e161 \</p>
                <p>  --from alice --chain-id nilchain --yes</p>
            </div>
            <p className="text-sm mt-4 font-bold">Expected Result:</p>
            <ul className="list-disc list-inside ml-4 mt-1 text-sm text-muted-foreground">
                <li>Transaction is included in a block.</li>
                <li>Logs show: <code>DEBUG: nil_init called...</code> and <code>KZG Proof VALID</code>.</li>
                <li>The proof appears in the "Live Network Status" map above.</li>
                </ul>
        </section>

        {/* Section 5: Automated End-to-End Testing */}
        <section className="space-y-4">
            <h2 className="text-2xl font-bold border-b pb-2 text-foreground">Automated End-to-End Testing</h2>
            <p className="text-sm">
                To run a full end-to-end test of the entire stack (Rust core build, Go chain build, chain startup, and valid proof submission) use the provided `e2e_test.sh` script. This script verifies all components are working together correctly.
            </p>
            <div className="bg-slate-900 text-slate-50 p-4 rounded-lg font-mono text-sm overflow-x-auto">
                <p>$ chmod +x e2e_test.sh</p>
                <p>$ ./e2e_test.sh</p>
            </div>
            <p className="text-sm mt-4">
                <strong>Expected Result:</strong>
                <ul className="list-disc list-inside ml-4 mt-1 text-muted-foreground">
                    <li>The script will build `nil_core` and `nilchaind`.</li>
                    <li>It will start `nilchaind` in the background, submit a valid proof, query its status, and check the chain logs for successful verification.</li>
                    <li>Output will end with `[E2E] Test Completed Successfully.`</li>
                </ul>
            </p>
        </section>

      </div>
    </div>
  );
};
