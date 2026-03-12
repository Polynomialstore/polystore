import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ArrowUpRight } from "lucide-react";
import { cn } from "../lib/utils";

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
        className={cn(
          "nav-topbtn",
          isActive ? "nav-topbtn--active" : "nav-topbtn--inactive",
          isOpen ? "nav-topbtn--open" : null,
        )}
      >
        <span className={cn("nav-toplabel", isActive ? "nav-toplabel--active" : null)}>{label}</span>
        <ChevronDown
          className={cn(
            "nav-topchev",
            // Default = "up" (rotated). Open/active = "down".
            isOpen || isActive ? "rotate-0 text-primary" : "rotate-180 text-foreground",
          )}
        />
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
                      className={cn("group nav-mega-item", active ? "nav-mega-item--active" : null)}
                    >
                        {/* Icon Box */}
                        <div
                          className={cn(
                            "nav-mega-icon",
                            active ? "nav-mega-icon--active" : "nav-mega-icon--inactive",
                          )}
                        >
                            {item.icon}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                                <span
                                  className={cn("nav-mega-title", active ? "nav-mega-title--active" : null)}
                                >
                                    {item.name}
                                </span>
                                {item.external && <ArrowUpRight className="w-3 h-3 text-muted-foreground" />}
                            </div>
                            <p className="nav-mega-desc">
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
