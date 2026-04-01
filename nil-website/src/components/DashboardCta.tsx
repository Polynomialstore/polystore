import { Rocket } from "lucide-react";
import { Link } from "react-router-dom";

export function DashboardCta({
  className = "",
  label = "Dashboard",
  compactLabel,
  to = "/dashboard",
  onClick,
  compact = false,
  responsive = false,
}: {
  className?: string;
  label?: string;
  compactLabel?: string;
  to?: string;
  onClick?: () => void;
  compact?: boolean;
  responsive?: boolean;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={[
        "items-center bg-primary text-primary-foreground font-bold uppercase tracking-[0.2em]",
        responsive
          ? "gap-2 px-4 py-2.5 text-[9px] 2xl:gap-3 2xl:px-6 2xl:py-3 2xl:text-[10px]"
          : compact
            ? "gap-2 px-4 py-2.5 text-[9px]"
            : "gap-3 px-6 py-3 text-[10px]",
        "cta-shadow",
        "hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] transition-all",
        className,
      ].join(" ")}
    >
      <Rocket className="w-4 h-4 fill-current" />
      {responsive && compactLabel ? (
        <>
          <span className="2xl:hidden">{compactLabel}</span>
          <span className="hidden 2xl:inline">{label}</span>
        </>
      ) : (
        label
      )}
    </Link>
  );
}
