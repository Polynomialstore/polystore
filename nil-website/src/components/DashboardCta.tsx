import { Rocket } from "lucide-react";
import { Link } from "react-router-dom";

export function DashboardCta({
  className = "",
  label = "Dashboard",
  to = "/dashboard",
  onClick,
}: {
  className?: string;
  label?: string;
  to?: string;
  onClick?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={[
        "items-center gap-3 px-6 py-3 bg-primary text-primary-foreground text-[10px] font-bold uppercase tracking-[0.2em]",
        "shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)]",
        "hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] transition-all",
        className,
      ].join(" ")}
    >
      <Rocket className="w-4 h-4 fill-current" />
      {label}
    </Link>
  );
}
