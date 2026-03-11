import type { ReactNode } from "react";

type TrackCardProps = {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function TrackCard({ icon, title, description, action, className = "" }: TrackCardProps) {
  return (
    <div
      className={`relative glass-panel industrial-border border border-border p-8 transition-colors ${className}`.trim()}
    >
      <div className="relative mb-4 flex h-14 w-14 items-center justify-center glass-panel industrial-border">{icon}</div>
      <h3 className="relative mb-3 text-xl font-bold text-card-foreground">{title}</h3>
      <div className="relative leading-relaxed text-muted-foreground">{description}</div>
      {action ? <div className="relative mt-6">{action}</div> : null}
    </div>
  );
}
