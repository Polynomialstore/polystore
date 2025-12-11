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
      className="relative group"
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button 
        className={`flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
          isActive || isOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
        }`}
      >
        {label}
        <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2 }}
            className="absolute left-0 mt-2 w-48 rounded-xl border border-border bg-popover text-popover-foreground shadow-lg overflow-hidden z-50"
          >
            <div className="py-1">
              {items.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`block px-4 py-2.5 text-sm hover:bg-secondary/50 transition-colors ${
                    location.pathname === item.path ? "text-primary font-bold bg-primary/5" : ""
                  }`}
                >
                  {item.name}
                </Link>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
