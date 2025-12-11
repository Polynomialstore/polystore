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

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="absolute top-full left-1/2 -translate-x-1/2 pt-4 z-[110]"
          >
            {/* The Mega Menu Card */}
            <div className="w-[400px] bg-background/80 backdrop-blur-3xl border border-white/10 rounded-3xl shadow-2xl p-3 ring-1 ring-black/5 overflow-hidden">
              
              {/* Grid Layout */}
              <div className="grid gap-1">
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
                        className={`group flex items-start gap-4 p-4 rounded-2xl transition-all duration-200 ${
                            active 
                            ? "bg-secondary/60" 
                            : "hover:bg-secondary/40"
                        }`}
                    >
                        {/* Icon Box */}
                        <div className={`mt-1 p-2 rounded-lg shrink-0 transition-colors ${
                            active ? "bg-primary/20 text-primary" : "bg-secondary/50 text-muted-foreground group-hover:text-primary group-hover:bg-primary/10"
                        }`}>
                            {item.icon}
                        </div>

                        {/* Content */}
                        <div className="flex-1">
                            <div className="flex items-center justify-between">
                                <span className={`text-sm font-bold ${active ? "text-primary" : "text-foreground group-hover:text-foreground"}`}>
                                    {item.name}
                                </span>
                                {item.external && <ArrowUpRight className="w-3 h-3 text-muted-foreground" />}
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed mt-0.5 group-hover:text-muted-foreground/80">
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