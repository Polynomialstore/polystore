import type { ReactNode } from "react";
import { motion } from "framer-motion";

type AlphaHeroProps = {
  badge: ReactNode;
  logo: ReactNode;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function AlphaHero({ badge, logo, title, description, actions, className = "" }: AlphaHeroProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className={`relative glass-panel industrial-border border-primary-frame p-10 text-center md:p-14 ${className}`.trim()}
    >
      <div className="relative mx-auto mb-6 h-28 w-28 glass-panel industrial-border p-3">{logo}</div>

      <div className="relative mx-auto inline-flex items-center border border-border bg-card px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground">
        {badge}
      </div>

      <div className="relative mt-5">{title}</div>

      <div className="relative mt-5 max-w-2xl mx-auto text-base leading-relaxed text-muted-foreground sm:text-lg">
        {description}
      </div>

      {actions ? <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">{actions}</div> : null}
    </motion.section>
  );
}
