import { Outlet, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { TechnologyProvider } from "../context/TechnologyContext";

export const TechnologyLayout = () => {
  const location = useLocation();

  return (
    <TechnologyProvider>
      <div className="container mx-auto px-4 pt-24 pb-12 min-h-screen">
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <Outlet />
        </motion.div>
      </div>
    </TechnologyProvider>
  );
};