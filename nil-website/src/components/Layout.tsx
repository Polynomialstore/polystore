import { Outlet, Link, useLocation } from "react-router-dom";
import { ModeToggle } from "./ModeToggle";
import { useState } from "react";
import { Menu, X, Github } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ConnectWallet } from "./ConnectWallet";

export const Layout = () => {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  const navLinks = [
    { name: "Dashboard", path: "/dashboard" },
    { name: "Technology", path: "/technology" },
    { name: "Leaderboard", path: "/leaderboard" },
    { name: "Performance", path: "/performance" },
    { name: "Proofs", path: "/proofs" },
    { name: "Economy", path: "/economy" },
    { name: "Security", path: "/security" },
    { name: "S3 Adapter", path: "/s3-adapter" },
    { name: "Governance", path: "/governance" },
    { name: "FAQ", path: "/faq" },
  ];

  return (
    <div className="min-h-screen bg-background font-sans antialiased text-foreground transition-colors duration-300">
      {/* Cyber-Glass Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/95 md:bg-background/70 backdrop-blur-xl border-b border-border/40 shadow-sm">
        {/* Gradient Line */}
        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-50" />
        
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          {/* Left side: Logo + Nav Links */}
          <div className="flex items-center gap-8">
            <Link to="/" className="text-xl font-bold flex items-center gap-2 z-50" onClick={() => setIsOpen(false)}>
              <div className="relative w-8 h-8">
                  <img src="/logo_dark.jpg" className="absolute inset-0 w-full h-full object-contain dark:hidden" />
                  <img src="/logo_light.jpg" className="absolute inset-0 w-full h-full object-contain hidden dark:block" />
              </div>
              <span 
                className="font-extrabold tracking-tight text-xl" 
                style={{
                  fontFamily: "'Montserrat', sans-serif",
                  backgroundImage: "linear-gradient(90deg, #00E5FF 0%, #E056FD 50%, #7B2CBF 100%)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  filter: "drop-shadow(0 0 2px rgba(0, 229, 255, 0.2))" 
                }}
              >
                NilStore
              </span>
            </Link>

            {/* Desktop Nav Links (Left Aligned) */}
            <div className="hidden lg:flex gap-6 text-sm font-medium text-muted-foreground items-center">
              {navLinks.map((link) => (
                <Link 
                  key={link.path}
                  to={link.path} 
                  className={`transition-colors relative py-1 hover:text-foreground ${isActive(link.path) ? "text-foreground font-bold" : ""}`}
                >
                  {link.name}
                  {/* Active State Indicator */}
                  {isActive(link.path) && (
                    <motion.div 
                      layoutId="nav-indicator"
                      className="absolute -bottom-1 left-0 right-0 h-0.5 bg-primary rounded-full shadow-[0_0_8px_rgba(var(--primary),0.8)]"
                    />
                  )}
                </Link>
              ))}
            </div>
          </div>

          {/* Right side: GitHub, ModeToggle, CTA */}
          <div className="hidden md:flex items-center gap-4">
              <ConnectWallet />
              <a href="https://github.com/Nil-Store/nil-store" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
                <Github className="w-5 h-5" />
              </a>
              <div className="pl-4 border-l flex items-center gap-4">
                  <ModeToggle />
                  
                  {/* CTA Button */}
                  <Link 
                    to="/testnet" 
                    className="px-5 py-2 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 text-white font-bold text-xs hover:opacity-90 transition-opacity shadow-lg shadow-purple-500/20"
                  >
                    Join Testnet
                  </Link>
              </div>
          </div>

          {/* Mobile Menu Toggle */}
          <div className="md:hidden flex items-center gap-4 z-50">
             <ConnectWallet />
             <ModeToggle />
             <button onClick={() => setIsOpen(!isOpen)} className="text-foreground">
               {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
             </button>
          </div>
        </div>

        {/* Mobile Menu Overlay */}
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="fixed inset-0 top-16 bg-background backdrop-blur-lg z-50 md:hidden flex flex-col p-6 border-t border-border/50"
            >
              <div className="flex flex-col gap-6 text-lg font-medium">
                {navLinks.map((link) => (
                  <Link 
                    key={link.path}
                    to={link.path} 
                    onClick={() => setIsOpen(false)}
                    className={`flex items-center justify-between border-b border-border/30 pb-4 ${isActive(link.path) ? "text-primary font-bold" : "text-muted-foreground"}`}
                  >
                    {link.name}
                    {isActive(link.path) && <div className="w-2 h-2 rounded-full bg-primary" />}
                  </Link>
                ))}
                <Link 
                  to="/testnet" 
                  onClick={() => setIsOpen(false)}
                  className="mt-4 py-4 rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 text-white font-bold text-center shadow-lg"
                >
                  Join Testnet
                </Link>
                <a 
                  href="https://github.com/Nil-Store/nil-store" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="flex items-center justify-center gap-2 text-muted-foreground mt-4"
                >
                  <Github className="w-5 h-5" /> GitHub
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      <main className="pt-20">
        <Outlet />
      </main>

      <footer className="py-12 border-t bg-secondary/10 mt-24">
        <div className="container mx-auto px-4 text-center text-muted-foreground text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8 text-left max-w-4xl mx-auto">
            <div>
              <h4 className="font-bold mb-4 text-foreground">Core Tech</h4>
              <ul className="space-y-2">
                <li><Link to="/technology/sharding">Data Sharding</Link></li>
                <li><Link to="/technology/kzg">KZG Commitments</Link></li>
                <li><Link to="/technology/sealing">Proof of Seal</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold mb-4 text-foreground">Resources</h4>
              <ul className="space-y-2">
                <li><Link to="/testnet">Testnet Guide</Link></li>
                <li><a href="#">Whitepaper</a></li>
                <li><a href="https://github.com/Nil-Store/nil-store" target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><a href="#">CLI Tool</a></li>
              </ul>
            </div>
          </div>
          <p>© 2025 NilStore Network. Open Source.</p>
        </div>
      </footer>
    </div>
  );
};
