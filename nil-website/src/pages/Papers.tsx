import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

interface MarkdownPageProps {
  filePath: string;
  title: string;
}

const MarkdownPage = ({ filePath, title }: MarkdownPageProps) => {
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
        setContent(text);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchMarkdown();
  }, [filePath]);

  if (loading) return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
        <h1 className="text-4xl font-bold mb-4 text-foreground">{title}</h1>
        <p className="text-muted-foreground">Loading...</p>
    </div>
  );

  if (error) return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
        <h1 className="text-4xl font-bold mb-4 text-foreground">{title}</h1>
        <p className="text-red-500">Error: {error}</p>
    </div>
  );

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <h1 className="text-4xl font-bold mb-4 text-foreground">{title}</h1>
        <div className="prose dark:prose-invert max-w-none text-muted-foreground" dangerouslySetInnerHTML={{ __html: content }} />
      </motion.div>
    </div>
  );
};

export const Litepaper = () => <MarkdownPage filePath="/litepaper.md" title="NilStore Litepaper" />;
export const Whitepaper = () => <MarkdownPage filePath="/whitepaper.md" title="NilStore Whitepaper" />;
