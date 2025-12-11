import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";

interface NavDropdownProps {
  label: string;
  items: { name: string; path: string; external?: boolean }[];
}

export const NavDropdown = ({ label, items }: NavDropdownProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();

  const isActive = items.some(item => location.pathname === item.path);

  return (
    <div 
      className="relative h-full flex items-center"
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button 
        className={`relative px-4 py-2 text-sm font-medium rounded-full transition-all duration-200 flex items-center gap-1 group ${
          isActive || isOpen
            ? "text-foreground bg-secondary/80" 
            : "text-muted-foreground hover:text-foreground hover:bg-secondary/40"
        }`}
      >
        {label}
        <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isOpen ? "rotate-180 text-primary" : "text-muted-foreground group-hover:text-foreground"}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute top-full left-0 pt-2 w-64 z-[110]"
          >
            <div className="bg-background/95 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl p-2 overflow-hidden ring-1 ring-black/5">
              {items.map((item) => {
                const active = location.pathname === item.path;
                
                if (item.external) {
                    return (
                        <a
                            key={item.path}
                            href={item.path}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block px-4 py-3 text-sm font-medium rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                        >
                            <div className="flex items-center justify-between">
                                {item.name}
                                <span className="text-[10px] opacity-50">↗</span>
                            </div>
                        </a>
                    )
                }

                return (
                    <Link
                    key={item.path}
                    to={item.path}
                    className={`block px-4 py-3 text-sm font-medium rounded-xl transition-all duration-200 ${
                        active 
                        ? "bg-secondary text-primary shadow-sm" 
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                    }`}
                    >
                        {item.name}
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
