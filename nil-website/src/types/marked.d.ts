declare module 'marked' {
  export function parse(markdown: string): string;
  export const marked: ((markdown: string) => string) & { parse: typeof parse };
  export default marked;
}
