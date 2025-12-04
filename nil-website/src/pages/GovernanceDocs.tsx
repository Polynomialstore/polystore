import { Shield, Users, Lock, AlertTriangle } from "lucide-react";

export const GovernanceDocs = () => {
  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
      <div className="mb-12">
        <h1 className="text-4xl font-bold mb-4 text-slate-100">Governance & The Emergency Council</h1>
        <p className="text-xl text-muted-foreground">
          NilStore is governed by the NilDAO. To ensure safety during the "Mainnet Beta" phase, a 5-of-9 Emergency Council holds specific hot-patch powers.
        </p>
      </div>

      <div className="grid gap-12">
        {/* Structure */}
        <section className="space-y-6">
          <h2 className="text-2xl font-bold border-b pb-2 text-slate-100">DAO Structure</h2>
          
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-slate-900 p-6 rounded-xl border border-slate-800">
              <div className="flex items-center gap-3 mb-4">
                <Users className="w-6 h-6 text-blue-400" />
                <h3 className="font-bold text-lg text-slate-200">Token Holders</h3>
              </div>
              <ul className="list-disc list-inside text-sm text-slate-400 space-y-2">
                <li>Propose standard upgrades.</li>
                <li>Vote on economic parameters (Slashing, Minting).</li>
                <li>Veto Emergency Council actions.</li>
                <li><strong>Timelock:</strong> 2 Days (172800s).</li>
              </ul>
            </div>

            <div className="bg-slate-900 p-6 rounded-xl border border-slate-800">
              <div className="flex items-center gap-3 mb-4">
                <Shield className="w-6 h-6 text-red-400" />
                <h3 className="font-bold text-lg text-slate-200">Emergency Council</h3>
              </div>
              <ul className="list-disc list-inside text-sm text-slate-400 space-y-2">
                <li>5-of-9 Multisig (Alice, Bob, Auditors, Community).</li>
                <li>Can trigger "Circuit Breaker" (Pause L2 Bridge).</li>
                <li>Can propose "Hot Patches" for critical bugs.</li>
                <li><strong>Sunset:</strong> Powers expire in 14 days unless ratified.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Process */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-slate-100">Proposal Lifecycle</h2>
          <div className="relative border-l-2 border-slate-800 ml-4 space-y-8 py-4">
            <div className="ml-6">
              <h4 className="font-bold text-slate-200">1. Submission</h4>
              <p className="text-sm text-slate-400">Any user with >10,000 NIL stake can submit a proposal.</p>
            </div>
            <div className="ml-6">
              <h4 className="font-bold text-slate-200">2. Deposit Period</h4>
              <p className="text-sm text-slate-400">The proposal enters a deposit period. It needs 10M NIL total deposit to go to a vote.</p>
            </div>
            <div className="ml-6">
              <h4 className="font-bold text-slate-200">3. Voting Period</h4>
              <p className="text-sm text-slate-400">Validators and delegators vote (Yes, No, Veto, Abstain) for 2 days.</p>
            </div>
            <div className="ml-6">
              <h4 className="font-bold text-slate-200">4. Execution / Timelock</h4>
              <p className="text-sm text-slate-400">If passed, the change is queued. Code upgrades execute automatically after the timelock.</p>
            </div>
          </div>
        </section>

        {/* Verification */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-slate-100">Verify On-Chain</h2>
          <p className="text-sm text-muted-foreground">
            You can verify the current parameters and council members directly from the chain CLI.
          </p>
          <div className="bg-slate-950 p-6 rounded-xl font-mono text-sm text-slate-300 border border-slate-800">
            <p className="text-slate-500"># View Emergency Council Members</p>
            <p>$ nilchaind q group groups-by-admin [alice_addr]</p>
            <br/>
            <p className="text-slate-500"># View Governance Parameters</p>
            <p>$ nilchaind q gov params</p>
          </div>
        </section>
      </div>
    </div>
  );
};
