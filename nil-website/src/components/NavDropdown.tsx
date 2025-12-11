import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ArrowUpRight } from "lucide-react";

export interface NavItem {
  name: string;
  path: string;
  description: string;
  icon: React.ReactNode;
  external?: boolean;
}

interface NavDropdownProps {
  label: string;
  items: NavItem[];
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

      {/* Invisible bridge to connect button to dropdown (prevents gap flickers) */}
      <div className="absolute top-full left-0 w-full h-6 bg-transparent" />

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10, x: "-50%", scale: 0.98 }}
            animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
            exit={{ opacity: 0, y: 8, x: "-50%", scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            // Fixed positioning relative to the viewport center, effectively creating a consistent "Mega Menu" location
            className="fixed left-1/2 z-[110]"
          >
            {/* The Mega Menu Card */}
            <div className="w-[600px] bg-background border border-border/50 rounded-2xl shadow-2xl p-4 overflow-hidden ring-1 ring-black/5 dark:ring-white/10">
              
              {/* Grid Layout - 2 Columns */}
              <div className="grid grid-cols-2 gap-2">
                {items.map((item) => {
                  const active = location.pathname === item.path;
                  
                  // Wrapper to handle external vs internal link logic
                  const Wrapper = ({ children, className }: any) => 
                    item.external ? (
                        <a href={item.path} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>
                    ) : (
                        <Link to={item.path} className={className}>{children}</Link>
                    );

                  return (
                    <Wrapper
                        key={item.path}
                        className={`group flex items-start gap-3 p-3 rounded-xl transition-all duration-200 ${
                            active 
                            ? "bg-secondary" 
                            : "hover:bg-secondary/50"
                        }`}
                    >
                        {/* Icon Box */}
                        <div className={`mt-0.5 p-2 rounded-lg shrink-0 transition-colors ${
                            active ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground group-hover:text-primary group-hover:bg-primary/10"
                        }`}>
                            {item.icon}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                                <span className={`text-sm font-bold truncate ${active ? "text-primary" : "text-foreground"}`}>
                                    {item.name}
                                </span>
                                {item.external && <ArrowUpRight className="w-3 h-3 text-muted-foreground" />}
                            </div>
                            <p className="text-xs text-muted-foreground leading-tight mt-0.5 line-clamp-2">
                                {item.description}
                            </p>
                        </div>
                    </Wrapper>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
