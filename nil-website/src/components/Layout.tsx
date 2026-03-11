import { Outlet, Link, useLocation } from "react-router-dom";
import { ModeToggle } from "./ModeToggle";
import { useState, useEffect } from "react";
import { Menu, X, Github, ChevronDown, Zap, Rocket, Trophy, Activity, Coins, Cpu, HelpCircle, Vote, Terminal, Shield, Server, Database } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { NavDropdown, NavItem } from "./NavDropdown";
import { LivingGrid } from "./LivingGrid";
import { DashboardCta } from "./DashboardCta";

export const Layout = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(null);
  const location = useLocation();
  const buildCommit = String(__NIL_BUILD_COMMIT__ || '').trim();
  const shortCommit = buildCommit ? buildCommit.slice(0, 8) : '';

  useEffect(() => {
    let lastX = 0;
    let lastY = 0;
    let lastTime = Date.now();
    let velocity = 0;
    const handleMouseMove = (e: MouseEvent) => {
      const now = Date.now();
      const dt = now - lastTime;
      if (dt > 0) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Calculate velocity (pixels per ms) and smooth it
        const newVelocity = dist / dt;
        velocity = velocity * 0.9 + newVelocity * 0.1;
        
        lastX = e.clientX;
        lastY = e.clientY;
        lastTime = now;

        document.documentElement.style.setProperty("--mouse-x", `${e.clientX}px`);
        document.documentElement.style.setProperty("--mouse-y", `${e.clientY}px`);
        document.documentElement.style.setProperty("--mouse-v", `${velocity.toFixed(2)}`);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  const isActive = (path: string) => location.pathname === path;

  // Navigation Hierarchy (Rich Data)
  const navStructure: { type: "link" | "dropdown", name: "Explore" | "Learn" | "Community", path?: string, items?: NavItem[] }[] = [
    { 
      type: "dropdown", 
      name: "Explore", 
      items: [
        { name: "Store Data", path: "/alpha/storage", description: "Alpha user quickstart.", icon: <Database className="w-5 h-5" /> },
        { name: "Become A Provider", path: "/alpha/provider", description: "Alpha provider onboarding.", icon: <Server className="w-5 h-5" /> },
        { name: "Alpha Status", path: "/alpha/status", description: "Shared launch status surface.", icon: <Activity className="w-5 h-5" /> },
        { name: "SP Dashboard", path: "/sp-dashboard", description: "Provider ops console.", icon: <Server className="w-5 h-5" /> },
        { name: "Leaderboard", path: "/leaderboard", description: "Top performing Storage Providers.", icon: <Trophy className="w-5 h-5" /> },
        { name: "Live Proofs", path: "/proofs", description: "Real-time verification stream.", icon: <Activity className="w-5 h-5" /> },
        { name: "Performance", path: "/performance", description: "Latency racing benchmarks.", icon: <Zap className="w-5 h-5" /> },
        { name: "Economy", path: "/economy", description: "Supply and inflation simulation.", icon: <Coins className="w-5 h-5" /> },
      ] 
    },
    { 
      type: "dropdown", 
      name: "Learn", 
      items: [
        { name: "Architecture", path: "/technology", description: "Deep dive into the protocol.", icon: <Cpu className="w-5 h-5" /> },
        { name: "Security", path: "/security", description: "Threat model and verification layers.", icon: <Shield className="w-5 h-5" /> },
        { name: "First File", path: "/first-file", description: "Guided store + retrieve flow.", icon: <Rocket className="w-5 h-5" /> },
        { name: "Provider Runbook", path: "/sp-onboarding", description: "Remote-first provider runbook with legacy local demo path.", icon: <Server className="w-5 h-5" /> },
        { name: "Testnet Guide", path: "/testnet", description: "Wallet-first setup and local stack.", icon: <Terminal className="w-5 h-5" /> },
        { name: "S3 Adapter", path: "/s3-adapter", description: "Web2 gateway and S3 API usage.", icon: <Terminal className="w-5 h-5" /> },
        { name: "Provider Debug", path: "/devnet", description: "Live provider list and low-level join diagnostics.", icon: <Terminal className="w-5 h-5" /> },
        { name: "FAQ", path: "/faq", description: "Common questions answered.", icon: <HelpCircle className="w-5 h-5" /> },
      ] 
    },
    { 
        type: "dropdown", 
        name: "Community", 
        items: [
          { name: "Governance", path: "/governance", description: "DAO proposals and voting.", icon: <Vote className="w-5 h-5" /> },
          { name: "GitHub", path: "https://github.com/Nil-Store/nil-store", external: true, description: "Source code and contributions.", icon: <Github className="w-5 h-5" /> },
        ] 
      },
  ];

  const toggleMobileGroup = (name: string) => {
    setMobileExpanded(mobileExpanded === name ? null : name);
  };

  return (
    <div className="min-h-screen font-sans antialiased text-foreground transition-colors duration-300 selection:bg-primary/30 relative">
      
      {/* --- THE LIVING DIGITAL GRID --- */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        {/* Base Breathing Grid */}
        <div className="absolute inset-0 opacity-20 dark:opacity-40 animate-grid-breath cyber-grid-layer" />
        
        {/* Reactive Canvas-based Data Packets */}
        <LivingGrid />
      </div>

      {/* --- NAVBAR --- */}
      <nav className="fixed top-0 left-0 right-0 z-[100] transition-all duration-300">
        
        {/* Control Surface */}
        <div className="absolute inset-0 bg-card border-b border-border" />
        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-primary/60 to-transparent opacity-40" />

        <div className="container mx-auto px-4 h-16 flex items-center gap-4 relative z-10">
          
          {/* 1. LEFT: Logo */}
          <div className="flex-shrink-0 flex items-center gap-2 group cursor-pointer">
            <Link to="/" className="flex items-center gap-3" onClick={() => setIsOpen(false)}>
              <div className="relative w-9 h-9 glass-panel industrial-border p-1 dark:shadow-[0_0_20px_hsl(var(--primary)_/_0.18)] transition-shadow">
                <img
                  src="/brand/logo-light-36.png"
                  srcSet="/brand/logo-light-36.png 1x, /brand/logo-light-72.png 2x"
                  className="absolute inset-0 w-full h-full object-contain transition-opacity duration-200 opacity-100 dark:opacity-0"
                  alt="NilStore Logo"
                />
                <img
                  src="/brand/logo-dark-36.png"
                  srcSet="/brand/logo-dark-36.png 1x, /brand/logo-dark-72.png 2x"
                  className="absolute inset-0 w-full h-full object-contain transition-opacity duration-200 opacity-0 dark:opacity-100"
                  alt="NilStore Logo"
                />
              </div>
              <div className="hidden sm:flex flex-col leading-none">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-muted-foreground">
                  /nilstore/ops
                </div>
                <div className="mt-1 text-sm font-extrabold tracking-tight">
                  <span className="text-foreground">NIL</span>
                  <span className="text-primary">STORE</span>
                </div>
                {shortCommit ? (
                  <div className="mt-1 font-mono-data text-[10px] text-muted-foreground">
                    BUILD {shortCommit}
                  </div>
                ) : null}
              </div>
            </Link>
          </div>

          {/* 2. CENTER: Desktop Navigation */}
          <div className="flex-1 flex justify-center">
            <div className="hidden lg:flex items-center gap-1 px-2 py-1 glass-panel industrial-border">
              {navStructure.map((item) => (
                  <NavDropdown key={item.name} label={item.name} items={item.items!} />
              ))}
            </div>
          </div>

          {/* 3. RIGHT: Actions (Console CTA) */}
          <div className="flex items-center gap-3 sm:gap-4">
              
              {/* Desktop GitHub */}
              <a 
                href="https://github.com/Nil-Store/nil-store" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="hidden sm:flex items-center justify-center w-9 h-9 glass-panel industrial-border text-muted-foreground hover:text-foreground transition-colors"
              >
                <Github className="w-5 h-5" />
              </a>

              <ModeToggle />

              <DashboardCta className="hidden sm:flex" label="Dashboard" to="/dashboard" />
              
              {/* Mobile Toggle */}
              <button 
                onClick={() => setIsOpen(!isOpen)} 
                className="lg:hidden p-2 glass-panel industrial-border hover:bg-muted/40 text-foreground transition-colors"
                aria-label="Toggle Menu"
              >
                {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
              </button>
          </div>
        </div>

        {/* --- MOBILE MENU OVERLAY --- */}
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "100vh" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="lg:hidden fixed inset-0 top-16 z-50 overflow-y-auto bg-background border-t border-border pb-24"
            >
              <div className="flex flex-col p-6 space-y-6">
                
                {/* Mobile CTA */}
                <Link 
                    to="/alpha/storage" 
                    onClick={() => setIsOpen(false)}
                    className="block w-full py-4 bg-primary text-primary-foreground font-bold text-center text-[11px] uppercase tracking-[0.2em] shadow-[0_0_24px_rgba(0,0,0,0.08)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.22)] dark:drop-shadow-[0_0_8px_hsl(var(--primary)_/_0.30)] active:translate-x-[2px] active:translate-y-[2px] transition-transform flex items-center justify-center gap-3"
                  >
                    <Database className="w-6 h-6 fill-current" />
                    Start Storing
                </Link>

                <div className="h-[1px] bg-border/50"></div>

                {navStructure.map((item) => {
                    // Dropdown (Accordion)
                    const isExpanded = mobileExpanded === item.name;
                    return (
                        <div key={item.name} className="border-b border-border/30 pb-4">
                            <button 
                                onClick={() => toggleMobileGroup(item.name)}
                                className="w-full flex items-center justify-between text-[12px] font-bold uppercase tracking-[0.2em] text-foreground/80 hover:text-foreground transition-colors font-mono-data"
                            >
                                {item.name}
                                <ChevronDown className={`w-6 h-6 transition-transform duration-300 ${isExpanded ? "rotate-180 text-primary" : "text-muted-foreground"}`} />
                            </button>
                            <AnimatePresence>
                                {isExpanded && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0, y: -10 }}
                                        animate={{ height: "auto", opacity: 1, y: 0 }}
                                        exit={{ height: 0, opacity: 0, y: -10 }}
                                        className="overflow-hidden pt-4 pl-2 flex flex-col gap-3"
                                    >
                                        {item.items!.map(sub => {
                                            const active = isActive(sub.path);
                                            return (
                                                <Link
                                                    key={sub.path}
                                                    to={sub.path}
                                                    onClick={() => setIsOpen(false)}
                                                    className={`group flex items-center gap-4 p-3 glass-panel industrial-border transition-colors ${
                                                        active ? "bg-muted/40" : "hover:bg-muted/30"
                                                    }`}
                                                >
                                                    <div className={`p-2 glass-panel industrial-border ${active ? "text-primary bg-primary/10" : "text-muted-foreground bg-muted/40"}`}>
                                                        {sub.icon}
                                                    </div>
                                                    <div>
                                                        <div className={`text-[11px] font-bold uppercase tracking-[0.2em] ${active ? "text-foreground" : "text-foreground/80"}`}>{sub.name}</div>
                                                        <div className="mt-1 text-[10px] text-muted-foreground font-mono-data">{sub.description}</div>
                                                    </div>
                                                </Link>
                                            )
                                        })}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      {/* Main Content Spacer */}
      <main className="pt-20">
        <Outlet />
      </main>

      <footer className="py-12 border-t border-border bg-card mt-24 relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1/2 h-[1px] bg-gradient-to-r from-transparent via-primary/40 to-transparent opacity-60" />
        
        <div className="container mx-auto px-4 text-center text-muted-foreground text-sm relative z-10">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12 text-left max-w-4xl mx-auto">
            <div>
              <h4 className="text-[10px] uppercase tracking-[0.2em] font-bold text-muted-foreground mb-4">/core_tech</h4>
              <ul className="space-y-3">
                <li><Link to="/technology" className="font-mono-data text-[11px] hover:text-primary transition-colors">Architecture</Link></li>
                <li><Link to="/economy" className="font-mono-data text-[11px] hover:text-primary transition-colors">Economy</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="text-[10px] uppercase tracking-[0.2em] font-bold text-muted-foreground mb-4">/resources</h4>
              <ul className="space-y-3">
                <li><Link to="/testnet" className="font-mono-data text-[11px] hover:text-primary transition-colors">Testnet Guide</Link></li>
                <li><Link to="/sp-onboarding" className="font-mono-data text-[11px] hover:text-primary transition-colors">SP Onboarding</Link></li>
                <li><a href="https://github.com/Nil-Store/nil-store" target="_blank" rel="noopener noreferrer" className="font-mono-data text-[11px] hover:text-primary transition-colors">GitHub</a></li>
              </ul>
            </div>
          </div>
          <p className="opacity-60">© 2025 NilStore Network. Open Source.</p>
          {shortCommit ? (
            <p className="mt-2 font-mono-data text-[10px] uppercase tracking-[0.2em] opacity-60">Build {shortCommit}</p>
          ) : null}
        </div>
      </footer>
    </div>
  );
};
