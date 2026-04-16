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

const stripDocumentHeader = (markdown: string, eyebrow: string) => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  while (lines[0]?.trim() === '') lines.shift();

  if (/^#\s+/.test(lines[0] ?? '')) {
    lines.shift();
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

const ALLOWED_MARKDOWN_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);

const ALLOWED_MARKDOWN_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  h1: new Set(['id']),
  h2: new Set(['id']),
  h3: new Set(['id']),
  h4: new Set(['id']),
  h5: new Set(['id']),
  h6: new Set(['id']),
  img: new Set(['alt', 'src', 'title']),
};

const SAFE_MARKDOWN_URL = /^(https?:|mailto:|\/|#)/i;

const sanitizeRenderedHtml = (html: string) => {
  if (typeof document === 'undefined') return html;

  const template = document.createElement('template');
  template.innerHTML = html;

  const sanitizeNode = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as HTMLElement;
        const tag = element.tagName.toLowerCase();

        if (!ALLOWED_MARKDOWN_TAGS.has(tag)) {
          element.replaceWith(document.createTextNode(element.textContent ?? ''));
          continue;
        }

        const allowedAttrs = ALLOWED_MARKDOWN_ATTRS[tag] ?? new Set<string>();
        for (const attr of Array.from(element.attributes)) {
          const name = attr.name.toLowerCase();
          const value = attr.value.trim();

          if (name.startsWith('on') || !allowedAttrs.has(name)) {
            element.removeAttribute(attr.name);
            continue;
          }

          if ((name === 'href' || name === 'src') && value && !SAFE_MARKDOWN_URL.test(value)) {
            element.removeAttribute(attr.name);
          }
        }
      }

      sanitizeNode(child);
    }
  };

  sanitizeNode(template.content);
  return template.innerHTML;
};

const MarkdownPage = ({ filePath, title, description, eyebrow = 'PolyStore Research' }: MarkdownPageProps) => {
  const [content, setContent] = useState('');
  const [headings, setHeadings] = useState<DocumentHeading[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMarkdown = async () => {
      setLoading(true);
      setError(null);
      setContent('');
      setHeadings([]);

      try {
        const response = await fetch(filePath);
        if (!response.ok) {
          throw new Error(`Failed to fetch ${filePath}: ${response.statusText}`);
        }
        const text = await response.text();
        const bodyMarkdown = stripDocumentHeader(text, eyebrow);
        const nextHeadings = extractHeadings(bodyMarkdown);

        const renderedHtml = annotateHeadingIds(marked.parse(bodyMarkdown), nextHeadings);

        setHeadings(nextHeadings);
        setContent(sanitizeRenderedHtml(renderedHtml));
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
    <div className="px-4 pb-20 pt-20 md:pt-24">
      <div className="container mx-auto max-w-6xl">
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_18rem] xl:gap-8">
          <motion.header
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="min-w-0"
          >
            <div className="glass-panel industrial-border bg-background/90 px-5 py-6 md:px-8 md:py-8 lg:px-10 lg:py-10">
              <div className="space-y-3 md:space-y-4">
                <p className="font-mono-data text-[11px] font-bold uppercase tracking-[0.24em] text-primary">{eyebrow}</p>
                <h1 className="max-w-3xl text-4xl font-extrabold leading-[1.04] tracking-tight text-foreground sm:text-5xl lg:text-[3.65rem]">
                  {title}
                </h1>
                {description ? (
                  <p className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">{description}</p>
                ) : null}
              </div>
            </div>
          </motion.header>

          <div className="hidden xl:block" aria-hidden="true" />
        </div>

        <div className="mt-8 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_18rem] xl:gap-8">
          <motion.article
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="min-w-0"
          >
            <div className="glass-panel industrial-border bg-background/90 px-5 py-6 md:px-8 md:py-8 lg:px-10 lg:py-10">
              {body}
            </div>
          </motion.article>

          {headings.length > 0 ? (
            <aside className="hidden xl:block xl:sticky xl:top-24">
              <div className="glass-panel industrial-border bg-background/90 p-5">
                <p className="font-mono-data text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  On This Page
                </p>
                <nav aria-label="Document sections" className="mt-4 max-h-[calc(100vh-8rem)] overflow-auto pr-1">
                  <ul className="space-y-1.5">
                    {headings.map((heading) => (
                      <li key={heading.id}>
                        <button
                          type="button"
                          onClick={() => scrollToHeading(heading.id)}
                          className={`block w-full border-l border-transparent py-1 pr-2 text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground ${
                            heading.depth === 3
                              ? 'pl-6'
                              : heading.depth >= 4
                                ? 'pl-9 text-[12px] leading-[1.35rem]'
                                : 'pl-3'
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
