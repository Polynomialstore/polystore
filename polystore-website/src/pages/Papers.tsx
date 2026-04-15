import { useState, useEffect, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { marked } from 'marked';

interface MarkdownPageProps {
  filePath: string;
  title: string;
  description?: string;
  eyebrow?: string;
}

const MarkdownPage = ({ filePath, title, description, eyebrow = 'PolyStore Research' }: MarkdownPageProps) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMarkdown = async () => {
      try {
        const response = await fetch(filePath);
        if (!response.ok) {
          throw new Error(`Failed to fetch ${filePath}: ${response.statusText}`);
        }
        const text = await response.text();
        setContent(marked.parse(text));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchMarkdown();
  }, [filePath]);

  const renderBody = (body: ReactNode) => (
    <div className="pt-24 pb-16 px-4">
      <div className="container mx-auto max-w-5xl space-y-8">
        <div className="relative overflow-hidden rounded-none border border-border bg-card shadow-sm">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-background to-background opacity-90" />
          <div className="relative p-8 md:p-10 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">{eyebrow}</p>
            <h1 className="text-4xl md:text-5xl font-bold text-foreground leading-tight">{title}</h1>
            {description ? (
              <p className="text-lg text-muted-foreground max-w-3xl">{description}</p>
            ) : null}
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="rounded-none border border-border bg-card/70 backdrop-blur-sm shadow-sm p-6 md:p-10"
        >
          {body}
        </motion.div>
      </div>
    </div>
  );

  if (loading) {
    return renderBody(
      <div className="space-y-4">
        <div className="h-6 w-32 bg-muted animate-pulse" />
        <div className="h-4 w-3/4 bg-muted animate-pulse" />
        <div className="h-4 w-5/6 bg-muted animate-pulse" />
        <div className="h-4 w-2/3 bg-muted animate-pulse" />
      </div>
    );
  }

  if (error) {
    return renderBody(
      <div className="rounded-none border border-destructive/30 bg-destructive/10 p-4 text-destructive">
        <p className="font-semibold">Unable to load this document.</p>
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  return renderBody(
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
};

export const Litepaper = () => (
  <MarkdownPage
    filePath="/litepaper.md"
    title="PolyStore Litepaper"
    description="A shorter, example-driven draft of the PolyStore litepaper."
    eyebrow="Research Draft"
  />
);

export const Whitepaper = () => (
  <MarkdownPage
    filePath="/whitepaper.md"
    title="PolyStore Whitepaper Outline"
    description="Outline draft for a technical rewrite of the PolyStore whitepaper."
    eyebrow="Outline Draft"
  />
);

export const Spec = () => (
  <MarkdownPage
    filePath="/spec.md"
    title="PolyStore Spec"
    description="The canonical protocol specification for PolyStore's storage, retrieval, and verification model."
    eyebrow="Protocol Specification"
  />
);
