import { useState } from "react";
import type { ReactNode } from "react";
import { Copy, ExternalLink } from "lucide-react";

type PromptLink = {
  href: string;
  label: string;
};

type PromptPanelProps = {
  badge: string;
  title: string;
  description: ReactNode;
  prompt: string;
  copyLabel: string;
  links?: PromptLink[];
};

export function PromptPanel({ badge, title, description, prompt, copyLabel, links = [] }: PromptPanelProps) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const copyPrompt = async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        setCopyStatus("Clipboard not available.");
        return;
      }
      await navigator.clipboard.writeText(prompt);
      setCopyStatus(`${copyLabel} copied.`);
      window.setTimeout(() => setCopyStatus(null), 2000);
    } catch {
      setCopyStatus(`Could not copy ${copyLabel}.`);
    }
  };

  return (
    <div className="glass-panel industrial-border border border-border p-6">
      <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">{badge}</div>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold text-foreground">{title}</h3>
          <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</div>
        </div>
        <button
          type="button"
          onClick={copyPrompt}
          className="inline-flex flex-shrink-0 items-center gap-2 rounded-none border border-border bg-background px-3 py-2 text-xs font-semibold uppercase tracking-wider text-foreground transition-colors hover:bg-secondary"
        >
          <Copy className="h-4 w-4" />
          {copyLabel}
        </button>
      </div>

      <pre className="mt-5 overflow-x-auto rounded-none border border-border bg-background/80 p-4 text-xs leading-relaxed text-foreground">
        <code>{prompt}</code>
      </pre>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary transition-colors hover:text-foreground"
          >
            {link.label}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ))}
        {copyStatus ? <span className="text-xs font-semibold text-accent">{copyStatus}</span> : null}
      </div>
    </div>
  );
}
