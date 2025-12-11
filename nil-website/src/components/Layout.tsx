import { Outlet, Link, useLocation } from "react-router-dom";
import { ModeToggle } from "./ModeToggle";
import { useState } from "react";
import { Menu, X, Github, ChevronDown, Zap, Rocket, Trophy, Activity, Coins, Cpu, Shield, HelpCircle, Vote } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { NavDropdown, NavItem } from "./NavDropdown";

export const Layout = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(null);
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  // Navigation Hierarchy (Rich Data)
  const navStructure: { type: "link" | "dropdown", name: "Dashboard" | "Explore" | "Learn" | "Community", path?: string, items?: NavItem[] }[] = [
    { 
      type: "dropdown", 
      name: "Explore", 
      items: [
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
        { name: "Security", path: "/security", description: "Triple Proofs & Threat Model.", icon: <Shield className="w-5 h-5" /> },
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
    <div className="min-h-screen bg-background font-sans antialiased text-foreground transition-colors duration-300 selection:bg-primary/30">
      
      {/* --- NAVBAR --- */}
      <nav className="fixed top-0 left-0 right-0 z-[100] transition-all duration-300">
        
        {/* Glass Container */}
        <div className="absolute inset-0 bg-background/70 backdrop-blur-xl border-b border-white/5 dark:border-white/5 shadow-sm"></div>
        
        {/* Cyber Gradient Line (Bottom) */}
        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-60"></div>

        <div className="container mx-auto px-4 h-16 flex items-center justify-between relative z-10">
          
          {/* 1. LEFT: Logo */}
          <div className="flex-shrink-0 flex items-center gap-2 group cursor-pointer">
            <Link to="/" className="flex items-center gap-3" onClick={() => setIsOpen(false)}>
              <div className="relative w-9 h-9 transition-transform group-hover:scale-110 duration-300">
                  <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                  <img src="/logo_dark.jpg" className="absolute inset-0 w-full h-full object-contain dark:hidden drop-shadow-md" alt="Logo Dark" />
                  <img src="/logo_light.jpg" className="absolute inset-0 w-full h-full object-contain hidden dark:block drop-shadow-[0_0_10px_rgba(255,255,255,0.3)]" alt="Logo Light" />
              </div>
              <span 
                className="font-extrabold tracking-tight text-xl hidden sm:block" 
                style={{
                  fontFamily: "'Montserrat', sans-serif",
                  backgroundImage: "linear-gradient(135deg, #FFF 0%, #AAA 100%)", 
                }}
              >
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-500 via-purple-500 to-fuchsia-500 hover:brightness-125 transition-all duration-300">
                    NilStore
                </span>
              </span>
            </Link>
          </div>

          {/* 2. CENTER: Desktop Navigation */}
          <div className="hidden lg:flex items-center gap-1 bg-secondary/30 p-1 rounded-full border border-white/5 backdrop-blur-md shadow-inner">
            {navStructure.map((item) => (
                <NavDropdown key={item.name} label={item.name} items={item.items!} />
            ))}
          </div>

          {/* 3. RIGHT: Actions (Console CTA) */}
          <div className="flex items-center gap-3 sm:gap-4">
              
              {/* Desktop GitHub */}
              <a 
                href="https://github.com/Nil-Store/nil-store" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="hidden sm:flex items-center justify-center w-9 h-9 rounded-full bg-secondary/50 hover:bg-secondary text-muted-foreground hover:text-foreground transition-all border border-transparent hover:border-border"
              >
                <Github className="w-5 h-5" />
              </a>

              <ModeToggle />
              
              {/* PRIMARY CTA: Launch Console */}
              <Link 
                to="/dashboard"
                className="hidden sm:flex items-center gap-2 px-5 py-2 rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-bold text-sm shadow-lg shadow-cyan-500/20 hover:scale-105 hover:shadow-cyan-500/40 transition-all duration-300"
              >
                <Rocket className="w-4 h-4 fill-current" />
                Launch Console
              </Link>

              {/* Mobile Toggle */}
              <button 
                onClick={() => setIsOpen(!isOpen)} 
                className="lg:hidden p-2 rounded-lg hover:bg-secondary text-foreground transition-colors"
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
              className="lg:hidden fixed inset-0 top-16 z-50 overflow-y-auto bg-background/95 backdrop-blur-3xl border-t border-border/50 pb-24"
            >
              <div className="flex flex-col p-6 space-y-6">
                
                {/* Mobile CTA */}
                <Link 
                    to="/dashboard" 
                    onClick={() => setIsOpen(false)}
                    className="block w-full py-4 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-bold text-center text-xl shadow-lg shadow-cyan-500/20 active:scale-95 transition-transform flex items-center justify-center gap-3"
                  >
                    <Rocket className="w-6 h-6 fill-current" />
                    Launch Console
                </Link>

                <div className="h-[1px] bg-border/50"></div>

                {navStructure.map((item) => {
                    // Dropdown (Accordion)
                    const isExpanded = mobileExpanded === item.name;
                    return (
                        <div key={item.name} className="border-b border-border/20 pb-4">
                            <button 
                                onClick={() => toggleMobileGroup(item.name)}
                                className="w-full flex items-center justify-between text-2xl font-bold tracking-tight text-foreground/80 hover:text-foreground transition-colors"
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
                                                    className={`group flex items-center gap-4 p-2 rounded-xl transition-colors ${
                                                        active ? "bg-secondary/50" : "hover:bg-secondary/30"
                                                    }`}
                                                >
                                                    <div className={`p-2 rounded-lg ${active ? "text-primary bg-primary/10" : "text-muted-foreground bg-secondary"}`}>
                                                        {sub.icon}
                                                    </div>
                                                    <div>
                                                        <div className={`font-bold ${active ? "text-foreground" : "text-foreground/80"}`}>{sub.name}</div>
                                                        <div className="text-xs text-muted-foreground">{sub.description}</div>
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

      <footer className="py-12 border-t bg-secondary/5 mt-24 relative overflow-hidden">
        {/* Footer Glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1/2 h-1 bg-gradient-to-r from-transparent via-primary/30 to-transparent blur-sm"></div>
        
        <div className="container mx-auto px-4 text-center text-muted-foreground text-sm relative z-10">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12 text-left max-w-4xl mx-auto">
            <div>
              <h4 className="font-bold mb-4 text-foreground">Core Tech</h4>
              <ul className="space-y-3">
                <li><Link to="/technology" className="hover:text-primary transition-colors">Architecture</Link></li>
                <li><Link to="/economy" className="hover:text-primary transition-colors">Economy</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold mb-4 text-foreground">Resources</h4>
              <ul className="space-y-3">
                <li><Link to="/testnet" className="hover:text-primary transition-colors">Testnet Guide</Link></li>
                <li><a href="https://github.com/Nil-Store/nil-store" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">GitHub</a></li>
              </ul>
            </div>
          </div>
          <p className="opacity-60">© 2025 NilStore Network. Open Source.</p>
        </div>
      </footer>
    </div>
  );
};