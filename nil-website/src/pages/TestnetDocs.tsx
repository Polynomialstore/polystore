import { Download, Terminal, Wallet, Blocks } from "lucide-react";
import { FileSharder } from "../components/FileSharder";
import { FaucetWidget } from "../components/FaucetWidget";
import { appConfig } from "../config";

export const TestnetDocs = () => {
  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
      <div className="mb-12">
        <h1 className="text-4xl font-bold mb-4 text-foreground">Testnet Launch Guide (v0.1.1)</h1>
        <p className="text-xl text-muted-foreground">
          Welcome to "Store Wars". This guide covers everything you need to participate: installing the release binaries, getting testnet funds, and running your first deal.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          For the multi-provider devnet join flow, see <a className="text-primary underline" href="/#/devnet">Devnet Join</a>.
        </p>
      </div>

      <div className="grid gap-12">
        
        {/* Quick Start */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground flex items-center gap-2">
            <Download className="w-6 h-6 text-blue-500" /> Quick Start
          </h2>
          <p className="text-muted-foreground">
            Since the network is in active development, we recommend building from source.
          </p>
          
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-card p-6 rounded-xl border border-border hover:border-primary/50 transition-all">
              <h3 className="font-bold text-lg text-foreground">1. Build & Run Chain (EVM enabled)</h3>
              <div className="mt-2 font-mono text-sm text-muted-foreground space-y-2 bg-secondary/30 p-4 rounded overflow-x-auto">
                <p className="text-green-400"># Clone Repository</p>
                <p>$ git clone https://github.com/Nil-Store/nil-store.git</p>
                <p>$ cd nil-store/nilchain</p>
                <br/>
                <p className="text-green-400"># Build & Install</p>
                <p>$ make install</p>
                <br/>
                <p className="text-green-400"># Initialize & Start</p>
                <p>$ nilchaind init my-node --chain-id test-1</p>
                <p>$ nilchaind genesis add-genesis-account $WALLET 100000000000stake,1000000000000000000000aatom --home ~/.nilchain --keyring-backend test</p>
                <p>$ nilchaind genesis gentx $WALLET 50000000000stake --chain-id test-1 --keyring-backend test</p>
                <p>$ nilchaind genesis collect-gentxs</p>
                <p className="text-yellow-500"># Enable EVM/JSON-RPC in app.toml</p>
                <p>$ sed -i '' 's/enable = false/enable = true/' ~/.nilchain/config/app.toml</p>
                <p>$ nilchaind start --minimum-gas-prices 0.001aatom</p>
              </div>
            </div>
            <div className="bg-card p-6 rounded-xl border border-border hover:border-primary/50 transition-all">
              <h3 className="font-bold text-lg text-foreground">2. Run Faucet</h3>
              <p className="text-sm text-muted-foreground mb-2">To use the website's "Get Funds" button, you must run the local faucet API.</p>
              <div className="mt-2 font-mono text-sm text-muted-foreground space-y-2 bg-secondary/30 p-4 rounded overflow-x-auto">
                <p className="text-green-400"># In a new terminal window</p>
                <p>$ ./scripts/run_local_stack.sh start</p>
                <br/>
                <p className="text-yellow-500 text-xs"># Note: Ensure 'faucet' key exists in keyring (keyring-backend test)</p>
              </div>
            </div>
            <div className="bg-card p-6 rounded-xl border border-border hover:border-primary/50 transition-all md:col-span-2">
              <h3 className="font-bold text-lg text-foreground">3. Deploy Contracts (Optional)</h3>
              <p className="text-sm text-muted-foreground mb-2">To enable future bridge features, deploy the smart contracts to the local EVM.</p>
              <div className="mt-2 font-mono text-sm text-muted-foreground space-y-2 bg-secondary/30 p-4 rounded overflow-x-auto">
                <p className="text-green-400"># Requires Foundry (forge)</p>
                <p>$ cd nil-store/nil_bridge</p>
                <p>$ forge script script/Deploy.s.sol --rpc-url {appConfig.evmRpc} --broadcast --private-key &lt;YOUR_PRIVATE_KEY&gt;</p>
              </div>
            </div>
          </div>
        </section>

        {/* Web Flow */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground">Web Flow (MetaMask + Faucet + Deal)</h2>
          <p className="text-muted-foreground">
            With the faucet running, the Dashboard now lets you connect MetaMask, request funds (0x or nil1 address), and submit a storage deal directly from the browser. Deals are broadcast by the faucet service using its local keyring for now.
          </p>
          <div className="bg-secondary/10 rounded-xl p-4 border border-border/50 font-mono text-sm text-muted-foreground space-y-2">
            <p>$ # in nil_faucet/</p>
            <p>$ NIL_CHAIN_ID=test-1 NIL_HOME=$HOME/.nilchain NIL_DENOM=stake NIL_AMOUNT=1000000stake go run main.go</p>
            <p># Open http://localhost:5173/#/dashboard and click "Get Testnet NIL" then "Submit Deal"</p>
          </div>
        </section>

        {/* EVM Integration */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground flex items-center gap-2">
            <Blocks className="w-6 h-6 text-indigo-500" /> EVM Integration (MetaMask)
          </h2>
          <p className="text-muted-foreground">
            NilChain is now fully EVM compatible. You can connect standard Ethereum tools directly to the network.
          </p>
          
          <div className="bg-gradient-to-br from-indigo-950/30 to-purple-950/30 p-6 rounded-xl border border-indigo-500/30">
            <h3 className="font-bold text-lg text-white mb-4">Network Settings</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                    <span className="text-gray-400 block">Network Name</span>
                    <span className="font-mono text-indigo-300">NilChain Local</span>
                </div>
                <div>
                    <span className="text-gray-400 block">RPC URL</span>
                    <span className="font-mono text-indigo-300">{appConfig.evmRpc}</span>
                </div>
                <div>
                    <span className="text-gray-400 block">Chain ID</span>
                    <span className="font-mono text-indigo-300">{appConfig.chainId}</span>
                </div>
                <div>
                    <span className="text-gray-400 block">Currency Symbol</span>
                    <span className="font-mono text-indigo-300">NIL</span>
                </div>
            </div>
            <div className="mt-6 pt-4 border-t border-indigo-500/20">
                <p className="text-sm text-gray-400 mb-2">
                    <strong>Tip:</strong> Click "Connect Wallet" in the top-right corner of this site to auto-add this network to MetaMask. The UI now drives faucet and storage-deal submission end-to-end.
                </p>
            </div>
          </div>
        </section>

        {/* Faucet & Wallet */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground flex items-center gap-2">
            <Wallet className="w-6 h-6 text-yellow-500" /> Wallet & Faucet
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
                <h3 className="font-bold text-foreground">1. Get a Wallet</h3>
                <p className="text-sm text-muted-foreground">
                    <strong>EVM:</strong> Use MetaMask or Rabbi.
                    <br/>
                    <strong>Cosmos:</strong> Use Keplr or Leap.
                </p>
                <p className="text-sm text-muted-foreground">
                    Alternatively, for CLI users:
                </p>
                <div className="bg-secondary/20 p-3 rounded font-mono text-xs">
                    $ ./bin/nilchaind keys add my-wallet
                </div>
            </div>
            <div className="space-y-4">
                <h3 className="font-bold text-foreground flex items-center gap-2">
                    2. Request Funds
                </h3>
                <p className="text-sm text-muted-foreground">
                    Click below to receive 10 NIL testnet tokens directly to your connected wallet (EVM or Cosmos).
                </p>
                <div className="p-4 bg-secondary/10 rounded-xl border border-border/50 flex flex-col items-center justify-center gap-2">
                    <FaucetWidget />
                    <p className="text-xs text-muted-foreground mt-2 text-center">
                        Works with both 0x... and nil1... addresses.
                    </p>
                </div>
            </div>
          </div>
        </section>

        {/* Section 0: Playground */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-green-400">Interactive Playground</h2>
          <p className="text-muted-foreground">
            Experience the "Sharding & Binding" process directly in your browser. Upload any file to see how the NilStore protocol splits it into 8 MiB Data Units (DUs) and computes the cryptographic binding for each.
          </p>
          <FileSharder />
        </section>

        {/* For Providers */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground flex items-center gap-2">
            <Terminal className="w-6 h-6 text-purple-500" /> Run a Provider Node
          </h2>
          <p className="text-muted-foreground">
            To participate as a Storage Provider (Miner), you must register on-chain and keep your node online.
          </p>
          
          <div className="bg-card p-6 rounded-xl border border-border space-y-6 font-mono text-sm">
            <div>
                <p className="text-muted-foreground"># 1. Initialize Node</p>
                <p>$ ./bin/nilchaind init my-node --chain-id nilchain</p>
            </div>
            <div>
                <p className="text-muted-foreground"># 2. Register Identity</p>
                <p>$ ./bin/nilchaind tx nilchain register-provider General 1000000000 \</p>
                <p>&nbsp;&nbsp;--from my-wallet --chain-id nilchain --yes</p>
            </div>
            <div>
                <p className="text-muted-foreground"># 3. Start Node</p>
                <p>$ ./bin/nilchaind start</p>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
};
