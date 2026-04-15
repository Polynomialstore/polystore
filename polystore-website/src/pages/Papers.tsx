import { useState, useEffect, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { marked } from 'marked';

interface MarkdownPageProps {
  filePath: string;
  title: string;
  description?: string;
  eyebrow?: string;
}

interface DocumentHeading {
  depth: number;
  id: string;
  text: string;
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[`*_~]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/&[a-z]+;/gi, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';

const createSlugger = () => {
  const counts = new Map<string, number>();
  return (value: string) => {
    const base = slugify(value);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  };
};

const stripDocumentHeader = (markdown: string, title: string, eyebrow: string) => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  while (lines[0]?.trim() === '') lines.shift();

  if (/^#\s+/.test(lines[0] ?? '')) {
    const heading = (lines[0] ?? '').replace(/^#\s+/, '').trim().toLowerCase();
    if (!title || heading === title.trim().toLowerCase()) {
      lines.shift();
    }
  }

  while (lines[0]?.trim() === '') lines.shift();

  const eyebrowMatch = lines[0]?.match(/^\*(.+)\*\s*$/);
  if (eyebrowMatch && eyebrowMatch[1].trim().toLowerCase() === eyebrow.trim().toLowerCase()) {
    lines.shift();
  }

  while (lines[0]?.trim() === '') lines.shift();

  return lines.join('\n');
};

const extractHeadings = (markdown: string): DocumentHeading[] => {
  const slug = createSlugger();
  const headings: DocumentHeading[] = [];

  for (const line of markdown.split('\n')) {
    const match = /^(#{2,4})\s+(.+)$/.exec(line.trim());
    if (!match) continue;

    const text = match[2]
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim();

    if (!text) continue;

    headings.push({
      depth: match[1].length,
      id: slug(text),
      text,
    });
  }

  return headings;
};

const annotateHeadingIds = (html: string, headings: DocumentHeading[]) => {
  let index = 0;
  return html.replace(/<h([2-4])>(.*?)<\/h[2-4]>/g, (match, level, innerHtml) => {
    const heading = headings[index];
    if (!heading || String(heading.depth) !== level) return match;
    index += 1;
    return `<h${level} id="${heading.id}">${innerHtml}</h${level}>`;
  });
};

const MarkdownPage = ({ filePath, title, description, eyebrow = 'PolyStore Research' }: MarkdownPageProps) => {
  const [content, setContent] = useState('');
  const [headings, setHeadings] = useState<DocumentHeading[]>([]);
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
        const bodyMarkdown = stripDocumentHeader(text, title, eyebrow);
        const nextHeadings = extractHeadings(bodyMarkdown);

        setHeadings(nextHeadings);
        setContent(annotateHeadingIds(marked.parse(bodyMarkdown), nextHeadings));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchMarkdown();
  }, [eyebrow, filePath, title]);

  const scrollToHeading = (id: string) => {
    const element = document.getElementById(id);
    if (!element) return;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
  };

  const renderBody = (body: ReactNode) => (
    <div className="pt-24 pb-20 px-4">
      <div className="mx-auto max-w-7xl">
        <div className="border-b border-border/80 pb-8 md:pb-10">
          <div className="max-w-4xl space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">{eyebrow}</p>
            <h1 className="text-4xl md:text-5xl font-bold text-foreground leading-tight">{title}</h1>
            {description ? (
              <p className="max-w-3xl text-lg text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-8 grid gap-10 xl:grid-cols-[minmax(0,46rem)_15rem] xl:items-start">
          <motion.article
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="min-w-0"
          >
            <div className="max-w-3xl bg-background/80 pb-2 backdrop-blur-sm">
              {body}
            </div>
          </motion.article>

          {headings.length > 0 ? (
            <aside className="hidden xl:block xl:sticky xl:top-24">
              <div className="border-l border-border/80 pl-5">
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.24em] text-muted-foreground">
                  On This Page
                </p>
                <nav aria-label="Document sections">
                  <ul className="space-y-1.5">
                    {headings.map((heading) => (
                      <li key={heading.id}>
                        <button
                          type="button"
                          onClick={() => scrollToHeading(heading.id)}
                          className={`block text-left text-sm leading-6 text-muted-foreground transition-colors hover:text-foreground ${
                            heading.depth === 3 ? 'pl-4' : heading.depth >= 4 ? 'pl-8' : ''
                          }`}
                        >
                          {heading.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
              </div>
            </aside>
          ) : null}
        </div>
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
      <div className="border border-destructive/30 bg-destructive/10 p-4 text-destructive">
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
    title="PolyStore Whitepaper"
    description="A technical draft of the PolyStore whitepaper."
    eyebrow="Research Draft"
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
