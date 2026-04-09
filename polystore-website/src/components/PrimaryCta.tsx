import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

type PrimaryCtaSize = "sm" | "md" | "lg";

function primaryCtaClassName({
  className = "",
  fullWidth = false,
  size = "lg",
}: {
  className?: string;
  fullWidth?: boolean;
  size?: PrimaryCtaSize;
}) {
  const sizeClass =
    size === "sm" ? "px-4 py-2" : size === "md" ? "px-4 py-3" : "px-6 py-3";

  return [
    "inline-flex items-center justify-center gap-3 rounded-none border border-primary bg-primary",
    "text-primary-foreground cta-shadow",
    "text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data",
    "transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]",
    sizeClass,
    fullWidth ? "w-full" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export function PrimaryCtaLink({
  to,
  children,
  className,
  fullWidth,
  size,
  leftIcon,
  withArrow = true,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  fullWidth?: boolean;
  size?: PrimaryCtaSize;
  leftIcon?: ReactNode;
  withArrow?: boolean;
}) {
  return (
    <Link to={to} className={primaryCtaClassName({ className, fullWidth, size })}>
      {leftIcon}
      {children}
      {withArrow ? <ArrowRight className="w-4 h-4" /> : null}
    </Link>
  );
}

export function PrimaryCtaAnchor({
  href,
  children,
  className,
  fullWidth,
  size,
  leftIcon,
  withArrow = false,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  fullWidth?: boolean;
  size?: PrimaryCtaSize;
  leftIcon?: ReactNode;
  withArrow?: boolean;
}) {
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href.startsWith("#")) return
    event.preventDefault()
    if (typeof document === "undefined") return
    const target = document.getElementById(href.slice(1))
    if (!target) return
    target.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <a href={href} onClick={handleClick} className={primaryCtaClassName({ className, fullWidth, size })}>
      {leftIcon}
      {children}
      {withArrow ? <ArrowRight className="w-4 h-4" /> : null}
    </a>
  );
}

export function PrimaryCtaButton({
  children,
  className,
  fullWidth,
  size,
  leftIcon,
  withArrow = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  className?: string;
  fullWidth?: boolean;
  size?: PrimaryCtaSize;
  leftIcon?: ReactNode;
  withArrow?: boolean;
}) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      className={[
        primaryCtaClassName({ className, fullWidth, size }),
        "disabled:opacity-60",
      ].join(" ")}
    >
      {leftIcon}
      {children}
      {withArrow ? <ArrowRight className="w-4 h-4" /> : null}
    </button>
  );
}
