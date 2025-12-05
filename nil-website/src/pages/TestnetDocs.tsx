import { Download, Terminal, Wallet, Coins, Blocks } from "lucide-react";
import { FileSharder } from "../components/FileSharder";

export const TestnetDocs = () => {
  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
      <div className="mb-12">
        <h1 className="text-4xl font-bold mb-4 text-foreground">Testnet Launch Guide (v0.1.0-rc1)</h1>
        <p className="text-xl text-muted-foreground">
          Welcome to "Store Wars". This guide covers everything you need to participate: installing the release binaries, getting testnet funds, and running your first deal.
        </p>
      </div>

      <div className="grid gap-12">
        
        {/* Quick Start */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground flex items-center gap-2">
            <Download className="w-6 h-6 text-blue-500" /> Quick Start
          </h2>
          <p className="text-muted-foreground">
            We provide pre-compiled binaries for macOS (Apple Silicon) and Linux (AMD64/ARM64).
          </p>
          
          <div className="grid md:grid-cols-2 gap-6">
            <a href="#" className="bg-card p-6 rounded-xl border border-border hover:border-primary/50 transition-all group">
              <h3 className="font-bold text-lg text-foreground group-hover:text-primary">Download Release Tarball</h3>
              <p className="text-sm text-muted-foreground mt-2">Includes `nilchaind`, `nil_cli`, and `nil_faucet`.</p>
              <div className="mt-4 text-xs font-mono bg-secondary/50 p-2 rounded">
                v0.1.0-rc1-Darwin-arm64.tar.gz (73MB)
              </div>
            </a>
            <div className="bg-card p-6 rounded-xl border border-border">
              <h3 className="font-bold text-lg text-foreground">Installation</h3>
              <div className="mt-2 font-mono text-sm text-muted-foreground space-y-2">
                <p>$ tar -xvf nilstore-*.tar.gz</p>
                <p>$ cd dist</p>
                <p>$ ./bin/nilchaind start</p>
              </div>
            </div>
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
                    <span className="font-mono text-indigo-300">http://localhost:8545</span>
                </div>
                <div>
                    <span className="text-gray-400 block">Chain ID</span>
                    <span className="font-mono text-indigo-300">9000</span>
                </div>
                <div>
                    <span className="text-gray-400 block">Currency Symbol</span>
                    <span className="font-mono text-indigo-300">NIL</span>
                </div>
            </div>
            <div className="mt-6 pt-4 border-t border-indigo-500/20">
                <p className="text-sm text-gray-400 mb-2">
                    <strong>Tip:</strong> Click "Connect Wallet" in the top-right corner of this site to auto-add this network to MetaMask.
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
                    2. Request Funds <Coins className="w-4 h-4 text-yellow-500"/>
                </h3>
                <p className="text-sm text-muted-foreground">
                    You can request funds for either your Cosmos (nil1...) or Ethereum (0x...) address. They share the same balance.
                </p>
                <div className="bg-secondary/20 p-3 rounded font-mono text-xs">
                    $ curl -X POST http://localhost:8081/faucet \<br/>
                    &nbsp;&nbsp;-d '{'{'}"address": "nil1... or 0x..."{'}'}'
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