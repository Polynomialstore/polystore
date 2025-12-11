import { Outlet, Link, useLocation } from "react-router-dom";
import { ModeToggle } from "./ModeToggle";
import { useState } from "react";
import { Menu, X, Github, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ConnectWallet } from "./ConnectWallet";
import { NavDropdown } from "./NavDropdown";

export const Layout = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(null);
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  // Navigation Hierarchy
  const navStructure = [
    { type: "link", name: "Dashboard", path: "/dashboard" },
    { 
      type: "dropdown", 
      name: "Testnet", 
      items: [
        { name: "Leaderboard", path: "/leaderboard" },
        { name: "Performance", path: "/performance" },
        { name: "Proofs", path: "/proofs" },
      ] 
    },
    { 
      type: "dropdown", 
      name: "Learn", 
      items: [
        { name: "Architecture", path: "/technology" },
        { name: "Economy", path: "/economy" },
        { name: "Security", path: "/security" },
        { name: "Governance", path: "/governance" },
      ] 
    },
    { 
        type: "dropdown", 
        name: "Resources", 
        items: [
          { name: "FAQ", path: "/faq" },
        ] 
      },
  ];

  const toggleMobileGroup = (name: string) => {
    setMobileExpanded(mobileExpanded === name ? null : name);
  };

  return (
    <div className="min-h-screen bg-background font-sans antialiased text-foreground transition-colors duration-300">
      
      {/* --- NAVBAR --- */}
      <nav className="fixed top-0 left-0 right-0 z-[100] border-b border-border/40 bg-white/80 dark:bg-black/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          
          {/* 1. LEFT: Logo */}
          <div className="flex-shrink-0 flex items-center gap-2">
            <Link to="/" className="flex items-center gap-2" onClick={() => setIsOpen(false)}>
              <div className="relative w-8 h-8">
                  <img src="/logo_dark.jpg" className="absolute inset-0 w-full h-full object-contain dark:hidden" alt="Logo Dark" />
                  <img src="/logo_light.jpg" className="absolute inset-0 w-full h-full object-contain hidden dark:block" alt="Logo Light" />
              </div>
              <span 
                className="font-extrabold tracking-tight text-xl hidden sm:block" 
                style={{
                  fontFamily: "'Montserrat', sans-serif",
                  backgroundImage: "linear-gradient(90deg, #00E5FF 0%, #E056FD 50%, #7B2CBF 100%)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                NilStore
              </span>
            </Link>
          </div>

          {/* 2. CENTER: Desktop Navigation (Visible only on LG+) */}
          <div className="hidden lg:flex items-center gap-2">
            {navStructure.map((item) => {
                if (item.type === "dropdown") {
                    return <NavDropdown key={item.name} label={item.name} items={item.items!} />;
                }
                return (
                    <Link 
                        key={item.path}
                        to={item.path!} 
                        className={`px-3 py-2 text-sm font-medium rounded-md transition-all relative ${
                        isActive(item.path!) 
                            ? "text-primary bg-primary/10" 
                            : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                        }`}
                    >
                        {item.name}
                    </Link>
                );
            })}
          </div>

          {/* 3. RIGHT: Actions & Mobile Toggle */}
          <div className="flex items-center gap-2 sm:gap-4">
              
              {/* GitHub (Desktop Only) */}
              <a href="https://github.com/Nil-Store/nil-store" target="_blank" rel="noopener noreferrer" className="hidden sm:block text-muted-foreground hover:text-foreground transition-colors">
                <Github className="w-5 h-5" />
              </a>

              <ModeToggle />
              <ConnectWallet />

              {/* Mobile Menu Toggle */}
              <button 
                onClick={() => setIsOpen(!isOpen)} 
                className="lg:hidden p-2 rounded-md hover:bg-secondary text-foreground"
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
              transition={{ duration: 0.2 }}
              className="lg:hidden fixed inset-0 top-16 z-50 overflow-y-auto bg-white dark:bg-zinc-950 border-t border-border pb-24"
            >
              <div className="flex flex-col p-6 space-y-4">
                {navStructure.map((item) => {
                    if (item.type === "link") {
                        return (
                            <Link 
                                key={item.path}
                                to={item.path!} 
                                onClick={() => setIsOpen(false)}
                                className={`text-lg font-medium py-3 border-b border-border/10 flex items-center justify-between ${
                                isActive(item.path!) ? "text-primary" : "text-foreground/80"
                                }`}
                            >
                                {item.name}
                                {isActive(item.path!) && <div className="w-2 h-2 rounded-full bg-primary" />}
                            </Link>
                        );
                    }
                    // Dropdown (Accordion style)
                    const isExpanded = mobileExpanded === item.name;
                    return (
                        <div key={item.name} className="border-b border-border/10 pb-2">
                            <button 
                                onClick={() => toggleMobileGroup(item.name)}
                                className="w-full flex items-center justify-between text-lg font-medium py-3 text-foreground/80"
                            >
                                {item.name}
                                <ChevronDown className={`w-5 h-5 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                            </button>
                            <AnimatePresence>
                                {isExpanded && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        className="overflow-hidden pl-4 flex flex-col gap-2"
                                    >
                                        {item.items!.map(sub => (
                                            <Link
                                                key={sub.path}
                                                to={sub.path}
                                                onClick={() => setIsOpen(false)}
                                                className={`block py-2 text-base ${isActive(sub.path) ? "text-primary font-bold" : "text-muted-foreground"}`}
                                            >
                                                {sub.name}
                                            </Link>
                                        ))}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    );
                })}
                
                <div className="pt-8 space-y-4">
                  <Link 
                    to="/testnet" 
                    onClick={() => setIsOpen(false)}
                    className="block w-full py-4 rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 text-white font-bold text-center shadow-lg"
                  >
                    Join "Store Wars" Testnet
                  </Link>
                  <a 
                    href="https://github.com/Nil-Store/nil-store" 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="flex items-center justify-center gap-2 text-muted-foreground py-4"
                  >
                    <Github className="w-5 h-5" /> View Source on GitHub
                  </a>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      {/* Main Content Spacer */}
      <main className="pt-20">
        <Outlet />
      </main>

      <footer className="py-12 border-t bg-secondary/10 mt-24">
        <div className="container mx-auto px-4 text-center text-muted-foreground text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8 text-left max-w-4xl mx-auto">
            <div>
              <h4 className="font-bold mb-4 text-foreground">Core Tech</h4>
              <ul className="space-y-2">
                <li><Link to="/technology">Architecture</Link></li>
                <li><Link to="/economy">Economy</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold mb-4 text-foreground">Resources</h4>
              <ul className="space-y-2">
                <li><Link to="/testnet">Testnet Guide</Link></li>
                <li><a href="https://github.com/Nil-Store/nil-store" target="_blank" rel="noopener noreferrer">GitHub</a></li>
              </ul>
            </div>
          </div>
          <p>© 2025 NilStore Network. Open Source.</p>
        </div>
      </footer>
    </div>
  );
};
