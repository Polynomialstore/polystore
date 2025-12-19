import { type ReactNode } from "react";
import { motion } from "framer-motion";
import { Shield, CheckCircle2, AlertTriangle, HardDrive, Lock, WifiOff, Gavel, Layers, KeyRound, Server, Router } from "lucide-react";

export const Security = () => {
  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-5xl">
      <div className="mb-12">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10">
            <Shield className="w-7 h-7 text-emerald-400" />
          </div>
          <h1 className="text-4xl font-bold text-foreground">Security & Threat Model</h1>
        </div>
        <p className="text-muted-foreground text-lg leading-relaxed">
          NilStore assumes untrusted providers and adversarial networks. Security is enforced by on-chain deal state,
          KZG commitments, and retrieval-session accounting. This page summarizes the threat model and the concrete
          mechanisms that keep storage and retrieval verifiable.
        </p>
      </div>

      <section className="bg-card border border-border rounded-2xl p-6 shadow-sm mb-12">
        <h2 className="text-2xl font-bold text-foreground mb-4">Threat Model (Assumptions)</h2>
        <div className="grid md:grid-cols-2 gap-4 text-sm text-muted-foreground">
          <div className="flex items-start gap-3">
            <Server className="w-5 h-5 text-amber-400 mt-0.5" />
            <div>
              <div className="font-semibold text-foreground">Untrusted Providers</div>
              <p>Storage providers can be malicious, lazy, or economically rational. Proofs must stand alone.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <WifiOff className="w-5 h-5 text-blue-400 mt-0.5" />
            <div>
              <div className="font-semibold text-foreground">Unreliable Networks</div>
              <p>Outages, partitions, and latency spikes are expected; availability must survive churn.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Router className="w-5 h-5 text-purple-400 mt-0.5" />
            <div>
              <div className="font-semibold text-foreground">Gateways Are Optional</div>
              <p>Routing helpers can be offline or compromised; clients must be able to verify outcomes directly.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <KeyRound className="w-5 h-5 text-emerald-400 mt-0.5" />
            <div>
              <div className="font-semibold text-foreground">Client Keys Stay Local</div>
              <p>All on-chain actions require the user wallet; gateways never sign on the user’s behalf.</p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid md:grid-cols-3 gap-6 mb-12">
        <PillarCard
          icon={<CheckCircle2 className="w-5 h-5 text-emerald-400" />}
          title="Data Integrity"
          body="Every 128 KiB blob is committed with KZG. The manifest root binds all MDUs so proofs can be verified without trusting the provider."
        />
        <PillarCard
          icon={<HardDrive className="w-5 h-5 text-blue-400" />}
          title="Data Availability"
          body="Mode 2 uses RS(K, K+M) striping. Any K slots reconstruct data; repairs are verified against the same manifest."
        />
        <PillarCard
          icon={<Lock className="w-5 h-5 text-purple-400" />}
          title="Payment Safety"
          body="Retrieval sessions lock funds up-front and only pay providers on confirmation. Base fees deter spam."
        />
      </div>

      <section className="bg-card border border-border rounded-2xl p-6 shadow-sm mb-12">
        <h2 className="text-2xl font-bold text-foreground mb-6">Threats & Mitigations</h2>
        <div className="grid md:grid-cols-2 gap-6">
          <ThreatCard
            icon={<AlertTriangle className="w-5 h-5 text-amber-400" />}
            title="Invalid Proofs / Fraudulent Claims"
            body="All proofs are verified on-chain against the manifest root. Invalid proofs are rejected and subject to slashing; providers only earn on valid proofs."
          />
          <ThreatCard
            icon={<WifiOff className="w-5 h-5 text-red-400" />}
            title="Data Unavailability"
            body="RS(K, K+M) striping ensures any K slots can reconstruct data. Missing shards can be repaired and re-verified."
          />
          <ThreatCard
            icon={<Lock className="w-5 h-5 text-indigo-400" />}
            title="Retrieval-Session Griefing"
            body="Sessions lock a base fee plus per-blob budget. Payments release on confirmation; unused budget can be reclaimed after expiry."
          />
          <ThreatCard
            icon={<Shield className="w-5 h-5 text-emerald-400" />}
            title="Client / Gateway Abuse"
            body="Gateways are optional routing helpers. They never sign on behalf of users; all on-chain actions require a wallet signature."
          />
          <ThreatCard
            icon={<Layers className="w-5 h-5 text-slate-400" />}
            title="Slot Collusion / Concentration"
            body="Provider placement is deterministic and encoded in the deal. Slot ordering is enforced on-chain during proofs and retrieval sessions."
          />
          <ThreatCard
            icon={<KeyRound className="w-5 h-5 text-emerald-400" />}
            title="On-Demand Generation"
            body="Argon2id timing makes last-minute generation uneconomical. Proofs are tied to fixed commitments and manifest roots."
          />
        </div>
      </section>

      <section className="bg-card border border-border rounded-2xl p-6 shadow-sm mb-12">
        <h2 className="text-2xl font-bold text-foreground mb-4">Retrieval Security Pipeline</h2>
        <div className="grid md:grid-cols-2 gap-6 text-sm text-muted-foreground">
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5" />
              <p><span className="font-semibold text-foreground">Open session:</span> user signs an on-chain session with locked funds and explicit ranges.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5" />
              <p><span className="font-semibold text-foreground">Fetch data:</span> bytes are streamed with proofs bound to the manifest root.</p>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5" />
              <p><span className="font-semibold text-foreground">Confirm session:</span> user signs completion; provider can then claim payment.</p>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <Lock className="w-4 h-4 text-indigo-400 mt-0.5" />
              <p><span className="font-semibold text-foreground">Budgeted by design:</span> base fee deters spam and per-blob fees prevent “free” data.</p>
            </div>
            <div className="flex items-start gap-2">
              <HardDrive className="w-4 h-4 text-blue-400 mt-0.5" />
              <p><span className="font-semibold text-foreground">Mode 2 safe:</span> slot-aware sessions ensure the correct provider serves each shard.</p>
            </div>
            <div className="flex items-start gap-2">
              <Shield className="w-4 h-4 text-emerald-400 mt-0.5" />
              <p><span className="font-semibold text-foreground">Receipt bound:</span> proofs are tied to a specific deal + manifest root.</p>
            </div>
          </div>
        </div>
      </section>

      <motion.section
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="bg-secondary/20 border border-border rounded-2xl p-6"
      >
        <div className="flex items-center gap-2 mb-3">
          <Gavel className="w-5 h-5 text-slate-400" />
          <h3 className="text-lg font-semibold text-foreground">Planned Hardening</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          We are actively planning deputy-based dispute resolution, stronger provider strike systems, and deeper
          retrieval monitoring to harden against adversarial behavior. Security posture improves as these roll out.
        </p>
      </motion.section>
    </div>
  );
};

const PillarCard = ({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) => (
  <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <h3 className="font-semibold text-foreground">{title}</h3>
    </div>
    <p className="text-sm text-muted-foreground">{body}</p>
  </div>
);

const ThreatCard = ({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) => (
  <div className="bg-background/60 border border-border rounded-xl p-5">
    <div className="flex items-center gap-2 mb-2">
      {icon}
      <h3 className="font-semibold text-foreground">{title}</h3>
    </div>
    <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
  </div>
);
