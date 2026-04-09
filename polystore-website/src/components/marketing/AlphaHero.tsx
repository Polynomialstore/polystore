import type { ReactNode } from "react";
import { motion } from "framer-motion";

type HeroPoint = {
  label: string;
  body: string;
  icon: React.ComponentType<{ className?: string }>;
};

type AlphaHeroProps = {
  badge: ReactNode;
  logo: ReactNode;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  points?: readonly HeroPoint[];
  className?: string;
};

export function AlphaHero({ badge, logo, title, description, actions, points, className = "" }: AlphaHeroProps) {
  const hasPoints = points && points.length > 0;

  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
      className={`relative glass-panel industrial-border px-6 py-8 md:px-10 md:py-12 ${className}`.trim()}
    >
      <div
        className={`relative grid gap-10 ${
          hasPoints ? "lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:items-center" : "text-center"
        }`}
      >
        <div className={hasPoints ? "max-w-3xl" : "max-w-4xl mx-auto"}>
          <div className={`nil-badge ${!hasPoints ? "mx-auto" : ""}`}>
            {badge}
          </div>

          <div className={`mt-6 flex items-center gap-4 ${!hasPoints ? "justify-center" : ""}`}>
            <div className="relative h-16 w-16 shrink-0 glass-panel industrial-border p-2 md:h-20 md:w-20">
              {logo}
            </div>
            <div className="text-[2.25rem] font-extrabold tracking-tight sm:text-6xl md:text-7xl leading-none">
              <span className="text-foreground">Poly</span>
              <span className="text-primary">Store</span>
            </div>
          </div>

          <div className="mt-8 space-y-5">
            <div className="nil-hero-title">
              {title}
            </div>
            <p className={`nil-hero-description ${!hasPoints ? "mx-auto" : ""}`}>
              {description}
            </p>
          </div>

          {actions && (
            <div className={`mt-8 flex flex-col gap-3 sm:flex-row ${!hasPoints ? "justify-center" : ""}`}>
              {actions}
            </div>
          )}
        </div>

        {hasPoints && (
          <motion.div
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.32, delay: 0.03, ease: [0.22, 1, 0.36, 1] }}
            className="grid gap-4"
          >
            {points.map((point, index) => {
              const Icon = point.icon;
              return (
                <motion.div
                  key={point.label}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.24, delay: 0.05 + index * 0.04 }}
                  className="nil-hero-point"
                >
                  <div className="flex items-start gap-4">
                    <div className="nil-hero-point-icon shrink-0">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="nil-hero-point-label">
                        {point.label}
                      </div>
                      <p className="nil-hero-point-body">{point.body}</p>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </div>
    </motion.section>
  );
}
