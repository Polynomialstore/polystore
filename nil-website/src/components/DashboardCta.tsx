import { Rocket } from "lucide-react";
import { Link } from "react-router-dom";

export function DashboardCta({
  className = "",
  label = "Dashboard",
  to = "/dashboard",
  onClick,
  compact = false,
}: {
  className?: string;
  label?: string;
  to?: string;
  onClick?: () => void;
  compact?: boolean;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={[
        "items-center bg-primary text-primary-foreground font-bold uppercase tracking-[0.2em]",
        compact ? "gap-2 px-4 py-2.5 text-[9px]" : "gap-3 px-6 py-3 text-[10px]",
        "cta-shadow",
        "hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] transition-all",
        className,
      ].join(" ")}
    >
      <Rocket className="w-4 h-4 fill-current" />
      {label}
    </Link>
  );
}
