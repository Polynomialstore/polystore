import { motion } from "framer-motion";
import { Search, ShieldCheck, Gavel, Scale } from "lucide-react"; // Assuming lucide-react has these, if not I'll swap. Gavel/Scale/Shield/User are standard.

export const DeputySystem = () => {
  return (
    <div className="w-full">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-16"
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-red-500/10 rounded-xl border border-red-500/20 shrink-0">
            <Gavel className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-3xl font-bold text-foreground">Dispute Resolution: The Deputy System</h2>
        </div>

        <p className="text-muted-foreground leading-relaxed mb-12">
          Decentralized networks often fail when users and providers blame each other for failures ("He said, she said"). NilStore solves this without centralized courts by using a <strong>Deputy (Proxy) System</strong>.
        </p>

        {/* Section 1: The Problem */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Scale className="w-5 h-5 text-red-500" /> The "Ghosting" Problem
          </h3>
          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <div className="bg-card p-6 rounded-xl border border-border">
                <h4 className="font-bold text-foreground mb-2">Lazy Provider</h4>
                <p className="text-sm text-muted-foreground">Accepts the deal to earn storage rewards, but blocks user IPs to save bandwidth. Claims "The user is lying."</p>
            </div>
            <div className="bg-card p-6 rounded-xl border border-border">
                <h4 className="font-bold text-foreground mb-2">Malicious User</h4>
                <p className="text-sm text-muted-foreground">Spams the provider with fake complaints to try and get them slashed. Claims "The provider is offline."</p>
            </div>
          </div>
        </section>

        {/* Section 2: The Solution */}
        <section>
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <Search className="w-5 h-5 text-purple-500" /> Solution: The "Mystery Shopper"
          </h3>
          <p className="text-muted-foreground mb-6">
            Instead of a judge, the user summons a <strong>Deputy</strong> (a random third-party node) to fetch the file for them.
          </p>
          
          <div className="bg-secondary/30 p-8 rounded-2xl border border-border relative overflow-hidden">
            <div className="flex flex-col gap-8 relative z-10">
                
                {/* Step 1 */}
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center font-bold shrink-0">1</div>
                    <div className="bg-background/80 p-4 rounded-lg border border-border flex-1">
                        <strong>Escalation:</strong> User fails to connect. User broadcasts a bounty: "Pay 5 NIL to fetch Chunk X from Provider Y."
                    </div>
                </div>

                {/* Step 2 */}
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 rounded-full bg-purple-500 text-white flex items-center justify-center font-bold shrink-0">2</div>
                    <div className="bg-background/80 p-4 rounded-lg border border-border flex-1">
                        <strong>The Trap:</strong> A Deputy accepts. They generate a <strong>Fresh Ephemeral Identity</strong> (New Key/IP). They look like a brand new customer.
                    </div>
                </div>

                {/* Step 3 */}
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center font-bold shrink-0">3</div>
                    <div className="bg-background/80 p-4 rounded-lg border border-border flex-1">
                        <strong>The Dilemma:</strong> The Provider receives the request.
                        <ul className="list-disc list-inside text-sm text-muted-foreground mt-2">
                            <li>If they serve: The User gets their data (via Deputy). Problem solved.</li>
                            <li>If they ghost: The Deputy records a <strong>Verified Strike</strong>.</li>
                        </ul>
                    </div>
                </div>

            </div>
          </div>
        </section>

        {/* Section 3: Audit Debt */}
        <section className="mt-16">
          <h3 className="text-xl font-bold mb-4 flex items-center gap-2 text-foreground">
            <ShieldCheck className="w-5 h-5 text-blue-500" /> Audit Debt: Forced Participation
          </h3>
          <p className="text-muted-foreground mb-6">
            Where do Deputies come from? We <strong>conscript</strong> them. To earn mining rewards, every Storage Provider must perform X audits (act as a Deputy) per epoch. This ensures a constant, decentralized "Police Force" patroling the network.
          </p>
        </section>

      </motion.div>
    </div>
  );
};
