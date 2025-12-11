import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";

interface NavDropdownProps {
  label: string;
  items: { name: string; path: string }[];
}

export const NavDropdown = ({ label, items }: NavDropdownProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();

  // Check if any child is active
  const isActive = items.some(item => location.pathname === item.path);

  return (
    <div 
      className="relative"
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button 
        className={`relative px-4 py-2 text-sm font-medium rounded-full transition-all duration-300 flex items-center gap-1 group ${
          isActive || isOpen
            ? "text-foreground bg-secondary/80" 
            : "text-muted-foreground hover:text-foreground hover:bg-secondary/40"
        }`}
      >
        {label}
        <ChevronDown className={`w-3 h-3 transition-transform duration-300 ${isOpen ? "rotate-180 text-primary" : "text-muted-foreground group-hover:text-foreground"}`} />
        
        {/* Active Indicator Dot */}
        {isActive && (
            <span className="absolute top-2 right-2 w-1.5 h-1.5 bg-primary rounded-full shadow-[0_0_5px_rgba(6,182,212,0.8)]"></span>
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0 }}
            className="absolute left-1/2 -translate-x-1/2 mt-2 w-56 p-2 rounded-2xl border border-white/10 bg-background/80 backdrop-blur-2xl shadow-xl shadow-black/20 z-[110]"
          >
            {/* Glow Effect behind */}
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-purple-500/5 rounded-2xl -z-10"></div>

            <div className="flex flex-col gap-1">
              {items.map((item) => {
                const active = location.pathname === item.path;
                return (
                    <Link
                    key={item.path}
                    to={item.path}
                    className={`block px-4 py-3 text-sm rounded-xl transition-all duration-200 ${
                        active 
                        ? "bg-secondary text-primary font-bold shadow-inner" 
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                    }`}
                    >
                    <div className="flex items-center justify-between">
                        {item.name}
                        {active && <motion.div layoutId="dropdown-dot" className="w-1.5 h-1.5 bg-primary rounded-full" />}
                    </div>
                    </Link>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};