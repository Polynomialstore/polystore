import { motion } from "framer-motion"
import {
  ArrowRight,
  BadgeCheck,
  Database,
  GitBranch,
  HeartPlus,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { Link } from "react-router-dom"

import { PrimaryCtaLink } from "../components/PrimaryCta"

const audienceTracks = [
  {
    eyebrow: "For Data Users",
    title: "Store a file. Retrieve it back. Verify the full path.",
    description:
      "Upload data to NilStore testnet, commit it on-chain, and pull it back through the same network. This is the shortest path for users validating storage end to end.",
    bullets: ["Browser-first upload flow", "Wallet-funded testnet path", "Retrieval loop included"],
    cta: { to: "/alpha/storage", label: "Store a File" },
    icon: Database,
    accent: "primary",
  },
  {
    eyebrow: "For Provider Operators",
    title: "Bring a provider online and manage it from the web.",
    description:
      "Pair a host, run the bootstrap flow, confirm public health, and operate the provider from My Providers. This is the path for operators joining the network with real capacity.",
    bullets: ["Web-first onboarding", "On-chain pairing", "Managed health and endpoint recovery"],
    cta: { to: "/alpha/provider", label: "Run a Provider" },
    icon: Server,
    accent: "accent",
  },
] as const

const proofPoints = [
  {
    label: "Preview Testnet",
    body: "A preview test environment for storage users and provider operators.",
    icon: Sparkles,
  },
  {
    label: "Verifiable Path",
    body: "Built around cryptographic proofs of storage and retrieval.",
    icon: ShieldCheck,
  },
  {
    label: "High Availability",
    body: "Data Availability is mantained by Reed-Solomon Error Correction Coding and automatic migrations.",
    icon: HeartPlus,
  },
] as const

const quickLinks = [
  { to: "/alpha/status", label: "Testnet Status" },
  { to: "/leaderboard", label: "Leaderboard" },
  { to: "/sp-dashboard", label: "My Providers" },
] as const

export const Home = () => {
  return (
    <div className="px-4 pb-16 pt-12 md:pb-20">
      <div className="container mx-auto max-w-6xl space-y-12">
        <motion.section
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
          className="relative glass-panel industrial-border px-6 py-8 md:px-10 md:py-12"
        >
          <div className="relative grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:items-center">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 border border-border bg-card/80 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground">
                <BadgeCheck className="h-4 w-4 text-primary" />
                Preview Testnet
              </div>

              <div className="mt-6 flex items-center gap-4">
                <div className="relative h-16 w-16 shrink-0 glass-panel industrial-border p-2 md:h-20 md:w-20">
                  <img
                    src="/brand/logo-light-256.png"
                    srcSet="/brand/logo-light-256.png 1x, /brand/logo-light-512.png 2x"
                    alt="NilStore Logo (Light)"
                    className="absolute inset-0 h-full w-full object-contain opacity-100 transition-opacity dark:opacity-0"
                  />
                  <img
                    src="/brand/logo-dark-256.png"
                    srcSet="/brand/logo-dark-256.png 1x, /brand/logo-dark-512.png 2x"
                    alt="NilStore Logo (Dark)"
                    className="absolute inset-0 h-full w-full object-contain opacity-0 transition-opacity dark:opacity-100"
                  />
                </div>
                <div className="text-[2.25rem] font-extrabold tracking-tight sm:text-6xl md:text-7xl leading-none">
                  <span className="text-foreground">Nil</span>
                  <span className="text-primary">Store</span>
                </div>
              </div>

              <div className="mt-8 space-y-5">
                <h1 className="max-w-4xl text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl md:text-[3.7rem]">
                  Store data. Run providers. Join the NilStore testnet.
                </h1>
                <p className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                  Choose the path that matches your role.
                </p>
              </div>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <PrimaryCtaLink to="/alpha/storage" leftIcon={<Database className="h-4 w-4" />}>
                  Store a File
                </PrimaryCtaLink>
                <PrimaryCtaLink
                  to="/alpha/provider"
                  leftIcon={<Server className="h-4 w-4" />}
                  className="!border-accent !bg-accent !text-accent-foreground"
                >
                  Run a Provider
                </PrimaryCtaLink>
              </div>

              <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {quickLinks.map((link) => (
                  <Link key={link.to} to={link.to} className="inline-flex items-center gap-2 transition-colors hover:text-foreground">
                    <GitBranch className="h-3.5 w-3.5" />
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>

            <motion.div
              initial={{ opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.32, delay: 0.03, ease: [0.22, 1, 0.36, 1] }}
              className="grid gap-4"
            >
              {proofPoints.map((point, index) => {
                const Icon = point.icon
                return (
                  <motion.div
                    key={point.label}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.24, delay: 0.05 + index * 0.04 }}
                    className="relative border border-border bg-background/55 p-5 backdrop-blur-sm"
                  >
                    <div className="flex items-start gap-4">
                      <div className="mt-0.5 flex h-10 w-10 items-center justify-center border border-border bg-background/80">
                        <Icon className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-foreground">
                          {point.label}
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{point.body}</p>
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </motion.div>
          </div>
        </motion.section>

        <section className="grid gap-6 lg:grid-cols-2">
          {audienceTracks.map((track, index) => {
            const Icon = track.icon
            const isAccent = track.accent === "accent"
            return (
              <motion.article
                key={track.title}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, delay: 0.06 + index * 0.05 }}
                whileHover={{ y: -4 }}
                className="relative glass-panel industrial-border px-6 py-7 md:px-8 md:py-8"
              >
                <div className="relative flex items-start justify-between gap-6">
                  <div className="max-w-xl space-y-4">
                    <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{track.eyebrow}</div>
                    <h2 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">{track.title}</h2>
                    <p className="max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">{track.description}</p>
                  </div>
                  <div className={`mt-1 flex h-14 w-14 shrink-0 items-center justify-center glass-panel industrial-border ${isAccent ? "industrial-border-accent" : ""}`}>
                    <Icon className={`h-6 w-6 ${isAccent ? "text-accent" : "text-primary"}`} />
                  </div>
                </div>

                <div className="relative mt-6 grid gap-2 text-sm text-muted-foreground">
                  {track.bullets.map((bullet) => (
                    <div key={bullet} className="flex items-center gap-3 border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
                      <div className={`h-2 w-2 shrink-0 ${isAccent ? "bg-accent" : "bg-primary"}`} />
                      <span>{bullet}</span>
                    </div>
                  ))}
                </div>

                <div className="relative mt-7 flex flex-wrap items-center gap-4">
                  <PrimaryCtaLink
                    to={track.cta.to}
                    leftIcon={<Icon className="h-4 w-4" />}
                    className={isAccent ? "!border-accent !bg-accent !text-accent-foreground" : ""}
                  >
                    {track.cta.label}
                  </PrimaryCtaLink>
                  <Link
                    to={isAccent ? "/sp-onboarding" : "/first-file"}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-foreground transition-colors hover:text-primary"
                  >
                    {isAccent ? "See provider onboarding" : "See the guided first-file flow"}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </motion.article>
            )
          })}
        </section>

        <motion.section
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.12 }}
          className="grid gap-5 border border-border bg-card/70 px-6 py-7 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:px-8 glass-panel industrial-border"
        >
          <div className="space-y-3">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Choose Your Starting Point</div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
              One network. Two roles. A direct way in.
            </h2>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground md:text-base">
              Data users should get to storage fast. Provider operators should get to onboarding fast. The homepage should do exactly that, without making either audience decode internal product structure first.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row md:flex-col">
            <PrimaryCtaLink to="/alpha/storage" size="md" leftIcon={<Database className="h-4 w-4" />}>
              Start with Data
            </PrimaryCtaLink>
            <PrimaryCtaLink
              to="/alpha/provider"
              size="md"
              leftIcon={<Server className="h-4 w-4" />}
              className="!border-accent !bg-accent !text-accent-foreground"
            >
              Start with Providers
            </PrimaryCtaLink>
          </div>
        </motion.section>
      </div>
    </div>
  )
}
