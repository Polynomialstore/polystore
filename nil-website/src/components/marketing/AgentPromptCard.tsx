import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, X } from "lucide-react";
import { PrimaryCtaButton } from "../PrimaryCta";

type PromptLink = {
  href: string;
  label: string;
};

export function AgentPromptCard({
  badge,
  title,
  description,
  prompt,
  copyLabel = "Copy Agent Prompt",
  links = [],
}: {
  badge: string;
  title: string;
  description: string;
  prompt: string;
  copyLabel?: string;
  links?: PromptLink[];
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [portalReady, setPortalReady] = useState(false);

  useEffect(() => {
    if (!previewOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [previewOpen]);

  useEffect(() => {
    // Avoid attempting to portal during SSR or before the browser has a document.
    setPortalReady(true);
  }, []);

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

  const promptLabel = "Agent prompt";

  return (
    <div className="glass-panel industrial-border p-6">
      <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">{badge}</div>

      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-2xl font-bold text-foreground">{title}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="inline-flex items-center justify-center gap-2 rounded-none border border-accent bg-accent px-4 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-accent-foreground cta-shadow transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
          >
            <ExternalLink className="h-4 w-4" />
            Preview Prompt
          </button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
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

      {previewOpen ? (
        portalReady
          ? createPortal(
              <div
                className="fixed inset-0 z-[200]"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setPreviewOpen(false);
                }}
              >
                <div className="absolute inset-0 bg-black/45" />
                <div className="absolute inset-0 overflow-y-auto">
                  <div className="flex min-h-full items-center justify-center px-4 py-10">
                    <div role="dialog" aria-modal="true" className="w-full max-w-4xl">
                      <div className="industrial-border border border-border bg-card p-6 shadow-lg">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
                              {badge}
                            </div>
                            <h4 className="mt-2 text-xl font-bold text-foreground">{promptLabel}</h4>
                          </div>
                          <div className="flex items-center gap-2">
                            <PrimaryCtaButton
                              size="sm"
                              withArrow={false}
                              leftIcon={<Copy className="h-4 w-4" />}
                              onClick={copyPrompt}
                            >
                              Copy
                            </PrimaryCtaButton>
                            <button
                              type="button"
                              onClick={() => setPreviewOpen(false)}
                              className="inline-flex items-center justify-center rounded-none border border-border bg-background p-2 text-foreground transition-colors hover:bg-secondary"
                              aria-label="Close"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        <pre className="mt-5 max-h-[65vh] overflow-auto rounded-none border border-border bg-background p-4 text-xs leading-relaxed text-foreground">
                          <code>{prompt}</code>
                        </pre>
                      </div>
                    </div>
                  </div>
                </div>
              </div>,
              document.body
            )
          : null
      ) : null}
    </div>
  );
}
