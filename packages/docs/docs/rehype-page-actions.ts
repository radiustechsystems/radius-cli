/**
 * rehype-page-actions
 *
 * Inserts `<PageActions markdownHref="…" />` ("View as Markdown", "Copy for
 * LLM") after the title of every page. Vocs 2 has no layout slot below the
 * title, and rehype plugins run only for the rendered site, so the agent
 * Markdown is unaffected.
 *
 * Registered via `markdown.rehypePlugins` in vocs.config.ts.
 */

import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'unified';

const DOCS_DIR = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(DOCS_DIR, 'pages');
const COMPONENT_PATH = join(DOCS_DIR, 'components', 'PageActions.tsx');
const COMPONENT_NAME = 'PageActions';

/** Pages that get no actions: they have no Markdown twin. */
const EXCLUDED_PAGES = new Set(['404']);

type Node = { type: string; tagName?: string; children?: Node[]; [key: string]: unknown };

/** `build/index.mdx` → `/build.md`; `index.mdx` → `/index.md`. */
function markdownHref(pagePath: string): string | null {
  const route = pagePath.replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '');
  if (EXCLUDED_PAGES.has(route)) return null;
  return `/${route || 'index'}.md`;
}

/** `import { PageActions } from '<relative path>'` as an MDX ESM node. */
function importNode(fromFile: string): Node {
  let source = relative(dirname(fromFile), COMPONENT_PATH).replace(/\.tsx$/, '');
  if (!source.startsWith('.')) source = `./${source}`;
  const identifier = { type: 'Identifier', name: COMPONENT_NAME };
  return {
    type: 'mdxjsEsm',
    value: `import { ${COMPONENT_NAME} } from '${source}'`,
    data: {
      estree: {
        type: 'Program',
        sourceType: 'module',
        body: [
          {
            type: 'ImportDeclaration',
            specifiers: [{ type: 'ImportSpecifier', imported: identifier, local: identifier }],
            source: { type: 'Literal', value: source, raw: `'${source}'` },
          },
        ],
      },
    },
  };
}

function actionsNode(href: string): Node {
  return {
    type: 'mdxJsxFlowElement',
    name: COMPONENT_NAME,
    attributes: [{ type: 'mdxJsxAttribute', name: 'markdownHref', value: href }],
    children: [],
  };
}

export const rehypePageActions: Plugin<[], Node> = () => (tree, file) => {
  const path = file.path;
  if (!path || !path.startsWith(PAGES_DIR)) return;
  const href = markdownHref(relative(PAGES_DIR, path));
  if (!href) return;

  // `# Title [Subtitle]` renders as <hgroup>; a title without a subtitle as <h1>.
  const children = tree.children ?? [];
  const title = children.findIndex((node) => node.tagName === 'hgroup' || node.tagName === 'h1');
  if (title === -1) return;

  children.splice(title + 1, 0, actionsNode(href));
  children.unshift(importNode(path));
};
