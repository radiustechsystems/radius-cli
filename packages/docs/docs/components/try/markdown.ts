import type { RootContent } from 'mdast';

/**
 * Markdown for the interactive components' `toMarkdown` hooks: agents cannot click, so each
 * component becomes a sentence and the code that does the same thing.
 */
export function codeMarkdown(intro: string, lang: string, code: string): RootContent[] {
  return [
    { type: 'paragraph', children: [{ type: 'text', value: intro }] },
    { type: 'code', lang, value: code },
  ];
}
