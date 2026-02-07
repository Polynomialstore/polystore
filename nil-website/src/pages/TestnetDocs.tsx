import { Download, Terminal, Wallet, Blocks } from "lucide-react";
import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { FileSharder } from "../components/FileSharder";
import { FaucetWidget } from "../components/FaucetWidget";
import { FaucetAuthTokenInput } from "../components/FaucetAuthTokenInput";
import { appConfig } from "../config";
import { ethToNil } from "../lib/address";
import { lcdFetchDeals } from "../api/lcdClient";
import type { LcdDeal as Deal } from "../domain/lcd";

export const TestnetDocs = () => {
  const { address } = useAccount();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [targetDealId, setTargetDealId] = useState("");
  const gatewayGuiReleaseUrl = "https://github.com/Nil-Store/nil-store/releases/latest";

  useEffect(() => {
    if (address) {
      const cosmosAddress = ethToNil(address);
      lcdFetchDeals(appConfig.lcdBase).then((all) => {
        const filtered = all.filter((d) => d.owner === cosmosAddress);
        setDeals(filtered);
      });
    } else {
      setDeals([]);
      setTargetDealId("");
    }
  }, [address]);

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
            For chain/provider operators we recommend building from source. Browser users can install the local Gateway app from releases.
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
              <h3 className="font-bold text-lg text-foreground">2. Run Faucet (Optional)</h3>
              <p className="text-sm text-muted-foreground mb-2">
                The faucet is a dev-only helper. On trusted-devnet public domains (for example
                <code className="mx-1 px-1 py-0.5 rounded bg-secondary/60">*.nilstore.org</code>) the UI enables faucet by default.
                You can always override with
                <code className="mx-1 px-1 py-0.5 rounded bg-secondary/60">VITE_ENABLE_FAUCET=1|0</code>.
              </p>
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
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground">Web Flow (MetaMask + Deal)</h2>
          <p className="text-muted-foreground">
            All on-chain actions (create, update content, retrieval sessions) are signed by your wallet via the NilStore precompile.
            The faucet is dev-only; the "Get Testnet NIL" button is auto-enabled on trusted-devnet public domains and can be forced with
            <code className="mx-1 px-1 py-0.5 rounded bg-secondary/60">VITE_ENABLE_FAUCET=1</code>
            or hidden with
            <code className="mx-1 px-1 py-0.5 rounded bg-secondary/60">VITE_ENABLE_FAUCET=0</code>.
          </p>
          <p className="text-sm text-muted-foreground">
            The browser client can shard and commit using WASM + OPFS. The local Gateway runs on localhost (not a shared public service).
            If no local gateway is running, uploads still work via in-browser sharding and direct provider transport.
          </p>
          <div className="rounded-xl border border-border/60 bg-secondary/10 p-4 text-sm text-muted-foreground">
            <div className="font-semibold text-foreground">Local Gateway (recommended)</div>
            <div className="mt-1">
              Install <code className="px-1 py-0.5 rounded bg-secondary/60">nil_gateway_gui</code>, start it, then refresh this page.
              The website probes <code className="mx-1 px-1 py-0.5 rounded bg-secondary/60">http://localhost:8080</code> only.
            </div>
            <a
              href={gatewayGuiReleaseUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center rounded-md border border-border bg-background/70 px-3 py-2 text-xs font-semibold text-foreground hover:bg-secondary/50"
            >
              Download Nil Gateway GUI
            </a>
          </div>
          <div className="bg-secondary/10 rounded-xl p-4 border border-border/50 font-mono text-sm text-muted-foreground space-y-2">
            <p>$ # (optional) in nil_faucet/</p>
            <p>$ NIL_CHAIN_ID=test-1 NIL_HOME=$HOME/.nilchain NIL_DENOM=stake NIL_AMOUNT=1000000stake go run main.go</p>
            <p># Open http://localhost:5173/#/dashboard and click "Submit Deal"</p>
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
                    <strong>Tip:</strong> Click "Connect Wallet" in the top-right corner of this site to auto-add this network to MetaMask. The UI drives wallet-signed transactions; relay/faucet are optional dev helpers.
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
                    If enabled, the faucet will send testnet tokens to your connected wallet (EVM or Cosmos).
                </p>
                <div className="p-4 bg-secondary/10 rounded-xl border border-border/50 flex flex-col items-center justify-center gap-2">
                    <FaucetWidget />
                    {appConfig.faucetEnabled ? <FaucetAuthTokenInput className="w-full" /> : null}
                    <p className="text-xs text-muted-foreground mt-2 text-center">
                        Works with both 0x... and nil1... addresses when the faucet is enabled.
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
          
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 text-sm">
                <label className="space-y-1">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">Target Deal ID</span>
                    <select 
                        value={targetDealId} 
                        onChange={e => setTargetDealId(e.target.value)}
                        className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                    >
                        <option value="">Select a Deal...</option>
                        {deals.map(d => (
                            <option key={d.id} value={d.id}>
                              Deal #{d.id} ({d.cid ? 'Active' : 'Empty'})
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {targetDealId ? (
                <FileSharder dealId={targetDealId} />
            ) : (
                <div className="p-8 text-center border border-dashed border-border rounded-xl">
                    <p className="text-muted-foreground text-sm">Select a deal to begin client-side sharding.</p>
                </div>
            )}
          </div>
        </section>

        {/* For Providers */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground flex items-center gap-2">
            <Terminal className="w-6 h-6 text-purple-500" /> Run a Provider Node
          </h2>
          <p className="text-muted-foreground">
            To participate as a Storage Provider (SP), run <code className="px-1 py-0.5 rounded bg-secondary/60">nil_gateway</code> in provider mode and register at least one public endpoint on-chain.
          </p>

          <div className="bg-card p-6 rounded-xl border border-border space-y-6 text-sm">
            <div className="space-y-2">
              <h3 className="font-bold text-foreground">Endpoint Types</h3>
              <p className="text-muted-foreground">
                For testnet onboarding, keep it simple:
              </p>
              <ul className="list-disc pl-5 text-muted-foreground space-y-1">
                <li><strong>direct</strong> (recommended): SP has an open port on a public IP / port-forward; expose <code className="px-1 py-0.5 rounded bg-secondary/60">https://sp.example.com</code> via a reverse proxy.</li>
                <li><strong>cloudflare-tunnel</strong> (fallback): SP is behind NAT; expose <code className="px-1 py-0.5 rounded bg-secondary/60">https://sp.example.com</code> via Cloudflare Tunnel (no router changes).</li>
                <li><strong>webrtc</strong> (future): NAT traversal optimization; not testnet-blocking.</li>
              </ul>
              <p className="text-muted-foreground">
                The chain stores endpoints as multiaddrs. Use <code className="px-1 py-0.5 rounded bg-secondary/60">nil_gateway --print-endpoints</code> to generate the exact <code className="px-1 py-0.5 rounded bg-secondary/60">--endpoint</code> value to register.
              </p>
            </div>

            <div className="space-y-2">
              <h3 className="font-bold text-foreground">1) Run the SP Gateway</h3>
              <div className="font-mono text-xs text-muted-foreground space-y-2 bg-secondary/30 p-4 rounded overflow-x-auto">
                <p className="text-green-400"># Run provider-mode gateway on the SP machine</p>
                <p>$ cd nil_gateway</p>
                <p>$ NIL_LISTEN_ADDR=:8082 NIL_GATEWAY_ROUTER=0 go run .</p>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-bold text-foreground">2A) direct (reverse proxy on 443)</h3>
              <p className="text-muted-foreground">
                If the SP has an open inbound port, terminate TLS on 443 and proxy to <code className="px-1 py-0.5 rounded bg-secondary/60">localhost:8082</code>. Example with Caddy:
              </p>
              <div className="font-mono text-xs text-muted-foreground space-y-2 bg-secondary/30 p-4 rounded overflow-x-auto">
                <p>$ caddy reverse-proxy --from sp.example.com --to localhost:8082</p>
                <p className="text-green-400"># Print the multiaddr to register</p>
                <p>$ NIL_PUBLIC_HTTP_HOST=sp.example.com NIL_PUBLIC_HTTP_SCHEME=https NIL_PUBLIC_HTTP_PORT=443 \\</p>
                <p>&nbsp;&nbsp;go run . --print-endpoints</p>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-bold text-foreground">2B) cloudflare-tunnel (no open ports)</h3>
              <p className="text-muted-foreground">
                If the SP cannot open inbound ports, use Cloudflare Tunnel to expose <code className="px-1 py-0.5 rounded bg-secondary/60">https://sp.example.com</code> (bytes will transit Cloudflare).
              </p>
              <div className="font-mono text-xs text-muted-foreground space-y-2 bg-secondary/30 p-4 rounded overflow-x-auto">
                <p className="text-green-400"># One-time setup (Cloudflare account + DNS)</p>
                <p>$ cloudflared tunnel login</p>
                <p>$ cloudflared tunnel create nilstore-sp</p>
                <p>$ cloudflared tunnel route dns nilstore-sp sp.example.com</p>
                <p className="text-green-400"># Run the tunnel (ingress to the local gateway)</p>
                <p>$ cloudflared tunnel run nilstore-sp</p>
                <p className="text-green-400"># Print the multiaddr to register</p>
                <p>$ NIL_CLOUDFLARE_TUNNEL_HOSTNAME=sp.example.com go run . --print-endpoints</p>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="font-bold text-foreground">3) Register Provider Endpoint On-Chain</h3>
              <p className="text-muted-foreground">
                Copy the printed <code className="px-1 py-0.5 rounded bg-secondary/60">--endpoint</code> line(s) and register the provider:
              </p>
              <div className="font-mono text-xs text-muted-foreground space-y-2 bg-secondary/30 p-4 rounded overflow-x-auto">
                <p>$ nilchaind tx nilchain register-provider General 1099511627776 \\</p>
                <p>&nbsp;&nbsp;--from &lt;your-key&gt; --chain-id {appConfig.cosmosChainId} --yes \\</p>
                <p>&nbsp;&nbsp;--endpoint &quot;/dns4/sp.example.com/tcp/443/https&quot;</p>
              </div>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
};
