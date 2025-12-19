import { type ReactNode } from "react";
import { motion } from "framer-motion";
import { Shield, CheckCircle2, AlertTriangle, HardDrive, Lock, WifiOff, Gavel } from "lucide-react";

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
          KZG-based proofs, and retrieval-session accounting. This page summarizes the primary threats and how the
          protocol mitigates them.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6 mb-12">
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            <h3 className="font-semibold text-foreground">Data Integrity</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Every 128 KiB blob is committed with KZG. The deal manifest root binds all MDUs so any proof can be verified
            without trusting the provider.
          </p>
        </div>
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <HardDrive className="w-5 h-5 text-blue-400" />
            <h3 className="font-semibold text-foreground">Data Availability</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Erasure coding (RS K+M) keeps data retrievable even if multiple providers go offline. Repairs are
            deterministic and verified against the same root.
          </p>
        </div>
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Lock className="w-5 h-5 text-purple-400" />
            <h3 className="font-semibold text-foreground">Payment Safety</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Retrieval sessions lock funds up-front and only pay providers on confirmation. The gateway never signs for
            the user; wallet approvals remain client-side.
          </p>
        </div>
      </div>

      <section className="bg-card border border-border rounded-2xl p-6 shadow-sm mb-12">
        <h2 className="text-2xl font-bold text-foreground mb-6">Threats & Mitigations</h2>
        <div className="grid md:grid-cols-2 gap-6">
          <ThreatCard
            icon={<AlertTriangle className="w-5 h-5 text-amber-400" />}
            title="Invalid Proofs / Fraudulent Claims"
            body="All proof submissions are verified on-chain. Invalid proofs are rejected and can be slashed. Providers only earn rewards for valid, timely proofs."
          />
          <ThreatCard
            icon={<WifiOff className="w-5 h-5 text-red-400" />}
            title="Data Unavailability"
            body="RS(K, K+M) striping ensures any K slots can reconstruct data. Missing shards are repaired and re-verified against the manifest root."
          />
          <ThreatCard
            icon={<Lock className="w-5 h-5 text-indigo-400" />}
            title="Retrieval-Session Griefing"
            body="Sessions lock a base fee plus per-blob budget. Payments release on confirmation; unused budget can be reclaimed after expiry. Base fees deter spam."
          />
          <ThreatCard
            icon={<Shield className="w-5 h-5 text-emerald-400" />}
            title="Client / Gateway Abuse"
            body="Gateways are optional routing helpers. They never sign on behalf of users; all on-chain actions require a wallet signature."
          />
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
          We are actively planning deputy-based dispute resolution and provider strike systems to handle adversarial
          retrieval behavior. These features will tighten guarantees against non-responsive providers in future sprints.
        </p>
      </motion.section>
    </div>
  );
};

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
