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
        className={`relative px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data border border-transparent transition-[color,background-color,border-color] duration-200 ease-out flex items-center gap-2 group ${
          isActive || isOpen
            ? "text-foreground bg-secondary border-border/60" 
            : "text-muted-foreground hover:text-foreground hover:bg-secondary hover:border-border/60"
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
            initial={{ opacity: 0, y: -10, x: "-50%", scale: 0.98 }}
            animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
            exit={{ opacity: 0, y: -8, x: "-50%", scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            // Fixed positioning relative to the viewport center, effectively creating a consistent "Mega Menu" location
            className="fixed top-14 left-1/2 z-[110]"
          >
            {/* The Mega Menu Card */}
            <div className="relative w-[640px] glass-panel industrial-border p-4 overflow-hidden">
              
              {/* Grid Layout - 2 Columns */}
              <div className="relative grid grid-cols-2 gap-2">
                {items.map((item) => {
                  const active = location.pathname === item.path;
                  
                  // Wrapper to handle external vs internal link logic
                  const Wrapper = ({ children, className }: { children: React.ReactNode; className: string }) => 
                    item.external ? (
                        <a href={item.path} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>
                    ) : (
                        <Link to={item.path} className={className}>{children}</Link>
                    );

                  return (
                    <Wrapper
                        key={item.path}
                        className={`group flex items-start gap-3 p-3 glass-panel industrial-border transition-[transform,background-color,border-color,color] duration-200 ease-out ${
                            active
                              ? "border-primary/40 bg-primary/10"
                              : "hover:border-primary/40 hover:bg-primary/10 hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
                        }`}
                    >
                        {/* Icon Box */}
                            <div className={`mt-0.5 p-2 glass-panel industrial-border shrink-0 transition-[color,background-color,border-color] duration-200 ease-out ${
                                active ? "text-primary bg-primary/10" : "text-muted-foreground group-hover:text-primary group-hover:bg-primary/10"
                            }`}>
                            {item.icon}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                                <span className={`text-[11px] font-bold uppercase tracking-[0.2em] font-mono-data truncate ${active ? "text-primary" : "text-foreground"}`}>
                                    {item.name}
                                </span>
                                {item.external && <ArrowUpRight className="w-3 h-3 text-muted-foreground" />}
                            </div>
                            <p className="mt-1 text-[10px] text-muted-foreground leading-tight font-mono-data line-clamp-2">
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
